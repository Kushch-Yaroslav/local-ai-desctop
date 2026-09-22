import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OllamaBackend } from '../backends/ollama-backend';
import type { ToolCallingBackend, ToolMessage } from '../backends/types';
import { ProjectChatService } from './project-chat';
import { WebBrowserService } from '../web/web-tools';
import type { StreamEvent, ToolActivity } from '../../shared/types';

const model = 'qwen3.8:27b-q4_K_M';
const contextWindow = 32_768;
const timeoutMs = 25 * 60_000;
const subsystemNames = ['bootstrap', 'main_window', 'session_controller', 'audio_capture', 'audio_router', 'translation_client', 'tts_queue', 'settings', 'hotkeys', 'telemetry', 'recovery', 'shutdown'] as const;

function moduleSource(project: 'A' | 'B', subsystem: string, index: number): string {
  const next = subsystemNames[(index + 1) % subsystemNames.length];
  const difference = project === 'A'
    ? index === 7 ? 'QUESTIONABLE: unknown configuration keys are silently discarded.' : index === 6 ? 'QUESTIONABLE: queue ownership is split between controller and TTS worker.' : 'Project A uses an in-process event handoff.'
    : index === 7 ? 'QUESTIONABLE: settings validation logs unknown keys but continues with defaults.' : index === 6 ? 'QUESTIONABLE: queue retries retain audio buffers until shutdown.' : 'Project B uses an explicit session event handoff.';
  // Real projects often have long service modules. Keep the evidence prose
  // compact but make each contract large enough that the recent verbatim
  // window, rather than an artificial action count, exercises compaction.
  const filler = Array.from({ length: 144 }, (_, line) => `    # ${subsystem} contract detail ${line + 1}: input, ownership, lifecycle and error boundary are documented here.`).join('\n');
  return `\"\"\"${project} ${subsystem} subsystem contract.\"\"\"\n\nclass ${subsystem.replace(/(^|_)([a-z])/g, (_all, _prefix, letter) => letter.toUpperCase())}Service:\n    def handle(self, event):\n        \"\"\"Receives ${subsystem} work and routes it to ${next}.\"\"\"\n${filler}\n        # ${difference}\n        return {\"next\": \"${next}\", \"project\": \"${project}\"}\n`;
}

async function fixture(root: string, project: 'A' | 'B'): Promise<void> {
  await mkdir(join(root, 'app'), { recursive: true });
  for (const [index, subsystem] of subsystemNames.entries()) await writeFile(join(root, 'app', `${String(index + 1).padStart(2, '0')}_${subsystem}.py`), moduleSource(project, subsystem, index));
  await writeFile(join(root, 'README.md'), `# Translator ${project}\nThe UI starts in app/02_main_window.py and the request flow moves through the numbered app modules. Compare corresponding module contracts across both projects.\n`);
}

const toolActivities = (events: StreamEvent[]): ToolActivity[] => events.flatMap((event) => event.type === 'tool' ? [event.activity] : []);

/** Manual real-model regression: one generation, no persistence beyond the run. */
export async function runQwenWorkingMemory(): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'local-ai-qwen-working-memory-'));
  const projectA = join(base, 'translator-a'); const projectB = join(base, 'translator-b'); const startedAt = Date.now();
  try {
    await fixture(projectA, 'A'); await fixture(projectB, 'B');
    const backend = new OllamaBackend(); let finalSynthesisStartedAt: number | undefined; let finalSynthesisDurationMs: number | undefined;
    const trackedBackend: ToolCallingBackend = {
      countInputTokens: backend.countInputTokens.bind(backend),
      chatWithTools: async (requestedModel: string, messages: ToolMessage[], tools, signal, requestedWindow, reasoningMode, requestContext) => {
        if (!tools) finalSynthesisStartedAt = Date.now();
        const response = await backend.chatWithTools(requestedModel, messages, tools, signal, requestedWindow, reasoningMode, requestContext);
        if (!tools && finalSynthesisStartedAt) finalSynthesisDurationMs = Date.now() - finalSynthesisStartedAt;
        return response;
      },
    };
    const service = new ProjectChatService(trackedBackend, new WebBrowserService());
    const history = [{ id: 'working-memory-user', conversationId: 'working-memory', role: 'user' as const, createdAt: new Date().toISOString(), content: `Analyze and compare two related realtime-translator projects. This is analysis only: do not modify files. Use a short Task Plan and Task Notes. Trace the UI-to-runtime flow and compare the subsystem contracts in app/01_bootstrap.py through app/12_shutdown.py in both projects; they are the intentionally separate components of this fixture. Identify 2–3 concrete questionable decisions and give minimal improvements. When a group of findings is established, update Task Notes and advance the Plan before investigating another group. For an exact prior detail after context optimization, use recall_previous_tool_result rather than broadly rereading files. Finish with a concise architecture and comparison summary.` }];
    const events: StreamEvent[] = []; const controller = new AbortController(); let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      const projects = [{ id: 'translator-a', slot: 1 as const, root: projectA, label: 'Project 1: Translator A' }, { id: 'translator-b', slot: 2 as const, root: projectB, label: 'Project 2: Translator B' }];
      for await (const event of service.stream(model, history, projects, controller.signal, contextWindow, 'fast', 'off', async () => ({ approved: false as const, reason: 'cancelled' as const }))) events.push(event);
    } finally { clearTimeout(timeout); }
    const activities = toolActivities(events); const compactions = activities.filter((activity) => activity.kind === 'context');
    const effectiveCompactions = compactions.filter((activity) => activity.metadata?.meaningful_savings === true);
    const errors = events.filter((event): event is Extract<StreamEvent, { type: 'error' }> => event.type === 'error');
    const finalText = events.filter((event): event is Extract<StreamEvent, { type: 'token' }> => event.type === 'token').map((event) => event.content).join('');
    const finalPlan = activities.filter((activity) => activity.kind === 'planning' && activity.state === 'completed').at(-1)?.plan;
    const latestContext = compactions.at(-1)?.metadata ?? {};
    const result = {
      model, backend: 'ollama', contextWindow, durationMs: Date.now() - startedAt, timeoutMs, timedOut,
      budgetedActions: activities.filter((activity) => activity.state === 'running').length,
      effectiveCompactionCount: effectiveCompactions.length, ineffectiveCompactionCount: compactions.length - effectiveCompactions.length,
      checkpointCount: effectiveCompactions.filter((activity) => activity.metadata?.checkpoint_reason === 'pre_compaction').length,
      workingMemoryTokensOverTime: compactions.map((activity) => Number(activity.metadata?.working_memory_tokens) || 0),
      factsAdded: Number(latestContext.facts_added) || 0, factsUpdated: Number(latestContext.facts_updated) || 0, factsDeduplicated: Number(latestContext.facts_deduplicated) || 0, staleFactsRemoved: Number(latestContext.stale_facts_removed) || 0,
      historyRetrievalCount: Number(latestContext.history_retrieval_count) || 0, postCompactionRereadCount: Number(latestContext.post_compaction_reread_count) || 0,
      taskNotesUpdates: activities.filter((activity) => activity.kind === 'notes' && activity.state === 'completed').length,
      mutationActions: activities.filter((activity) => activity.kind === 'mutation' && activity.state === 'completed').length,
      planFinalState: finalPlan?.steps.map((step) => ({ id: step.id, status: step.status })) ?? [],
      stalledGuardTriggered: errors.some((event) => event.details?.includes('agent_stalled_exploration')),
      finalSynthesisDurationMs: finalSynthesisDurationMs ?? null, finalSynthesisProduced: Boolean(finalText.trim()),
      errors: errors.map((event) => ({ message: event.message, details: event.details })), finalText,
    };
    const completedPlan = result.planFinalState.length > 0 && result.planFinalState.every((step) => step.status === 'completed');
    // A Plan can remain partly in progress when a model legitimately enters
    // final synthesis; survival and a usable final answer are the memory
    // acceptance criteria, while the exact final state stays in telemetry.
    const passed = !timedOut && result.effectiveCompactionCount >= 2 && result.checkpointCount >= 2 && result.mutationActions === 0 && result.taskNotesUpdates >= 1 && result.planFinalState.length > 0 && !result.stalledGuardTriggered && result.finalSynthesisProduced && errors.length === 0;
    console.log(JSON.stringify({ ...result, completedPlan, validationPassed: passed }, null, 2));
    if (!passed) process.exitCode = 1;
  } finally { await rm(base, { recursive: true, force: true }); }
}

if (require.main === module) void runQwenWorkingMemory().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
