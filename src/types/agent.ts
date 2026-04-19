import type { SessionHandle } from "./session.js";

export type AgentRequest = {
  session: SessionHandle;
  user_text: string;
  meta: {
    user_id: string;
    slack_key: string;
  };
};

export type AgentResponse = {
  text: string;
  duration_ms: number;
  tool_calls: number;
};

export type AgentError =
  | { kind: "timeout" }
  | { kind: "rate_limit" }
  | { kind: "api_error"; message: string }
  | { kind: "mcp_error"; message: string }
  | { kind: "unknown"; message: string };

export type AgentResult =
  | { ok: true; response: AgentResponse }
  | { ok: false; error: AgentError };

export interface AgentRunner {
  run(request: AgentRequest): Promise<AgentResult>;
}
