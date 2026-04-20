// Implements spec §10.3 Frozen Contracts.
import type { NormalizedEvent } from "./events.js";

export type SessionHandle = {
  session_id: string;
  is_new: boolean;
  slack_key: string;
};

export interface SessionResolver {
  resolve(event: NormalizedEvent): Promise<SessionHandle>;
  exists(channel_id: string, thread_ts: string): Promise<boolean>;
  // After a successful first turn, rewrite the stored session_id to the id
  // the Agent SDK actually minted — that's the id we must pass as `resume`
  // on the next turn. Before this, the SQLite row holds a client-side UUID
  // the SDK has never seen, which would fail as a resume target.
  update(slack_key: string, session_id: string): Promise<void>;
  // Drop a row. Used when a brand-new session's first turn failed: the row
  // holds a UUID that was never accepted by the SDK, so leaving it would
  // make every retry error with "no conversation found".
  drop(slack_key: string): Promise<void>;
}
