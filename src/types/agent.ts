// Implements spec §10.3 Frozen Contracts.
import type { SessionHandle } from "./session.js";

export type AgentProgressEvent = {
  tool_calls: number;
  last_tool?: string;
};

export type AgentRequest = {
  session: SessionHandle;
  user_text: string;
  meta: {
    user_id: string;
    slack_key: string;
  };
  onProgress?: (event: AgentProgressEvent) => void;
};

export type AgentResponse = {
  text: string;
  duration_ms: number;
  tool_calls: number;
  sdk_session_id?: string;
  sdk_subtype?: string;
  sdk_num_turns?: number;
};

export type AgentError =
  | { kind: "timeout" }
  | { kind: "rate_limit" }
  | { kind: "max_turns" }
  | { kind: "auth_error"; message: string }
  | { kind: "sdk_error"; message: string }
  | { kind: "api_error"; message: string }
  | { kind: "mcp_error"; message: string }
  | { kind: "unknown"; message: string };

export type AgentResult =
  | { ok: true; response: AgentResponse }
  | { ok: false; error: AgentError };

export interface AgentRunner {
  run(request: AgentRequest): Promise<AgentResult>;
}
