import assert from 'node:assert/strict';
import type { ChatMessage, StreamEvent } from '../../shared/types';
import type { LlmBackend, ToolCallingBackend, ToolMessage } from '../backends/types';
import { WebBrowserService } from '../web/web-tools';
import { WebChatService } from './web-chat';
import { chatMessagesWithSystemPrefix, chatSystemContext } from './capabilities';

export async function runWebChatRegression(): Promise<void> {
  let decisionCalls = 0; let finalStreamCalls = 0; let closed = false; let decisionReasoningMode: string | undefined; let finalMessages: ChatMessage[] = []; const routingRequests: ToolMessage[][] = [];
  const backend: ToolCallingBackend & LlmBackend = {
    async chatWithTools(_model, messages, _tools, _signal, _contextWindow, reasoningMode): Promise<ToolMessage> {
      routingRequests.push(messages.map((message) => ({ ...message }))); decisionCalls += 1; decisionReasoningMode = reasoningMode;
      return decisionCalls === 1
        ? { role: 'assistant', content: '', tool_calls: [{ id: 'search', type: 'function', function: { name: 'web_search', arguments: { query: 'structured audit' } } }] }
        : { role: 'assistant', content: 'NO_WEB', thinking: 'This internal decision must not become visible Thinking.' };
    },
    async *streamChat(_model, messages): AsyncIterable<StreamEvent> {
      finalStreamCalls += 1; finalMessages = messages;
      yield { type: 'thinking', content: 'Live final reasoning.' };
      yield { type: 'token', content: 'Live final answer.' };
      yield { type: 'done', finishReason: 'stop' };
    },
    async getModels() { return []; },
    async getStatus() { return { available: true }; },
  };
  const web = { openSession: async () => ({ execute: async () => '{"result":"source"}', close: async () => { closed = true; } }) } as unknown as WebBrowserService;
  const history: ChatMessage[] = [
    { id: 'audit', conversationId: 'chat', role: 'user', content: 'Prepare a structured audit.', createdAt: new Date().toISOString() },
    // Continuation instructions from older conversations may be present late in history.
    { id: 'continuation', conversationId: 'chat', role: 'system', content: 'Continue the prior answer.', createdAt: new Date().toISOString() },
  ];
  const direct = chatMessagesWithSystemPrefix(history, [chatSystemContext({ webAvailable: false }, 'fast')], 'chat', 'direct-prefix');
  assert.deepEqual(direct.map((message) => message.role), ['system', 'user'], 'Direct Chat did not move a persisted late system instruction into the prefix');
  const languageRule = 'Если пользователь явно общается на одном языке';
  assert.equal((direct[0]?.content.match(new RegExp(languageRule, 'g')) ?? []).length, 1, 'Fast Chat must receive the language-consistency rule exactly once');
  assert.match(direct[0]?.content ?? '', /цитаты или исходного текста, кода, идентификаторов, имён, URL/, 'Fast Chat language rule must preserve multilingual quotations and technical text');
  const events: StreamEvent[] = [];
  for await (const event of new WebChatService(backend, web).stream('qwen3.8:27b-q4_K_M', history, new AbortController().signal, 65_536, 'deep')) events.push(event);
  assert.equal(decisionCalls, 2, 'Web Auto did not continue after the web tool result');
  assert.equal(decisionReasoningMode, 'fast', 'Web Auto did not keep its internal routing decision lightweight');
  assert.equal(finalStreamCalls, 1, 'Web Auto did not use the backend final stream');
  assert.equal(closed, true, 'Web session was not closed after streamed completion');
  assert.equal((finalMessages[0]?.content.match(new RegExp(languageRule, 'g')) ?? []).length, 1, 'Deep Chat must receive the language-consistency rule exactly once');
  assert.match(finalMessages[0]?.content ?? '', /многоязычного содержания/, 'Deep Chat language rule must permit requested multilingual content');
  assert.match(finalMessages[0]?.content ?? '', /максимально полезную часть задачи/, 'final Chat stream did not receive the partial-completion instruction');
  assert.deepEqual(routingRequests[1]?.map((message) => message.role), ['system', 'user', 'assistant', 'tool'], 'the post-tool model completion did not receive a contiguous system prefix');
  assert(finalMessages.slice(1).every((message) => message.role !== 'system'), 'final llama.cpp completion received a system message after the initial prefix');
  assert.match(finalMessages[0]?.content ?? '', /result/, 'web result was not retained in the initial system prefix');
  assert.deepEqual(events.filter((event) => event.type === 'thinking').map((event) => event.content), ['Live final reasoning.'], 'internal tool-decision reasoning leaked into user Thinking');
  assert.deepEqual(events.filter((event) => event.type === 'token').map((event) => event.content), ['Live final answer.'], 'final answer was not forwarded as real stream tokens');
}

if (require.main === module) void runWebChatRegression().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
