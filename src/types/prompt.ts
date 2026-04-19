// Implements spec §10.3 Frozen Contracts.
export type SystemPrompt = string;

export interface PromptLoader {
  load(): SystemPrompt;
}
