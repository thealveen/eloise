// Implements spec §10.3 Frozen Contracts.
export type NormalizedEvent = {
  source: "channel" | "dm";
  channel_id: string;
  thread_ts: string;
  message_ts: string;
  user_id: string;
  text: string;
};
