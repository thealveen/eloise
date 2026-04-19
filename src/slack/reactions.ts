// Implements spec §3 Slack Adapter.
/**
 * Best-effort reaction add/remove helpers.
 *
 * Reactions are progress UX, not load-bearing state. If Slack rejects a call
 * (`already_reacted`, `no_reaction`, `message_not_found`, transient 5xx),
 * we log and move on — we do NOT abort the turn. The user reply is more
 * important than the emoji.
 *
 * The `client` parameter is typed as the minimal surface we use, so tests
 * can pass a mock without depending on Bolt's WebClient type.
 */

import type { Logger } from "../types/index.js";

export type ReactionsClient = {
  reactions: {
    add(args: { channel: string; timestamp: string; name: string }): Promise<unknown>;
    remove(args: { channel: string; timestamp: string; name: string }): Promise<unknown>;
  };
};

export async function addReaction(
  client: ReactionsClient,
  channel: string,
  timestamp: string,
  name: string,
  logger: Logger,
): Promise<void> {
  try {
    await client.reactions.add({ channel, timestamp, name });
  } catch (err) {
    // Common: `already_reacted` if the same event was redelivered. Harmless.
    logger.debug("reaction.add failed", {
      reaction: name,
      error_message: errMessage(err),
    });
  }
}

export async function removeReaction(
  client: ReactionsClient,
  channel: string,
  timestamp: string,
  name: string,
  logger: Logger,
): Promise<void> {
  try {
    await client.reactions.remove({ channel, timestamp, name });
  } catch (err) {
    // Common: `no_reaction` if it never got added (e.g. earlier add failed).
    logger.debug("reaction.remove failed", {
      reaction: name,
      error_message: errMessage(err),
    });
  }
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
