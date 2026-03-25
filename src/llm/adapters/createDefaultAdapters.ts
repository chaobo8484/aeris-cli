import { LLMAdapter } from './types.js';
import { ClaudeAdapter } from './ClaudeAdapter.js';
import { OpenRouterAdapter } from './OpenRouterAdapter.js';

export function createDefaultAdapters(): LLMAdapter[] {
  return [new ClaudeAdapter(), new OpenRouterAdapter()];
}
