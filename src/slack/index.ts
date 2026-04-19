import type { AgentRunner, Logger, SessionResolver } from "../types/index.js";

export function createSlackAdapter(deps: {
  botToken: string;
  appToken: string;
  sessionResolver: SessionResolver;
  agentRunner: AgentRunner;
  logger: Logger;
}): { start(): Promise<void>; stop(): Promise<void> } {
  void deps;
  return {
    async start() {
      throw new Error("not implemented: slack");
    },
    async stop() {
      throw new Error("not implemented: slack");
    },
  };
}
