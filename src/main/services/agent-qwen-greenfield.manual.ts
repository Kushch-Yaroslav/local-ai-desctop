/** Real Agent integration harness. It never scaffolds files itself: Qwen acts
 * through ProjectChatService tools. Only the explicitly approved test root is
 * prepared by this runner. */
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { LlamaCppBackend } from '../backends/llama-cpp-backend';
import { ProjectChatService } from './project-chat';
import { WebBrowserService } from '../web/web-tools';
import type { StreamEvent } from '../../shared/types';

const root = '/media/yaroslav/DATA/Projects/шашки';
const model = 'qwen3.8:27b-q4_K_M';
const mode = process.argv[2] === 'react' ? 'react' : 'html';
const target = join(root, mode === 'react' ? 'react-checkers' : 'calculator-html');
const prompt = mode === 'react'
  ? 'С нуля создай здесь небольшой React-проект с игрой в классические шашки 8x8. Создай весь проект и все необходимые файлы самостоятельно. Игрок выбирает сторону, можно играть против локального алгоритма, реализуй базовые правила ходов и взятий, текущий ход и новую игру. Не используй LLM API. Самостоятельно установи или используй нужные зависимости, запусти build и доступные проверки или tests. Если проверка падает или получает timeout, самостоятельно прочитай diagnostics и исправь причину. Не завершай работу до проверки проекта.'
  : 'В этой пустой папке создай один HTML-файл с простым калькулятором. Калькулятор должен уметь базовые операции. Сам проверь основную логику перед завершением. Не заканчивай работу, пока файл не создан и не проверен.';

async function emptyTestDirectory(): Promise<void> {
  await mkdir(root, { recursive: true }); await rm(target, { recursive: true, force: true }); await mkdir(target);
  if ((await readdir(target)).length) throw new Error(`Test root is not empty: ${target}`);
}

async function main(): Promise<void> {
  await emptyTestDirectory();
  const backend = new LlamaCppBackend(); const service = new ProjectChatService(backend, new WebBrowserService());
  const controller = new AbortController(); const events: StreamEvent[] = []; const startedAt = Date.now();
  const timeout = setTimeout(() => controller.abort(), 35 * 60_000);
  try {
    const history = [{ id: `qwen-${mode}-user`, conversationId: `qwen-${mode}`, role: 'user' as const, content: prompt, createdAt: new Date().toISOString() }];
    for await (const event of service.stream(model, history, target, controller.signal, 32_768, 'deep', 'off', async () => ({ approved: true as const, reason: 'session' as const }))) {
      events.push(event);
      if (event.type === 'thinking') process.stdout.write(`[thinking] ${event.content}`);
      if (event.type === 'tool') process.stdout.write(`\n[tool] ${event.activity.state} ${event.activity.label} ${event.activity.detail ?? ''}\n`);
      if (event.type === 'error') process.stdout.write(`\n[error] ${event.message} ${event.details ?? ''}\n`);
    }
  } finally { clearTimeout(timeout); }
  const entries = await readdir(target); const errors = events.filter((event): event is Extract<StreamEvent, { type: 'error' }> => event.type === 'error');
  const tools = events.filter((event): event is Extract<StreamEvent, { type: 'tool' }> => event.type === 'tool').map((event) => event.activity);
  const diagnostics = events.filter((event): event is Extract<StreamEvent, { type: 'diagnostics' }> => event.type === 'diagnostics').map((event) => event.diagnostics);
  const final = events.filter((event): event is Extract<StreamEvent, { type: 'token' }> => event.type === 'token').map((event) => event.content).join('');
  console.log(JSON.stringify({ mode, target, prompt, durationMs: Date.now() - startedAt, entries, toolActions: tools.map((tool) => ({ label: tool.label, state: tool.state, kind: tool.kind, detail: tool.detail })), thinkingChars: events.filter((event) => event.type === 'thinking').reduce((n, event) => n + (event.type === 'thinking' ? event.content.length : 0), 0), diagnostics, errors, final }, null, 2));
  if (errors.length || !entries.length || !final.trim()) process.exitCode = 1;
  if (mode === 'html' && !(await stat(join(target, 'calculator.html')).catch(() => undefined))) process.exitCode = 1;
  if (mode === 'react' && !(await stat(join(target, 'package.json')).catch(() => undefined))) process.exitCode = 1;
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
