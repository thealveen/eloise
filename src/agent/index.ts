// Implements spec §5 Agent Runner.
import type {
  AgentError,
  AgentRequest,
  AgentResult,
  AgentRunner,
  Logger,
  McpConfig,
  SystemPrompt,
} from "../types/index.js";
import { invokeAgent } from "./invoke.js";
import { TimeoutError, withTimeout } from "./timeout.js";

export function createAgentRunner(deps: {
  systemPrompt: SystemPrompt;
  mcpConfig: McpConfig;
  timeoutMs: number;
  cwd: string;
  anthropicApiKey: string;
  logger: Logger;
}): AgentRunner {
  // The SDK reads ANTHROPIC_API_KEY from env. Set it once at factory time so
  // callers don't have to populate process.env themselves. We never log the
  // value — see sanitize() below.
  if (!process.env.ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = deps.anthropicApiKey;
  }

  const sanitize = makeSanitizer(deps);

  return {
    async run(request: AgentRequest): Promise<AgentResult> {
      const start = Date.now();
      try {
        const out = await withTimeout(deps.timeoutMs, (signal) =>
          invokeAgent(
            {
              systemPrompt: deps.systemPrompt,
              mcpConfig: deps.mcpConfig,
              cwd: deps.cwd,
            },
            request,
            signal,
          ),
        );
        const duration_ms = Date.now() - start;

        if (
          out.sdk_session_id &&
          out.sdk_session_id !== request.session.session_id
        ) {
          deps.logger.warn("sdk session id drift", {
            session_id: request.session.session_id,
            slack_key: request.meta.slack_key,
            sdk_session_id: out.sdk_session_id,
          });
        }

        deps.logger.info("agent ok", {
          status: "ok",
          duration_ms,
          tool_calls: out.tool_calls,
          session_id: request.session.session_id,
          slack_key: request.meta.slack_key,
          user_id: request.meta.user_id,
        });

        return {
          ok: true,
          response: {
            text: out.text,
            duration_ms,
            tool_calls: out.tool_calls,
          },
        };
      } catch (err) {
        const duration_ms = Date.now() - start;
        const error = mapError(err, sanitize);
        deps.logger.error("agent failed", {
          status: error.kind === "timeout" ? "timeout" : "error",
          duration_ms,
          session_id: request.session.session_id,
          slack_key: request.meta.slack_key,
          user_id: request.meta.user_id,
          error_kind: error.kind,
          error_message: errorMessage(error),
        });
        return { ok: false, error };
      }
    },
  };
}

function errorMessage(e: AgentError): string | undefined {
  if (e.kind === "timeout" || e.kind === "rate_limit") return undefined;
  return e.message;
}

function mapError(
  err: unknown,
  sanitize: (s: string) => string,
): AgentError {
  if (err instanceof TimeoutError) return { kind: "timeout" };

  if (isRecord(err) && typeof err.name === "string" && err.name === "AbortError") {
    return { kind: "timeout" };
  }

  const status =
    isRecord(err) && typeof err.status === "number" ? err.status : undefined;
  const rawMessage =
    isRecord(err) && typeof err.message === "string"
      ? err.message
      : String(err);
  const message = sanitize(rawMessage);

  if (status === 429 || /rate[_ -]?limit/i.test(rawMessage)) {
    return { kind: "rate_limit" };
  }

  if (looksLikeMcpError(err, rawMessage)) {
    return { kind: "mcp_error", message };
  }

  if (looksLikeApiError(err, status)) {
    return { kind: "api_error", message };
  }

  return { kind: "unknown", message };
}

function looksLikeMcpError(err: unknown, message: string): boolean {
  if (isRecord(err) && typeof err.name === "string" && /mcp/i.test(err.name)) {
    return true;
  }
  return /\bmcp\b/i.test(message);
}

function looksLikeApiError(err: unknown, status: number | undefined): boolean {
  if (typeof status === "number" && status >= 400) return true;
  if (isRecord(err)) {
    const name = typeof err.name === "string" ? err.name : "";
    if (/anthropic|api/i.test(name)) return true;
    const errType = isRecord(err.error) ? err.error.type : undefined;
    if (typeof errType === "string" && /api_error|error/i.test(errType)) {
      return true;
    }
  }
  return false;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function makeSanitizer(deps: {
  anthropicApiKey: string;
  mcpConfig: McpConfig;
}): (s: string) => string {
  const literals: string[] = [];
  if (deps.anthropicApiKey) literals.push(deps.anthropicApiKey);
  for (const server of deps.mcpConfig.servers) {
    if (server.headers) {
      for (const v of Object.values(server.headers)) {
        if (typeof v === "string" && v.length > 0) {
          literals.push(v);
          const bearer = v.match(/^Bearer\s+(.+)$/i);
          if (bearer?.[1]) literals.push(bearer[1]);
        }
      }
    }
  }

  return (s: string): string => {
    let out = s;
    for (const lit of literals) {
      if (lit.length < 4) continue;
      out = out.split(lit).join("[redacted]");
    }
    out = out
      .replace(/sk-ant-[A-Za-z0-9_-]{10,}/g, "[redacted]")
      .replace(/xox[bapros]-[A-Za-z0-9-]+/g, "[redacted]")
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]");
    return out;
  };
}
