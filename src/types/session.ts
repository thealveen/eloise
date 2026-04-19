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
}
