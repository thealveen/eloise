/**
 * Maps an `AgentError` to the user-facing message posted into the Slack
 * thread when a turn fails.
 *
 * The strings are dictated by the spec (K12, K13 in slack-bot-spec.md §2 and
 * the responsibility list in §3). The tagged-union dispatch is intentional:
 * the Slack Adapter MUST select on `error.kind`, not on a stringly-matched
 * `message`. Logs get the full message; users get one of three short strings.
 */

import type { AgentError } from "../types/index.js";

export function formatErrorMessage(error: AgentError): string {
  switch (error.kind) {
    case "timeout":
      return "Took too long, try again.";
    case "rate_limit":
      return "Rate limited, try again shortly.";
    case "api_error":
    case "mcp_error":
    case "unknown":
      return "Something went wrong.";
  }
}
