import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OllamaBackend } from '../backends/ollama-backend';
import type { ToolCallingBackend, ToolMessage } from '../backends/types';
import { ProjectChatService } from './project-chat';
import { WebBrowserService } from '../web/web-tools';
import type { StreamEvent } from '../../shared/types';

const model = 'qwen3.8:27b-q4_K_M';
const contextWindow = 32_768;
const timeoutMs = 25 * 60_000;

async function fixture(root: string): Promise<void> {
  await mkdir(join(root, 'ui'), { recursive: true }); await mkdir(join(root, 'core'), { recursive: true }); await mkdir(join(root, 'services'), { recursive: true });
  const files: Record<string, string> = {
    'main.py': 'from ui.main_window import MainWindow\nfrom core.pipeline_orchestrator import PipelineOrchestrator\n# application wires MainWindow to PipelineOrchestrator\n',
    'ui/main_window.py': 'class MainWindow:\n    def on_start(self):\n        self.controller.start_session()\n',
    'ui/session_controller.py': 'class SessionController:\n    def start_session(self):\n        return self.orchestrator.start()\n',
    'core/pipeline_orchestrator.py': 'class PipelineOrchestrator:\n    def start(self):\n        audio = self.audio.capture()\n        text = self.translation.translate(audio)\n        return self.tts.speak(text)\n',
    'core/app_config.py': 'def load_config(data):\n    # QUESTIONABLE: unknown keys are silently ignored\n    return {key: value for key, value in data.items() if key in {"voice", "language"}}\n',
    'services/audio_engine.py': 'class AudioEngine:\n    def capture(self): return b"audio"\n',
    'services/translation_service.py': 'class TranslationService:\n    def translate(self, audio): return "translated"\n',
    'services/tts_service.py': 'class TtsService:\n    def speak(self, text): return text\n',
    'core/branch_controller.py': 'class BranchController:\n    # QUESTIONABLE: retry state is kept in process memory only\n    retries = 0\n',
    'legacy/speech_pipeline.py': '# legacy path is not referenced by main flow\n',
  };
  for (const [path, content] of Object.entries(files)) { await mkdir(join(root, path, '..'), { recursive: true }).catch(() => undefined); await writeFile(join(root, path), content); }
}

export async function runQwenAnalysis(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'local-ai-qwen-analysis-')); const startedAt = Date.now();
  try {
    await fixture(root);
    const backend = new OllamaBackend(); let finalSynthesisStartedAt: number | undefined; let finalSynthesisDurationMs: number | undefined;
    const trackedBackend: ToolCallingBackend = {
      countInputTokens: backend.countInputTokens.bind(backend),
      chatWithTools: async (requestedModel: string, messages: ToolMessage[], tools, signal, requestedContextWindow, reasoningMode, requestContext) => {
        if (!tools) finalSynthesisStartedAt = Date.now();
        const response = await backend.chatWithTools(requestedModel, messages, tools, signal, requestedContextWindow, reasoningMode, requestContext);
        if (!tools && finalSynthesisStartedAt) finalSynthesisDurationMs = Date.now() - finalSynthesisStartedAt;
        return response;
      },
    };
    const service = new ProjectChatService(trackedBackend, new WebBrowserService());
    const history = [{ id: 'analysis-user', conversationId: 'analysis', role: 'user' as const, createdAt: new Date().toISOString(), content: 'Analyze this PySide6 realtime voice translator architecture. Trace the UI to underlying logic, identify 2–3 questionable decisions, and suggest minimal improvements. This is analysis only: do not modify files. Keep a task plan and Task Notes, then provide a short final summary.' }];
    const events: StreamEvent[] = []; const controller = new AbortController(); let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try { for await (const event of service.stream(model, history, root, controller.signal, contextWindow, 'fast', 'off', async () => ({ approved: false as const, reason: 'cancelled' as const }))) events.push(event); } finally { clearTimeout(timer); }
    const tools = events.filter((event): event is Extract<StreamEvent, { type: 'tool' }> => event.type === 'tool').map((event) => event.activity);
    const errors = events.filter((event): event is Extract<StreamEvent, { type: 'error' }> => event.type === 'error');
    const finalText = events.filter((event): event is Extract<StreamEvent, { type: 'token' }> => event.type === 'token').map((event) => event.content).join('');
    const plan = tools.filter((activity) => activity.kind === 'planning' && activity.state === 'completed').at(-1)?.plan;
    const result = { model, contextWindow, durationMs: Date.now() - startedAt, finalSynthesisDurationMs: finalSynthesisDurationMs ?? null, timedOut, budgetedActions: tools.filter((activity) => activity.state === 'running').length, mutationActions: tools.filter((activity) => activity.kind === 'mutation').length, taskNotesUpdates: tools.filter((activity) => activity.kind === 'notes' && activity.state === 'completed').length, planFinalState: plan?.steps.map((step) => `${step.id}:${step.status}`) ?? [], stalledGuardTriggered: errors.some((event) => event.details?.includes('agent_stalled_exploration')), errors: errors.map((event) => ({ message: event.message, details: event.details })), finalSynthesisProduced: Boolean(finalText.trim()), finalText };
    console.log(JSON.stringify(result, null, 2));
    if (timedOut || result.mutationActions || result.stalledGuardTriggered || !result.taskNotesUpdates || !result.planFinalState.length || !result.finalSynthesisProduced) process.exitCode = 1;
  } finally { await rm(root, { recursive: true, force: true }); }
}
if (require.main === module) void runQwenAnalysis().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
