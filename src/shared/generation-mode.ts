import type { ChatMode } from './types';

/** A new generation uses the mode selected when the renderer submits it. */
export function executionMode(storedMode: ChatMode, requestedMode?: ChatMode): ChatMode {
  return requestedMode ?? storedMode;
}
