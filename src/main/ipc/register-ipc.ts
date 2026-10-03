import { BrowserWindow, dialog, ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import type { AnalysisRun, ApprovalDecision, ApprovalStatus, ChatRequest, Conversation, ProjectReference, ProjectSuggestion, RiskCategory, ThinkingTimelineEvent } from '../../shared/types';
import { findFreshContextDiscoveryOption, memoryBaselineWithinTolerance, type ContextDiscoveryOption, type ContextDiscoveryResult, type RuntimeContextEstimate } from '../../shared/context-estimator';
import { Database } from '../services/database';
import { getHardwareStats } from '../services/hardware';
import { OllamaBackend } from '../backends/ollama-backend';
import { LlamaCppBackend } from '../backends/llama-cpp-backend';
import { LAUNCHER_ABSENT, LlamaRuntimeController, type LlamaRuntimeState } from '../services/llama-runtime-controller';
import { RustAgentRuntime, taskPlan, type AgentProject } from '../services/rust-agent-runtime';
import { paths } from '../services/paths';
import { log } from '../services/logger';
import { contextPresetsFor, getModelProfile, modelRegistry } from '../models/model-registry';
import { llamaContextPresets, llamaRuntimeProfile } from '../models/llama-runtime-policy';
import { WebBrowserService } from '../web/web-tools';
import { WebChatService } from '../services/web-chat';
import { chatMessagesWithSystemPrefix, chatSystemContext } from '../services/capabilities';
import { ReadonlyProjectTools, type ApprovalResult, type ConfirmAction } from '../tools/project-tools';
import { AttachmentService } from '../services/attachment-service';
import { AttachmentPipeline } from '../services/attachment-pipeline';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { ollamaErrorDiagnostics } from '../backends/ollama-errors';
import { saveGenerationDiagnosticsBestEffort } from '../services/generation-diagnostics';
import { projectDirectoryName } from '../../shared/project-references';
import { executionMode } from '../../shared/generation-mode';
import { existingProjectDirectory } from '../services/project-picker';
import { collectRuntimeContextEstimate, defaultContextDeviceReserveBytes, defaultContextHostReserveBytes, resolveContextReserve } from '../services/context-estimate';
import { join } from 'node:path';

const database = new Database();
const selectedBackend = process.env.LOCAL_AI_BACKEND === 'llama-cpp' ? 'llama-cpp' : 'ollama';
const llamaRuntimeModelId = process.env.LOCAL_AI_LLAMA_MODEL_ID ?? 'qwen3.8:27b-q4_K_M';
const defaultLlamaContext = 32_768;
const maximumLlamaContext = llamaRuntimeProfile(llamaRuntimeModelId)?.maxContext ?? defaultLlamaContext;
const configuredLlamaContext = Number(process.env.LOCAL_AI_LLAMA_CONTEXT ?? defaultLlamaContext);
const llamaContextLimit = Number.isSafeInteger(configuredLlamaContext) && configuredLlamaContext >= 4_096 && configuredLlamaContext <= maximumLlamaContext && configuredLlamaContext % 4_096 === 0 ? configuredLlamaContext : defaultLlamaContext;
const initialLlamaKvType = process.env.LOCAL_AI_LLAMA_KV_TYPE === 'q8_0' ? 'q8_0' : 'f16';
const initialLlamaKvOffload = process.env.LOCAL_AI_LLAMA_KV_OFFLOAD !== '0';
const ollama = new OllamaBackend();
const llamaCpp = new LlamaCppBackend(process.env.LOCAL_AI_LLAMA_CPP_URL ?? 'http://127.0.0.1:8081', llamaContextLimit, process.env.LOCAL_AI_LLAMA_CPP_VISION === '1', llamaRuntimeModelId);
const backend = selectedBackend === 'llama-cpp' ? llamaCpp : ollama;
const web = new WebBrowserService();
const rustAgent = new RustAgentRuntime(process.env.LOCAL_AI_AGENT_ENDPOINT ?? (selectedBackend === 'llama-cpp' ? process.env.LOCAL_AI_LLAMA_CPP_URL ?? 'http://127.0.0.1:8081/v1/chat/completions' : 'http://127.0.0.1:11434/api/chat'));
const webChat = new WebChatService(backend, web);
const attachments = new AttachmentService(database);
const attachmentPipeline = new AttachmentPipeline(database, attachments);
type ActiveGeneration = {
  id: string;
  abort: AbortController;
  settled: Promise<void>;
  finish: () => void;
  mode?: 'chat' | 'agent';
  followups?: Array<{ message: import('../../shared/types').ChatMessage; timelinePosition: number; applied: boolean }>;
  thinkingTimeline: ThinkingTimelineEvent[];
  activityTimelinePositions: Map<string, number>;
  timelinePosition: number;
  lastTimelineKind: ThinkingTimelineEvent['kind'] | null;
};
const activeGenerations = new Map<string, ActiveGeneration>();
type PendingApproval = { approvalId: string; conversationId: string; generation: ActiveGeneration; actionId: string; category: RiskCategory; root: string; resolve: (result: ApprovalResult) => void; settled: boolean; abort: () => void; emit: (payload: Record<string, unknown>) => void };
const pendingApprovals = new Map<string, PendingApproval>();
const llamaRuntime = new LlamaRuntimeController({
  stateFile: `${paths.dataRoot}/llama-cpp-runtime-state.json`,
  requestFile: `${paths.dataRoot}/llama-cpp-runtime-request.env`,
  launcherPidFile: `${paths.dataRoot}/llama-cpp-mtp-launcher.pid`,
});
const discoveredContextOptions = new Map<string, { option: ContextDiscoveryOption; modelIdentity: string }>();
let contextDiscoveryBusy = false;
const discoveryCandidateMargin = 0.8;
const discoveryKey = (modelId: string, contextWindow: number, kvCacheType: 'f16' | 'q8_0', kvOffload: boolean) => `${modelId}:${contextWindow}:${kvCacheType}:${kvOffload ? 'gpu' : 'ram'}`;
async function modelFileIdentity(path: string): Promise<string> {
  const file = await stat(path);
  return `${file.dev}:${file.ino}:${file.size}:${file.mtimeMs}`;
}
/** The launcher's state file is the authority. A manually managed server has no launcher, so the startup environment stands in. */
async function currentLlamaRuntime(): Promise<LlamaRuntimeState> {
  const state = await llamaRuntime.state();
  if (state.status === 'offline' && state.error === LAUNCHER_ABSENT) return { status: 'ready', modelId: llamaRuntimeModelId, contextWindow: llamaContextLimit, kvCacheType: initialLlamaKvType, kvOffload: initialLlamaKvOffload };
  if (state.status === 'ready') {
    // The state file records the last transition; a server that died since then must not be reported as running.
    const health = await llamaCpp.getStatus();
    if (!health.available) return { status: 'offline', modelId: null, contextWindow: null, error: `llama-server не отвечает: ${health.message ?? 'health check failed'}` };
  }
  return state;
}
async function syncLlamaBackend(): Promise<LlamaRuntimeState> {
  const state = await currentLlamaRuntime();
  if (state.status === 'ready' && state.modelId && state.contextWindow) {
    try { llamaCpp.updateRuntimeSelection(state.modelId, state.contextWindow, state.kvCacheType ?? initialLlamaKvType, state.kvOffload ?? initialLlamaKvOffload); } catch { /* an unsupported combination is reported by the launcher state itself */ }
  }
  return state;
}
async function estimateModelContext(modelId: string): Promise<RuntimeContextEstimate> {
  const profile = getModelProfile(modelId);
  const llamaProfile = selectedBackend === 'llama-cpp' ? llamaRuntimeProfile(modelId) : undefined;
  const configuredMaxTokens = selectedBackend === 'llama-cpp' ? llamaProfile?.maxContext : profile?.maxContext;
  const contextPresets = selectedBackend === 'llama-cpp' ? llamaContextPresets(modelId) : profile ? contextPresetsFor(profile.maxContext) : [];
  const hardware = await getHardwareStats();
  let runtime = null;
  if (configuredMaxTokens) {
    if (selectedBackend === 'llama-cpp' && llamaProfile) {
      const current = await llamaRuntime.state();
      if (current.status === 'ready' && current.launcherPid !== undefined && current.modelId === modelId && current.kvCacheType && current.kvOffload !== undefined) {
        await syncLlamaBackend();
        runtime = await llamaCpp.getRuntimeContextEvidence(modelId);
      }
    } else if (selectedBackend === 'ollama' && profile) {
      runtime = await ollama.getRuntimeContextEvidence(modelId);
    }
  }
  const hostReserve = resolveContextReserve(process.env.LOCAL_AI_CONTEXT_HOST_RESERVE_BYTES, 'LOCAL_AI_CONTEXT_HOST_RESERVE_BYTES', defaultContextHostReserveBytes);
  const deviceReserve = resolveContextReserve(process.env.LOCAL_AI_CONTEXT_DEVICE_RESERVE_BYTES, 'LOCAL_AI_CONTEXT_DEVICE_RESERVE_BYTES', defaultContextDeviceReserveBytes);
  return collectRuntimeContextEstimate({
    backend: selectedBackend,
    modelId,
    configuredMaxTokens: Math.min(configuredMaxTokens ?? 0, runtime?.modelTrainContextTokens ?? Number.MAX_SAFE_INTEGER),
    contextPresets,
    hardware,
    runtime,
    startupLogPath: selectedBackend === 'llama-cpp' ? process.env.LOCAL_AI_LLAMA_SERVER_LOG ?? join(paths.logs, 'llama-cpp-mtp-server.log') : null,
    hostReserveBytes: hostReserve.bytes,
    deviceReserveBytes: deviceReserve.bytes,
    reserveErrors: [hostReserve.error, deviceReserve.error].filter((error): error is string => Boolean(error)),
  });
}
async function discoverModelContexts(modelId: string): Promise<ContextDiscoveryResult> {
  const profile = llamaRuntimeProfile(modelId);
  if (contextDiscoveryBusy) throw new Error('Max Context discovery is already running.');
  for (const key of discoveredContextOptions.keys()) if (key.startsWith(`${modelId}:`)) discoveredContextOptions.delete(key);
  if (selectedBackend !== 'llama-cpp' || !profile) throw new Error('Max Context discovery requires an installed llama.cpp model.');
  contextDiscoveryBusy = true;
  let original: LlamaRuntimeState | null = null;
  const options: ContextDiscoveryOption[] = [];
  const unsupported: ContextDiscoveryResult['unsupported'] = [];
  const probeContextTokens = Math.min(16_384, profile.maxContext);
  let restored = false;
  try {
    if (activeGenerations.size) throw new Error('Остановите генерацию перед измерением Max Context.');
    original = await llamaRuntime.state();
    if (original.status !== 'ready' || original.launcherPid === undefined || !original.modelId || original.contextWindow === null || !original.kvCacheType || original.kvOffload === undefined) {
      throw new Error('Для безопасного discovery требуется работающий launcher-managed llama.cpp runtime с подтверждёнными KV-настройками.');
    }
    if (probeContextTokens < 4_096 || probeContextTokens % 4_096 !== 0) throw new Error('Модель не поддерживает минимальный ограниченный контекст discovery.');
    if (!profile.modelPath) throw new Error('У модели нет зарегистрированного файла для cache identity.');
    const modelIdentity = await modelFileIdentity(profile.modelPath);
    for (const kvCacheType of ['f16', 'q8_0'] as const) {
      try {
        const switched = await llamaRuntime.switchTo(modelId, probeContextTokens, kvCacheType, true);
        if (!switched.ok) {
          unsupported.push({ kvCacheType, reason: switched.error });
          if (switched.state.status !== 'ready') throw new Error(`Не удалось загрузить тестовую конфигурацию ${kvCacheType}: ${switched.error}`);
          continue;
        }
        await syncLlamaBackend();
        await verifyContextProbeInference(modelId);
        if (await modelFileIdentity(profile.modelPath) !== modelIdentity) throw new Error('Model file changed during discovery; no result is safe to cache.');
        const probeEstimate = await estimateModelContext(modelId);
        if (probeEstimate.status !== 'estimated' || !probeEstimate.hardwareSafeTokens || probeEstimate.hardwareSafeTokens < probeContextTokens
          || probeEstimate.observedContextTokens !== probeContextTokens || !probeEstimate.memoryBaseline
          || probeEstimate.activeKvCacheType !== kvCacheType || probeEstimate.activeKvOffload !== true) {
          unsupported.push({ kvCacheType, reason: probeEstimate.unknownReasons.join('; ') || `Нет безопасного окна выше ограниченного ${probeContextTokens}-token probe.` });
          continue;
        }

        const projectedCandidate = Math.floor((probeEstimate.hardwareSafeTokens * discoveryCandidateMargin) / 4_096) * 4_096;
        let candidateContext = Math.max(probeContextTokens, projectedCandidate);
        let validatedEstimate: RuntimeContextEstimate | null = null;
        let candidateFailure = 'Кандидат не прошёл точную проверку при запуске и inference.';
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const candidateSwitch = await llamaRuntime.switchTo(modelId, candidateContext, kvCacheType, true);
          if (!candidateSwitch.ok) {
            candidateFailure = candidateSwitch.error;
            if (attempt === 0 && candidateContext > probeContextTokens) {
              candidateContext = Math.max(probeContextTokens, candidateContext - 8_192);
              continue;
            }
            break;
          }
          await syncLlamaBackend();
          try {
            await verifyContextProbeInference(modelId);
            if (await modelFileIdentity(profile.modelPath) !== modelIdentity) throw new Error('Model file changed during candidate validation.');
            const candidateEstimate = await estimateModelContext(modelId);
            if (candidateEstimate.status === 'estimated'
              && candidateEstimate.observedContextTokens === candidateContext
              && candidateEstimate.hardwareSafeTokens !== null
              && candidateEstimate.hardwareSafeTokens >= candidateContext
              && candidateEstimate.activeKvCacheType === kvCacheType
              && candidateEstimate.activeKvOffload === true
              && candidateEstimate.memoryBaseline
              && candidateEstimate.memoryHeadroom
              && candidateEstimate.memoryHeadroom.hostBytes >= defaultContextHostReserveBytes
              && candidateEstimate.memoryHeadroom.deviceBytes >= defaultContextDeviceReserveBytes) {
              validatedEstimate = candidateEstimate;
              break;
            }
            candidateFailure = candidateEstimate.unknownReasons.join('; ')
              || `При ${candidateContext} токенах расчёт или фактический запас памяти не подтвердил выбранную конфигурацию.`;
          } catch (error) {
            candidateFailure = error instanceof Error ? error.message : String(error);
          }
          if (attempt === 0 && candidateContext > probeContextTokens) {
            candidateContext = Math.max(probeContextTokens, candidateContext - 8_192);
            continue;
          }
          break;
        }
        if (!validatedEstimate?.memoryBaseline || !validatedEstimate.memoryHeadroom) {
          unsupported.push({ kvCacheType, reason: `Точная проверка Max Context не пройдена: ${candidateFailure}` });
          continue;
        }
        const option: ContextDiscoveryOption = {
          modelId,
          contextWindow: candidateContext,
          kvCacheType,
          kvOffload: true,
          discoveredAt: new Date().toISOString(),
          memoryBaseline: validatedEstimate.memoryBaseline,
          measuredHeadroom: validatedEstimate.memoryHeadroom,
        };
        options.push(option);
        discoveredContextOptions.set(discoveryKey(modelId, option.contextWindow, kvCacheType, true), { option, modelIdentity });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        unsupported.push({ kvCacheType, reason: message });
        const state = await llamaRuntime.state();
        if (state.status !== 'ready') throw new Error(`Discovery ${kvCacheType} failed and runtime is not ready: ${message}`);
      }
    }
    const f16 = options.find((option) => option.kvCacheType === 'f16');
    const q8 = options.find((option) => option.kvCacheType === 'q8_0');
    if (f16 && q8 && q8.contextWindow < f16.contextWindow + 8_192) {
      options.splice(options.indexOf(q8), 1);
      discoveredContextOptions.delete(discoveryKey(modelId, q8.contextWindow, 'q8_0', true));
      unsupported.push({ kvCacheType: 'q8_0', reason: `Q8_0 did not improve the measured safe window by at least 8K over F16 (${f16.contextWindow / 1024}K vs ${q8.contextWindow / 1024}K).` });
    }
    if (await modelFileIdentity(profile.modelPath) !== modelIdentity) throw new Error('Model file changed during discovery; no result is safe to cache.');
  } catch (error) {
    for (const key of discoveredContextOptions.keys()) if (key.startsWith(`${modelId}:`)) discoveredContextOptions.delete(key);
    throw error;
  } finally {
    try {
      if (original?.status === 'ready' && original.modelId && original.contextWindow !== null && original.kvCacheType && original.kvOffload !== undefined) {
        const restore = await llamaRuntime.switchTo(original.modelId, original.contextWindow, original.kvCacheType, original.kvOffload);
        if (!restore.ok) {
          discoveredContextOptions.clear();
          throw new Error(`Max Context discovery could not restore the prior runtime (${original.modelId}/${original.contextWindow}/${original.kvCacheType}): ${restore.error}`);
        }
        await syncLlamaBackend();
        restored = true;
      }
    } catch (error) {
      discoveredContextOptions.clear();
      throw error;
    } finally {
      contextDiscoveryBusy = false;
    }
  }
  return { modelId, probeContextTokens, options, unsupported, restored };
}
async function verifyContextProbeInference(modelId: string): Promise<void> {
  const url = process.env.LOCAL_AI_LLAMA_CPP_URL ?? 'http://127.0.0.1:8081';
  const response = await fetch(`${url.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'What is 1 + 1? Reply with exactly 2 and no explanation.' }], max_tokens: 64, temperature: 0, stream: false }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Discovery inference failed with HTTP ${response.status}.`);
  const value = await response.json() as { choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown } }> };
  if (!Array.isArray(value.choices) || !value.choices.length
    || !(typeof value.choices[0]?.message?.content === 'string' && value.choices[0].message.content.trim())) {
    throw new Error('Discovery runtime returned no completed inference choice.');
  }
}
async function validateDiscoveredOption(modelId: string, contextWindow: number, kvCacheType: 'f16' | 'q8_0', kvOffload: boolean): Promise<void> {
  const cachedOptions = [...discoveredContextOptions.values()];
  const option = findFreshContextDiscoveryOption(cachedOptions.map((item) => item.option), { modelId, contextWindow, kvCacheType, kvOffload });
  if (!option) throw new Error('Max Context discovery is missing, stale, or does not validate this KV configuration and context; run Discover again.');
  const cached = cachedOptions.find((item) => item.option === option);
  const modelPath = llamaRuntimeProfile(modelId)?.modelPath;
  if (!cached || !modelPath || await modelFileIdentity(modelPath) !== cached.modelIdentity) throw new Error('Model file identity changed since discovery; run Discover again.');
  const current = await estimateModelContext(modelId);
  if (current.status !== 'estimated' || !current.memoryBaseline || current.observedContextTokens === null) throw new Error('Current runtime memory evidence is unavailable; run Discover again.');
  if (!memoryBaselineWithinTolerance(current.memoryBaseline, option.memoryBaseline, 2 * 1024 ** 3, 512 * 1024 ** 2)) {
    throw new Error('Available memory changed materially since discovery; run Discover again before selecting this context.');
  }
}
const sessionApprovals = new Map<string, { root: string; categories: Set<RiskCategory> }>();

const waitFor = (promise: Promise<void>, timeoutMs: number): Promise<void> => new Promise((resolve) => {
  const timeout = setTimeout(resolve, timeoutMs);
  timeout.unref();
  void promise.then(() => { clearTimeout(timeout); resolve(); }, () => { clearTimeout(timeout); resolve(); });
});

/** Called by Electron's main lifecycle before process exit, never by a renderer. */
export async function shutdownRuntime(): Promise<void> {
  const active = [...activeGenerations.values()];
  log('runtime.shutdown.started', { backend: selectedBackend, activeGenerations: active.length });
  for (const generation of active) generation.abort.abort();
  await Promise.allSettled(active.map((generation) => waitFor(generation.settled, 4_000)));
  if (selectedBackend === 'ollama') {
    try { await ollama.unloadTrackedModels(); }
    catch (error) { log('runtime.shutdown.ollama-unload.failed', ollamaErrorDiagnostics(error)); }
  }
  log('runtime.shutdown.finished', { backend: selectedBackend });
}

function settleApproval(pending: PendingApproval, result: ApprovalResult, status: Exclude<ApprovalStatus, 'pending'>): void {
  if (pending.settled) return;
  pending.settled = true;
  pendingApprovals.delete(pending.approvalId);
  pending.generation.abort.signal.removeEventListener('abort', pending.abort);
  pending.resolve(result);
  if (activeGenerations.get(pending.conversationId) === pending.generation && !pending.generation.abort.signal.aborted) {
    pending.emit({ type: 'approval-resolved', conversationId: pending.conversationId, generationId: pending.generation.id, actionId: pending.actionId, approvalId: pending.approvalId, status });
  }
}

async function cancelGeneration(conversationId: string, generationId?: string, reason: 'user_stop' | 'superseded' = 'superseded'): Promise<void> {
  const active = activeGenerations.get(conversationId);
  if (!active || (generationId && active.id !== generationId)) return;
  log('generation.cancelled', { conversationId, generationId: active.id, reason });
  active.abort.abort(); await active.settled;
}

function inlineConfirmation(event: Electron.IpcMainInvokeEvent, conversationId: string, generation: ActiveGeneration, root: string): ConfirmAction {
  const emit = (payload: Record<string, unknown>) => event.sender.send('chat:stream', payload);
  return async (request, signal) => {
    if (signal.aborted || activeGenerations.get(conversationId) !== generation) return { approved: false, reason: 'cancelled' };
    const requestRoot = request.root ?? root;
    const session = sessionApprovals.get(conversationId);
    if (session?.root === requestRoot && session.categories.has(request.category)) {
      emit({ type: 'approval-resolved', conversationId, generationId: generation.id, actionId: request.actionId, approvalId: `session-${randomUUID()}`, status: 'session-approved' });
      return { approved: true, reason: 'session' };
    }
    const approvalId = randomUUID();
    return new Promise<ApprovalResult>((resolve) => {
      const abort = () => settleApproval(pending, { approved: false, reason: 'cancelled' }, 'rejected');
      const pending: PendingApproval = { approvalId, conversationId, generation, actionId: request.actionId, category: request.category, root: requestRoot, resolve, settled: false, abort, emit };
      pendingApprovals.set(approvalId, pending);
      signal.addEventListener('abort', abort, { once: true });
      emit({ type: 'approval-request', conversationId, generationId: generation.id, actionId: request.actionId, approval: { approvalId, category: request.category, status: 'pending' } });
    });
  };
}

export function registerIpc(): void {
  ipcMain.handle('conversations:list', () => database.listConversations());
  ipcMain.handle('conversations:create', async (_event, requestedModelId?: string) => {
    const modelId = requestedModelId ?? (selectedBackend === 'llama-cpp' ? (await currentLlamaRuntime()).modelId ?? llamaRuntimeModelId : modelRegistry[0].id);
    if (!getModelProfile(modelId)) throw new Error('Выбранная модель отсутствует в реестре приложения');
    return database.createConversation(modelId);
  });
  ipcMain.handle('conversations:update', async (_event, id: string, patch: Partial<Pick<Conversation, 'title' | 'modelId' | 'mode' | 'workingDirectory' | 'secondaryWorkingDirectory' | 'contextWindow' | 'llamaKvCacheType' | 'llamaKvOffload' | 'reasoningMode' | 'webMode'>>) => {
    if (contextDiscoveryBusy) throw new Error('Дождитесь завершения Max Context discovery перед изменением настроек runtime.');
    if (activeGenerations.size && Object.keys(patch).some((key) => key !== 'title')) throw new Error('Дождитесь завершения активной генерации перед изменением настроек.');
    const current = database.getConversation(id);
    if (!current) throw new Error('Чат не найден');
    const nextModelId = patch.modelId ?? current.modelId;
    const profile = nextModelId ? getModelProfile(nextModelId) : undefined;
    if (nextModelId && !profile) throw new Error('Выбранная модель отсутствует в реестре приложения');
    const allowed = profile ? (selectedBackend === 'llama-cpp' ? llamaContextPresets(nextModelId ?? '') : contextPresetsFor(profile.maxContext)) : [];
    const requestedContext = patch.contextWindow ?? current.contextWindow;
    let contextWindow = requestedContext;
    if (allowed.length && !allowed.includes(requestedContext)) {
      if (selectedBackend !== 'llama-cpp' || requestedContext % 4_096 !== 0 || requestedContext > (llamaRuntimeProfile(nextModelId ?? '')?.maxContext ?? 0)) {
        contextWindow = allowed.at(-1)!;
      }
    }
    if (selectedBackend === 'llama-cpp' && nextModelId && profile) {
      const kvCacheType = patch.llamaKvCacheType ?? current.llamaKvCacheType ?? 'f16';
      const kvOffload = patch.llamaKvOffload ?? current.llamaKvOffload ?? true;
      const requiresDiscovery = !allowed.includes(requestedContext)
        || kvCacheType !== (current.llamaKvCacheType ?? 'f16')
        || kvOffload !== (current.llamaKvOffload ?? true);
      if (requiresDiscovery) await validateDiscoveredOption(nextModelId, contextWindow, kvCacheType, kvOffload);
      const runtime = await syncLlamaBackend();
      const runtimeDiffers = runtime.status !== 'ready' || runtime.modelId !== nextModelId || runtime.contextWindow !== contextWindow || runtime.kvCacheType !== kvCacheType || runtime.kvOffload !== kvOffload;
      // Re-selecting the stored model is a retry when the server is not running it.
      if (runtimeDiffers && (patch.modelId !== undefined || patch.contextWindow !== undefined || patch.llamaKvCacheType !== undefined || patch.llamaKvOffload !== undefined)) {
        if (activeGenerations.size > 0) throw new Error('Нельзя переключать llama.cpp во время генерации: остановите её или дождитесь завершения.');
        log('llama.runtime.switch.requested', { conversationId: id, from: runtime, to: { modelId: nextModelId, contextWindow, kvCacheType, kvOffload } });
        const result = await llamaRuntime.switchTo(nextModelId, contextWindow, kvCacheType, kvOffload);
        await syncLlamaBackend();
        log('llama.runtime.switch.finished', { conversationId: id, ok: result.ok, state: result.state, error: result.ok ? undefined : result.error });
        // Nothing is persisted for a failed switch: the stored conversation must keep
        // naming the model that is really running (or none, when the server is down).
        if (!result.ok) throw new Error(`Не удалось переключить llama.cpp на ${profile.displayName} (${Math.round(contextWindow / 1024)}K, ${kvCacheType}, KV ${kvOffload ? 'GPU' : 'RAM'}): ${result.error}${result.state.rolledBack ? ` Продолжает работать ${result.state.modelId}.` : result.state.status === 'offline' ? ' llama.cpp сейчас не запущен.' : ''}`);
      }
    }
    const updated = database.updateConversation(id, { ...patch, contextWindow });
    if ((patch.workingDirectory !== undefined && patch.workingDirectory !== current.workingDirectory) || (patch.secondaryWorkingDirectory !== undefined && patch.secondaryWorkingDirectory !== current.secondaryWorkingDirectory)) sessionApprovals.delete(id);
    if (patch.modelId !== undefined && patch.modelId !== current.modelId) database.setContextUsage(id, null, null);
    if (selectedBackend === 'ollama' && patch.modelId !== undefined && patch.modelId !== current.modelId && current.modelId) void ollama.unloadModel(current.modelId);
    return database.getConversation(id) ?? updated;
  });
  ipcMain.handle('conversations:delete', async (_event, id: string) => {
    if (activeGenerations.has(id)) throw new Error('Нельзя удалить чат с активной генерацией.');
    sessionApprovals.delete(id); await attachments.removeManagedFiles(database.deleteConversation(id));
  });
  ipcMain.handle('messages:list', (_event, conversationId: string) => database.listMessages(conversationId));
  ipcMain.handle('agent-plan:get', (_event, conversationId: string) => database.getAgentPlan(conversationId));
  ipcMain.handle('messages:edit', async (_event, messageId: string, content: string, fallback?: { conversationId: string; content: string }) => {
    if (activeGenerations.size) throw new Error('Дождитесь завершения активной генерации перед редактированием.');
    const message = database.getMessage(messageId) ?? (fallback ? database.findUserMessage(fallback.conversationId, fallback.content) : null); if (!message) throw new Error('Сообщение не найдено');
    const before = database.listAttachmentsForConversation(message.conversationId);
    await cancelGeneration(message.conversationId); const edited = database.editUserMessageAndTruncate(message.id, content);
    const kept = new Set(database.listAttachmentsForConversation(message.conversationId).map((attachment) => attachment.id));
    await attachments.removeManagedFiles(before.filter((attachment) => !kept.has(attachment.id)));
    return edited;
  });
  ipcMain.handle('messages:regenerate', async (_event, messageId: string) => {
    if (activeGenerations.size) throw new Error('Дождитесь завершения активной генерации перед повторной генерацией.');
    const message = database.getMessage(messageId); if (!message) throw new Error('Сообщение не найдено');
    const before = database.listAttachmentsForConversation(message.conversationId);
    await cancelGeneration(message.conversationId);
    const retained = database.regenerateUserMessageAndTruncate(message.id);
    const kept = new Set(database.listAttachmentsForConversation(message.conversationId).map((attachment) => attachment.id));
    await attachments.removeManagedFiles(before.filter((attachment) => !kept.has(attachment.id)));
    return retained;
  });
  ipcMain.handle('projects:search', async (_event, conversationId: string, query: string): Promise<ProjectSuggestion[]> => {
    const conversation = database.getConversation(conversationId);
    if (!conversation?.workingDirectory || typeof query !== 'string') return [];
    const projects = [
      { id: conversation.primaryProjectId, slot: 1 as const, root: conversation.workingDirectory, label: `Project 1 (${projectDirectoryName(conversation.workingDirectory)})` },
      ...(conversation.secondaryWorkingDirectory && conversation.secondaryProjectId ? [{ id: conversation.secondaryProjectId, slot: 2 as const, root: conversation.secondaryWorkingDirectory, label: `Project 2 (${projectDirectoryName(conversation.secondaryWorkingDirectory)})` }] : []),
    ].filter((project): project is { id: string; slot: 1 | 2; root: string; label: string } => Boolean(project.id));
    const groups = await Promise.all(projects.map(async (project) => (await ReadonlyProjectTools.findResources(project.root, query.trim(), 30)).map((resource): ProjectSuggestion => ({ id: randomUUID(), projectId: project.id, projectSlot: project.slot, projectPath: project.root, projectLabel: project.label, relativePath: resource.relativePath, kind: resource.kind }))));
    return groups.flat();
  });
  ipcMain.handle('attachments:import', (_event, input) => attachments.import(input));
  ipcMain.handle('attachments:list', (_event, messageId: string) => database.listAttachments(messageId));
  ipcMain.handle('attachments:dataUrl', async (_event, id: string) => {
    const attachment = database.getAttachment(id); if (!attachment || attachment.kind !== 'image') return null;
    const data = await readFile(attachment.storageRef); return `data:${attachment.mimeType};base64,${data.toString('base64')}`;
  });
  ipcMain.handle('analysis:list', (_event, conversationId: string) => database.listAnalysisRuns(conversationId));
  ipcMain.handle('models:list', async () => {
    try { return await backend.getModels(); }
    catch (error) { log('backend.models.failed', { backend: selectedBackend, message: error instanceof Error ? error.message : String(error) }); return []; }
  });
  ipcMain.handle('settings:get', async () => {
    const llama = selectedBackend === 'llama-cpp' ? await syncLlamaBackend() : null;
    return { selectedBackend, ollamaUrl: 'http://127.0.0.1:11434', llamaServerPath: selectedBackend === 'llama-cpp' ? process.env.LOCAL_AI_LLAMA_SERVER_PATH ?? null : null, ...(llama ? { llamaRuntimeModelId: llama.modelId ?? undefined, llamaRuntime: llama } : {}), modelsPath: paths.models };
  });
  ipcMain.handle('hardware:get', getHardwareStats);
  ipcMain.handle('context:estimate', async (_event, modelId: string): Promise<RuntimeContextEstimate> => {
    if (typeof modelId !== 'string' || !modelId) throw new Error('Не указана модель для оценки контекста');
    return estimateModelContext(modelId);
  });
  ipcMain.handle('context:discover', async (_event, modelId: string): Promise<ContextDiscoveryResult> => {
    if (typeof modelId !== 'string' || !modelId) throw new Error('Не указана модель для discovery контекста');
    return discoverModelContexts(modelId);
  });
  ipcMain.handle('dialog:chooseDirectory', async (_event, initialDirectory?: string | null) => {
    const window = BrowserWindow.getFocusedWindow();
    const defaultPath = await existingProjectDirectory(initialDirectory);
    const result = await dialog.showOpenDialog(window!, { properties: ['openDirectory'], ...(defaultPath ? { defaultPath } : {}) });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle('chat:stop', async (_event, conversationId: string, generationId?: string) => { await cancelGeneration(conversationId, generationId, 'user_stop'); });
  ipcMain.handle('chat:steer', async (event, conversationId: string, generationId: string, content: string) => {
    const generation = activeGenerations.get(conversationId);
    if (!generation || generation.id !== generationId || generation.abort.signal.aborted || generation.mode !== 'agent') throw new Error('Уточнения доступны только во время активного Agent run.');
    if (typeof content !== 'string' || !content.trim() || content.length > 16_000) throw new Error('Уточнение должно содержать от 1 до 16000 символов.');
    await rustAgent.steer(generation.id, content.trim());
    const message = database.addMessage(conversationId, 'user', content.trim());
    if (generation.lastTimelineKind === 'reasoning') {
      const prior = generation.thinkingTimeline.at(-1);
      if (prior?.kind === 'reasoning') prior.completedAt = new Date().toISOString();
    }
    const timelinePosition = ++generation.timelinePosition;
    generation.thinkingTimeline.push({ id: randomUUID(), kind: 'steering', messageId: message.id, position: timelinePosition, status: 'accepted' });
    generation.lastTimelineKind = 'steering';
    (generation.followups ??= []).push({ message, timelinePosition, applied: false });
    log('generation.steering.accepted', { conversationId, generationId, messageId: message.id });
    event.sender.send('chat:stream', { type: 'steering', conversationId, generationId, userMessage: message, status: 'accepted', timelinePosition });
    return message;
  });
  ipcMain.handle('chat:approve', (_event, request: { conversationId: string; generationId: string; approvalId: string; decision: ApprovalDecision }) => {
    const pending = pendingApprovals.get(request.approvalId);
    if (!['reject', 'once', 'session'].includes(request.decision) || !pending || pending.conversationId !== request.conversationId || pending.generation.id !== request.generationId || activeGenerations.get(request.conversationId) !== pending.generation || pending.generation.abort.signal.aborted) return false;
    if (request.decision === 'session') {
      const session = sessionApprovals.get(pending.conversationId);
      const categories = session?.root === pending.root ? session.categories : new Set<RiskCategory>();
      categories.add(pending.category);
      sessionApprovals.set(pending.conversationId, { root: pending.root, categories });
    }
    const approved = request.decision !== 'reject';
    settleApproval(pending, approved ? { approved: true, reason: request.decision === 'session' ? 'session' : 'once' } : { approved: false, reason: 'user_rejected' }, approved ? request.decision === 'session' ? 'session-approved' : 'approved' : 'rejected');
    return true;
  });
  ipcMain.handle('chat:send', async (event, request: ChatRequest) => {
    // Claim the process-wide inference slot synchronously, before any await.
    if (activeGenerations.size) throw new Error('Уже выполняется генерация в другом чате. Дождитесь завершения или остановите её.');
    const abort = new AbortController(); let finish!: () => void;
    const generation: ActiveGeneration = { id: request.generationId, abort, settled: new Promise<void>((resolve) => { finish = resolve; }), finish, thinkingTimeline: [], activityTimelinePositions: new Map(), timelinePosition: 0, lastTimelineKind: null };
    activeGenerations.set(request.conversationId, generation);
    const current = () => activeGenerations.get(request.conversationId) === generation && !abort.signal.aborted;
    let run: AnalysisRun | null = null;
    try {
    const user = request.persistUserMessage ? request.messages.at(-1) : null;
    if (request.persistUserMessage && (!user || user.role !== 'user')) throw new Error('Неверное сообщение');
    const conversation = database.getConversation(request.conversationId);
    if (!conversation) throw new Error('Чат не найден');
    const mode = executionMode(conversation.mode, request.mode);
    generation.mode = mode;
    if (conversation.modelId && conversation.modelId !== request.model) throw new Error('Выбранная модель была изменена. Повторите отправку сообщения.');
    const primaryProject = conversation.workingDirectory && conversation.primaryProjectId ? { id: conversation.primaryProjectId, slot: 1 as const, root: conversation.workingDirectory, label: `Project 1 — ${projectDirectoryName(conversation.workingDirectory)}` } : null;
    const selectedProjects: AgentProject[] = primaryProject ? [primaryProject, ...(conversation.secondaryWorkingDirectory && conversation.secondaryProjectId ? [{ id: conversation.secondaryProjectId, slot: 2 as const, root: conversation.secondaryWorkingDirectory, label: `Project 2 — ${projectDirectoryName(conversation.secondaryWorkingDirectory)}` }] : [])] : [];
    const validReferences = (references: ProjectReference[] | undefined): ProjectReference[] => (references ?? []).filter((reference) => selectedProjects.some((project) => project.id === reference.projectId && project.slot === reference.projectSlot && project.root === reference.projectPath) && (reference.kind === 'file' || reference.kind === 'folder') && Boolean(reference.relativePath));
    if (user) { user.projectReferences = validReferences(user.projectReferences); database.addMessage(request.conversationId, 'user', user.content, user.id, user.projectReferences); }
    const emitAttachment = (chunk: import('../../shared/types').StreamEvent) => event.sender.send('chat:stream', { ...chunk, conversationId: request.conversationId, generationId: generation.id });
    const attachmentIds = [...(request.attachmentIds ?? [])];
    if (user) {
      for (const input of request.attachments ?? []) {
        if (input.messageId !== user.id) throw new Error('Вложение относится к другому сообщению');
        try { const attachment = await attachments.import(input); attachmentIds.push(attachment.id); }
        catch (error) { emitAttachment({ type: 'attachment', activity: { id: `attachment-${input.id ?? randomUUID()}`, label: input.filename, detail: `✕ ${error instanceof Error ? error.message : String(error)}`, status: 'error' } }); }
      }
    }
    if (!current()) return;
    // Ollama advertises capabilities with the installed tag. This governs routing
    // for every image turn in the active history, rather than guessing from names.
    const hasImages = database.listAttachmentsForConversation(request.conversationId).some((attachment) => attachment.kind === 'image');
    const requestUser = user ?? [...request.messages].reverse().find((message) => message.role === 'user');
    const retryAttachmentIds = requestUser ? database.listAttachments(requestUser.id).filter((attachment) => attachment.status === 'pending' || attachment.status === 'cancelled').map((attachment) => attachment.id) : [];
    const nativeImagesRequested = attachmentPipeline.hasNativeImagesForRequest(request.messages);
    const nativeVision = nativeImagesRequested && await backend.supportsVision(request.model, abort.signal);
    const preprocessIds = [...new Set([...attachmentIds, ...retryAttachmentIds])];
    log('attachment.vision-routing', { generationId: generation.id, modelId: request.model, hasImages, nativeImagesRequested, route: nativeVision ? 'native' : nativeImagesRequested ? 'unsupported' : hasImages ? 'deferred' : 'none' });
    if (preprocessIds.length) await attachmentPipeline.preprocessCurrent(preprocessIds, abort.signal, emitAttachment, nativeVision);
    if (!current()) return;
    await backend.ensureModelAvailable(request.model);
    if (!current()) return;
    let output = ''; let thinking = ''; let messageDiagnostics: import('../../shared/types').GenerationDiagnostics | undefined; let completed = false; let failed = false; let finishReason: 'stop' | 'length' = 'stop';
    const { thinkingTimeline, activityTimelinePositions } = generation;
    const agentProjects: AgentProject[] = mode === 'agent' ? [...selectedProjects] : [];
    const agentRoot = agentProjects[0]?.root ?? null;
    const enabledTools = mode === 'agent' ? ['apply_patch', 'create_file', 'delete_file', 'list_directory', 'project_knowledge_index', 'project_knowledge_read', 'project_knowledge_update', 'read_file', 'run_terminal', 'task_memory', 'write_file'] : conversation.webMode === 'auto' ? ['web'] : [];
    log('generation.snapshot', { generationId: generation.id, chatId: request.conversationId, mode, storedMode: conversation.mode, requestedMode: request.mode, workingDirectory: conversation.workingDirectory, resolvedWorkingDirectory: agentRoot, projects: agentProjects.map((project) => ({ id: project.id, slot: project.slot })), webMode: conversation.webMode, modelId: request.model, contextSize: conversation.contextWindow, reasoningMode: conversation.reasoningMode, enabledTools });
    run = mode === 'agent' ? database.createAnalysisRun(request.conversationId, conversation.reasoningMode) : null;
    if (run && current()) event.sender.send('chat:stream', { type: 'analysis-run', conversationId: request.conversationId, generationId: generation.id, run });
      const context = await backend.resolveContextWindow(request.model, conversation.contextWindow, abort.signal);
      if (!current()) return;
      event.sender.send('chat:stream', { type: 'context', conversationId: request.conversationId, generationId: generation.id, ...context });
      if (mode === 'agent' && selectedBackend === 'ollama') {
        // Prepare the native runner before the Rust sidecar's matching native
        // request so a stale 32K/64K allocation is reconfigured explicitly.
        await ollama.prepareAgentContext(request.model, context.active, abort.signal);
        if (!current()) return;
        log('ollama.agent.transport', {
          model: request.model,
          selectedContext: context.active,
          endpoint: 'http://127.0.0.1:11434/api/chat',
          transport: 'native',
          generationNumCtx: context.active,
        });
      }
      // Image descriptions are excluded for native-vision requests: the original
      // image payload is attached only to its owning user turn below.
      let history = attachmentPipeline.buildContext(request.messages, !hasImages);
      if (nativeVision) history = await attachmentPipeline.prepareNativeImages(history, abort.signal);
      const persistedTaskMemory = mode === 'agent' ? taskPlan(database.getAgentPlan(request.conversationId) ?? {}).taskMemory : undefined;
      const agentSupportsReasoning = mode === 'agent'
        ? selectedBackend === 'ollama'
          ? await ollama.supportsReasoning(request.model, abort.signal)
          : llamaCpp.supportsReasoning(request.model)
        : false;
      const stream = mode === 'agent'
        ? rustAgent.stream(request.model, history, agentProjects, abort.signal, context.active, conversation.reasoningMode, conversation.webMode, generation.id, persistedTaskMemory, request.conversationId, agentSupportsReasoning)
        : conversation.webMode === 'auto'
          ? webChat.stream(request.model, history, abort.signal, context.active, conversation.reasoningMode)
          : backend.streamChat(request.model, chatMessagesWithSystemPrefix(history, [chatSystemContext({ webAvailable: false }, conversation.reasoningMode === 'deep' ? 'deep' : 'fast')], request.conversationId, `capability-${request.conversationId}`), abort.signal, context.active, conversation.reasoningMode);
      for await (let chunk of stream) {
        if (!current()) break;
        if (chunk.type === 'steering') {
          const content = chunk.userMessage.content;
          const followup = generation.followups?.find((entry) => !entry.applied && entry.message.content === content);
          if (followup) {
            followup.applied = true;
            const timelineEvent = thinkingTimeline.find((entry) => entry.kind === 'steering' && entry.messageId === followup.message.id);
            if (timelineEvent?.kind === 'steering') timelineEvent.status = 'applied';
            event.sender.send('chat:stream', { ...chunk, userMessage: followup.message, timelinePosition: followup.timelinePosition, conversationId: request.conversationId, generationId: generation.id });
            log('generation.steering.applied', { conversationId: request.conversationId, generationId: generation.id, messageId: followup.message.id });
          }
          continue;
        }
        if (chunk.type === 'token') output += chunk.content;
        if (chunk.type === 'thinking') {
          thinking += chunk.content;
          if (mode === 'agent') {
            if (generation.lastTimelineKind !== 'reasoning') { const position = ++generation.timelinePosition; thinkingTimeline.push({ id: randomUUID(), kind: 'reasoning', content: chunk.content, position, startedAt: new Date().toISOString() }); generation.lastTimelineKind = 'reasoning'; }
            else { const entry = thinkingTimeline.at(-1); if (entry?.kind === 'reasoning') entry.content += chunk.content; }
            chunk = { ...chunk, timelinePosition: generation.timelinePosition };
          }
        }
        if (chunk.type === 'task-memory') {
          database.saveAgentPlan(request.conversationId, { milestones: [], taskMemory: structuredClone(chunk.memory) });
          continue;
        }
        if (chunk.type === 'context-usage') {
          database.setContextUsage(request.conversationId, request.model, chunk.used);
          event.sender.send('chat:stream', { ...chunk, conversationId: request.conversationId, generationId: generation.id, modelId: request.model });
          continue;
        }
        if (chunk.type === 'diagnostics') {
          const diagnostics = { ...chunk.diagnostics, generationId: generation.id, conversationId: request.conversationId, createdAt: new Date().toISOString() };
          messageDiagnostics = diagnostics;
          saveGenerationDiagnosticsBestEffort((value) => database.saveGenerationDiagnostics(value), diagnostics);
          log('generation.diagnostics', diagnostics);
          event.sender.send('chat:stream', { type: 'diagnostics', conversationId: request.conversationId, generationId: generation.id, diagnostics });
          continue;
        }
        if (chunk.type === 'done') { completed = true; finishReason = chunk.finishReason === 'length' ? 'length' : 'stop'; continue; }
        if (chunk.type === 'error') failed = true;
        if (run && chunk.type === 'tool') {
          if (generation.lastTimelineKind === 'reasoning') { const prior = thinkingTimeline.at(-1); if (prior?.kind === 'reasoning') prior.completedAt = new Date().toISOString(); }
          const existingPosition = activityTimelinePositions.get(chunk.activity.id);
          const position = existingPosition ?? ++generation.timelinePosition;
          if (existingPosition === undefined) { activityTimelinePositions.set(chunk.activity.id, position); thinkingTimeline.push({ id: randomUUID(), kind: 'activity', activityId: chunk.activity.id, position }); }
          generation.lastTimelineKind = 'activity';
          const activity = { ...chunk.activity, timelinePosition: position };
          const updated = database.addAnalysisAction(run.id, activity);
          const visibleActivity = { ...activity };
          delete visibleActivity.rawOutput;
          event.sender.send('chat:stream', { ...chunk, activity: visibleActivity, runId: run.id, conversationId: request.conversationId, generationId: generation.id });
          event.sender.send('chat:stream', { type: 'analysis-run', conversationId: request.conversationId, generationId: generation.id, run: updated });
        } else event.sender.send('chat:stream', { ...chunk, conversationId: request.conversationId, generationId: generation.id });
      }
      if (!current()) { if (run) database.finishAnalysisRun(run.id, 'cancelled', null); return; }
      if (failed || !completed) { if (run) event.sender.send('chat:stream', { type: 'analysis-run', conversationId: request.conversationId, generationId: generation.id, run: database.finishAnalysisRun(run.id, 'error', null) }); return; }
      if (generation.lastTimelineKind === 'reasoning') { const prior = thinkingTimeline.at(-1); if (prior?.kind === 'reasoning') prior.completedAt = new Date().toISOString(); }
      const inputTokens = messageDiagnostics?.promptEvalCount ?? messageDiagnostics?.inputTokens;
      const generationStats = messageDiagnostics?.evalCount === undefined ? undefined : {
        outputTokens: messageDiagnostics.evalCount,
        ...(messageDiagnostics.tokensPerSecond !== undefined ? { tokensPerSecond: messageDiagnostics.tokensPerSecond } : {}),
        ...(messageDiagnostics.evalDuration !== undefined ? { generationDurationMs: messageDiagnostics.evalDuration / 1_000_000 } : {}),
        ...(messageDiagnostics.timeToFirstTokenMs !== undefined ? { timeToFirstTokenMs: messageDiagnostics.timeToFirstTokenMs } : {}),
        ...(inputTokens !== undefined ? { inputTokens } : {}),
      };
      const assistant = output ? database.addMessage(request.conversationId, 'assistant', output, undefined, [], { ...(thinking.trim() ? { thinking } : {}), ...(thinkingTimeline.length ? { thinkingTimeline } : {}), ...(generationStats ? { generationStats } : {}) }) : null;
      if (run) event.sender.send('chat:stream', { type: 'analysis-run', conversationId: request.conversationId, generationId: generation.id, run: database.finishAnalysisRun(run.id, 'completed', assistant?.id ?? null) });
      event.sender.send('chat:stream', { type: 'done', conversationId: request.conversationId, generationId: generation.id, assistant, finishReason });
    } catch (error) {
      log('generation.failed', { generationId: generation.id, conversationId: request.conversationId, model: request.model, ...ollamaErrorDiagnostics(error) });
      if (run) { const finished = database.finishAnalysisRun(run.id, abort.signal.aborted ? 'cancelled' : 'error', null); if (current()) event.sender.send('chat:stream', { type: 'analysis-run', conversationId: request.conversationId, generationId: generation.id, run: finished }); }
      if (current()) event.sender.send('chat:stream', { type: 'error', conversationId: request.conversationId, generationId: generation.id, message: 'Не удалось выполнить запрос', details: error instanceof Error ? error.message : String(error) });
    } finally {
      if (activeGenerations.get(request.conversationId) === generation) {
        activeGenerations.delete(request.conversationId);
        if (abort.signal.aborted) event.sender.send('chat:stream', { type: 'cancelled', conversationId: request.conversationId, generationId: generation.id });
      }
      generation.finish();
    }
  });
}
