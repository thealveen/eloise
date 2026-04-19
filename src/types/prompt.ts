export type SystemPrompt = string;

export interface PromptLoader {
  load(): SystemPrompt;
}
