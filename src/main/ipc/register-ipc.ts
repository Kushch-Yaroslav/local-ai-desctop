import { BrowserWindow, dialog, ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import type { AnalysisRun, ApprovalDecision, ApprovalStatus, ChatRequest, Conversation, ProjectReference, ProjectSuggestion, RiskCategory, ThinkingTimelineEvent } from '../../shared/types';
import { findFreshContextDiscoveryOption, type ContextDiscoveryOption, type ContextDiscoveryResult, type ContextDiscoveryProgress, type RuntimeContextEstimate } from '../../shared/context-estimator';
import { defaultLlamaKv, normalContextForModel, resolveLlamaKvSelection } from '../../shared/context-options';
import { Database } from '../services/database';
import { getGpuIdentity, getHardwareStats, getOwnedServerVramBudget } from '../services/hardware';
import { buildContextDiscoveryIdentity, contextDiscoveryKey, mergeSavedDiscoveryOptions } from '../services/context-discovery-persistence';
import { vramBudgetStillFits, vramProbeGuardBytes } from '../../shared/vram-budget';
import { LlamaCppBackend } from '../backends/llama-cpp-backend';
import { LAUNCHER_ABSENT, LlamaRuntimeController, type LlamaRuntimeState } from '../services/llama-runtime-controller';
import { RustAgentRuntime, taskPlan, type AgentProject } from '../services/rust-agent-runtime';
import { paths } from '../services/paths';
import { discardAgentEvidence } from '../services/agent-evidence';
import { log } from '../services/logger';
import { getModelProfile } from '../models/model-registry';
import { llamaContextPresets, llamaRuntimeProfile } from '../models/llama-runtime-policy';
import { WebBrowserService } from '../web/web-tools';
import { WebChatService } from '../services/web-chat';
import { chatMessagesWithSystemPrefix, chatSystemContext } from '../services/capabilities';
import { ReadonlyProjectTools, type ApprovalResult } from '../tools/project-tools';
import { AttachmentService } from '../services/attachment-service';
import { AttachmentPipeline } from '../services/attachment-pipeline';
import { readFile, stat } from 'node:fs/promises';
import { saveGenerationDiagnosticsBestEffort } from '../services/generation-diagnostics';
import { projectDirectoryName } from '../../shared/project-references';
import { executionMode } from '../../shared/generation-mode';
import { touchesRuntime } from '../../shared/conversation-settings';
import { existingProjectDirectory } from '../services/project-picker';
import { collectRuntimeContextEstimate, defaultContextDeviceReserveBytes, defaultContextHostReserveBytes, resolveContextReserve } from '../services/context-estimate';
import { join } from 'node:path';
import { llamaCapabilityLimit } from '../services/gguf-context';
import { discoverContextBoundary, predictContextHeadroom, type DiscoveryProbe } from '../services/context-discovery';

const database = new Database();
const llamaRuntimeModelId = process.env.LOCAL_AI_LLAMA_MODEL_ID ?? 'qwen3.8:27b-q4_K_M';
const defaultLlamaContext = 32_768;
const maximumLlamaContext = llamaRuntimeProfile(llamaRuntimeModelId)?.maxContext ?? defaultLlamaContext;
const configuredLlamaContext = Number(process.env.LOCAL_AI_LLAMA_CONTEXT ?? defaultLlamaContext);
const llamaContextLimit = Number.isSafeInteger(configuredLlamaContext) && configuredLlamaContext >= 4_096 && configuredLlamaContext <= maximumLlamaContext && configuredLlamaContext % 4_096 === 0 ? configuredLlamaContext : defaultLlamaContext;
const initialLlamaKvType = process.env.LOCAL_AI_LLAMA_KV_TYPE === 'q8_0' ? 'q8_0' : 'f16';
const initialLlamaKvOffload = process.env.LOCAL_AI_LLAMA_KV_OFFLOAD !== '0';
const llamaCppUrl = process.env.LOCAL_AI_LLAMA_CPP_URL ?? 'http://127.0.0.1:8081';
const llamaCpp = new LlamaCppBackend(llamaCppUrl, llamaContextLimit, process.env.LOCAL_AI_LLAMA_CPP_VISION === '1', llamaRuntimeModelId);
const backend = llamaCpp;
const web = new WebBrowserService();
const rustAgent = new RustAgentRuntime(process.env.LOCAL_AI_AGENT_ENDPOINT ?? `${llamaCppUrl.replace(/\/$/, '')}/v1/chat/completions`);
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
let savedDiscoveryAttempted: string | null = null;
let runtimeSelectionBusy = false;
let contextDiscoveryProgress: ContextDiscoveryProgress = { busy: false, modelId: null, stage: '', probeCount: 0 };
const discoveryKey = (modelId: string, contextWindow: number, kvCacheType: 'f16' | 'q8_0', kvOffload: boolean) => `${modelId}:${contextWindow}:${kvCacheType}:${kvOffload ? 'gpu' : 'ram'}`;
function currentDiscoveryHeadroomFits(option: ContextDiscoveryOption, current: RuntimeContextEstimate): boolean {
  const host = resolveContextReserve(process.env.LOCAL_AI_CONTEXT_HOST_RESERVE_BYTES, 'LOCAL_AI_CONTEXT_HOST_RESERVE_BYTES', defaultContextHostReserveBytes);
  if (host.bytes === null) throw new Error(host.error ?? 'Invalid discovery reserve.');
  return !!current.memoryBaseline && !!current.vramBudget && !!option.vramBudget
    && option.measuredHeadroom.hostBytes + current.memoryBaseline.hostAvailableBytes - option.memoryBaseline.hostAvailableBytes >= host.bytes
    && vramBudgetStillFits(option.vramBudget, current.vramBudget);
}
/** Fresh results must stay near their measured baseline; a saved calibration only needs the live fit check below, since more free RAM is never unsafe. */
const hostBaselineStable = (option: ContextDiscoveryOption, current: RuntimeContextEstimate) =>
  option.restored || Math.abs(current.memoryBaseline!.hostAvailableBytes - option.memoryBaseline.hostAvailableBytes) <= 2 * 1024 ** 3;
async function modelFileIdentity(path: string): Promise<string> {
  const file = await stat(path);
  return `${file.dev}:${file.ino}:${file.size}:${file.mtimeMs}`;
}
async function runtimeConfigurationIdentity(modelId: string): Promise<string> {
  const profile = llamaRuntimeProfile(modelId);
  const state = await llamaRuntime.state();
  if (!profile?.modelPath || state.status !== 'ready' || state.modelId !== modelId || !state.serverPid) throw new Error('Discovery configuration is no longer running.');
  const args = (await readFile(`/proc/${state.serverPid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
  const stableArgs: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (['--ctx-size', '-c', '--cache-type-k', '--cache-type-v', '--cache-type-k-draft', '--cache-type-v-draft'].includes(args[i])) { i += 1; continue; }
    stableArgs.push(args[i]);
  }
  return JSON.stringify({ args: stableArgs, model: await modelFileIdentity(profile.modelPath),
    projector: profile.mmprojPath ? await modelFileIdentity(profile.mmprojPath) : null,
    binary: await modelFileIdentity(args[0]), hardLimit: await llamaCapabilityLimit(modelId), speculative: profile.speculative });
}
/** Size and mtime survive restarts and remounts; device/inode numbers may not. */
async function persistentFileFingerprint(path: string): Promise<string> {
  const file = await stat(path);
  return `${file.size}:${file.mtimeMs}`;
}
/** The stable configuration a saved Max Context calibration belongs to; requires the model's launcher-managed server to be running. */
async function persistentDiscoveryIdentity(modelId: string): Promise<{ key: string; serialized: string; hardLimit: number }> {
  const profile = llamaRuntimeProfile(modelId);
  const state = await llamaRuntime.state();
  if (!profile?.modelPath || state.status !== 'ready' || state.modelId !== modelId || !state.serverPid) throw new Error('Saved Max Context requires the model runtime to be running.');
  const args = (await readFile(`/proc/${state.serverPid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
  const hostReserve = resolveContextReserve(process.env.LOCAL_AI_CONTEXT_HOST_RESERVE_BYTES, 'LOCAL_AI_CONTEXT_HOST_RESERVE_BYTES', defaultContextHostReserveBytes);
  if (hostReserve.bytes === null) throw new Error(hostReserve.error ?? 'Invalid discovery reserve.');
  const hardLimit = await llamaCapabilityLimit(modelId);
  const identity = buildContextDiscoveryIdentity({
    modelId, modelFingerprint: await persistentFileFingerprint(profile.modelPath),
    projectorFingerprint: profile.mmprojPath ? await persistentFileFingerprint(profile.mmprojPath) : null,
    runtimeFingerprint: `${args[0]}:${await persistentFileFingerprint(args[0])}`,
    arguments: args, speculative: profile.speculative, hardLimit, gpu: await getGpuIdentity(), hostReserveBytes: hostReserve.bytes,
  });
  return { ...contextDiscoveryKey(identity), hardLimit };
}
/** Saved options never trigger probing; each is still checked against live memory when selected. */
async function loadSavedDiscovery(modelId: string): Promise<{ options: ContextDiscoveryOption[]; hardLimit: number; key: string } | null> {
  try {
    const identity = await persistentDiscoveryIdentity(modelId);
    return { options: database.loadContextDiscoveryOptions(identity.key, modelId, identity.hardLimit), hardLimit: identity.hardLimit, key: identity.key };
  } catch (error) {
    log('context.discovery.saved.unavailable', { modelId, message: error instanceof Error ? error.message : String(error) });
    return null;
  }
}
async function adoptSavedDiscovery(modelId: string, error?: string): Promise<void> {
  discoveredContextOptions.clear();
  const saved = await loadSavedDiscovery(modelId);
  if (!saved) return;
  savedDiscoveryAttempted = modelId;
  if (!saved.options.length) return;
  const configurationId = await runtimeConfigurationIdentity(modelId);
  for (const option of saved.options) discoveredContextOptions.set(discoveryKey(modelId, option.contextWindow, option.kvCacheType, option.kvOffload), { option, modelIdentity: configurationId });
  contextDiscoveryProgress = { busy: false, modelId, stage: 'Сохранённый результат', probeCount: 0, error,
    result: { modelId, probeContextTokens: Math.min(16_384, saved.hardLimit), options: saved.options, unsupported: [], restored: true, hardLimit: saved.hardLimit, configurationId } };
  log('context.discovery.saved.restored', { modelId, options: saved.options.map((option) => ({ contextWindow: option.contextWindow, kvCacheType: option.kvCacheType, kvOffload: option.kvOffload })) });
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
  const llamaProfile = llamaRuntimeProfile(modelId);
  const configuredMaxTokens = profile && llamaProfile ? await llamaCapabilityLimit(modelId) : undefined;
  const contextPresets = profile && llamaProfile ? llamaContextPresets(modelId) : [];
  const hardware = await getHardwareStats();
  let runtime = null;
  let vramBudget: RuntimeContextEstimate['vramBudget'];
  let runtimeArguments: string[] | undefined;
  if (configuredMaxTokens) {
    if (llamaProfile) {
      const current = await llamaRuntime.state();
      if (current.status === 'ready' && current.launcherPid !== undefined && current.modelId === modelId && current.kvCacheType && current.kvOffload !== undefined) {
        await syncLlamaBackend();
        runtime = await llamaCpp.getRuntimeContextEvidence(modelId);
        if (current.serverPid) {
          runtimeArguments = (await readFile(`/proc/${current.serverPid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
          vramBudget = await getOwnedServerVramBudget(current.serverPid);
        }
      }
    }
  }
  const hostReserve = resolveContextReserve(process.env.LOCAL_AI_CONTEXT_HOST_RESERVE_BYTES, 'LOCAL_AI_CONTEXT_HOST_RESERVE_BYTES', defaultContextHostReserveBytes);
  const estimate = await collectRuntimeContextEstimate({
    backend: 'llama-cpp',
    modelId,
    configuredMaxTokens: Math.min(configuredMaxTokens ?? 0, runtime?.modelTrainContextTokens ?? Number.MAX_SAFE_INTEGER),
    contextPresets,
    hardware,
    runtime,
    startupLogPath: process.env.LOCAL_AI_LLAMA_SERVER_LOG ?? join(paths.logs, 'llama-cpp-mtp-server.log'),
    hostReserveBytes: hostReserve.bytes,
    deviceReserveBytes: vramBudget ? vramBudget.freeBytes + vramBudget.llmBytes - vramBudget.availableLlmBytes : defaultContextDeviceReserveBytes,
    reserveErrors: [hostReserve.error].filter((error): error is string => Boolean(error)),
    runtimeArguments,
  });
  if (vramBudget && estimate.allocationEvidence) {
    const loggedDeviceBytes = Object.values(estimate.allocationEvidence.allocations).reduce((sum, allocation) => sum + (allocation.device ?? 0), 0);
    vramBudget = { ...vramBudget, loggedDeviceBytes, unloggedDeviceBytes: vramBudget.llmBytes - loggedDeviceBytes };
  }
  return { ...estimate, vramBudget, memoryHeadroom: estimate.memoryHeadroom && vramBudget
    ? { ...estimate.memoryHeadroom, deviceBytes: vramBudget.freeBytes } : estimate.memoryHeadroom };
}
async function discoverModelContexts(modelId: string): Promise<ContextDiscoveryResult> {
  const profile = llamaRuntimeProfile(modelId);
  if (contextDiscoveryBusy) throw new Error('Max Context discovery is already running.');
  if (runtimeSelectionBusy) throw new Error('Дождитесь завершения переключения runtime.');
  discoveredContextOptions.clear();
  if (!profile) throw new Error('Max Context discovery requires an installed llama.cpp model.');
  contextDiscoveryBusy = true;
  contextDiscoveryProgress = { busy: true, modelId, stage: 'Подготовка; llama.cpp будет перезапущен несколько раз…', probeCount: 0 };
  let original: LlamaRuntimeState | null = null;
  try {
    if (activeGenerations.size) throw new Error('Остановите генерацию перед измерением Max Context.');
    original = await llamaRuntime.state();
    if (original.status !== 'ready' || original.launcherPid === undefined || !original.serverPid || !original.modelId || original.contextWindow === null || !original.kvCacheType || original.kvOffload === undefined) {
      throw new Error('Для безопасного discovery требуется работающий launcher-managed llama.cpp runtime с подтверждёнными KV-настройками.');
    }
    if (original.modelId !== modelId) throw new Error('Выберите и загрузите модель перед Max Context discovery.');
    const prior = original;
    const offload = original.kvOffload;
    const configurationId = await runtimeConfigurationIdentity(modelId);
    const hardLimit = await llamaCapabilityLimit(modelId);
    const initialEstimate = await estimateModelContext(modelId);
    const baseHeadroom = predictContextHeadroom([initialEstimate], Math.min(16_384, hardLimit));
    if (initialEstimate.status !== 'estimated' || !initialEstimate.memoryBaseline || !baseHeadroom || !initialEstimate.observedContextTokens || !initialEstimate.allocationEvidence) throw new Error('Нет полной allocation evidence для безопасного базового запуска.');
    const precisionExpansion = initialEstimate.activeKvCacheType === 'q8_0'
      ? Object.values(initialEstimate.allocationEvidence.allocations.kv).reduce((sum, value) => sum + (value ?? 0), 0)
        + Object.values(initialEstimate.allocationEvidence.allocations.speculativeKv).reduce((sum, value) => sum + (value ?? 0), 0)
      : 0;
    if (baseHeadroom.deviceBytes - (offload ? precisionExpansion : 0) < vramProbeGuardBytes
      || baseHeadroom.hostBytes - (offload ? 0 : precisionExpansion) < 4.25 * 1024 ** 3) throw new Error('Недостаточно свежей свободной памяти для безопасного базового FP16 probe.');
    const hostReserve = resolveContextReserve(process.env.LOCAL_AI_CONTEXT_HOST_RESERVE_BYTES, 'LOCAL_AI_CONTEXT_HOST_RESERVE_BYTES', defaultContextHostReserveBytes);
    if (hostReserve.bytes === null) throw new Error(hostReserve.error);
    const result = await discoverContextBoundary({
      modelId, hardLimit, kvOffload: offload, hostReserveBytes: hostReserve.bytes, deviceReserveBytes: 0,
      progress: (stage, probeCount) => { contextDiscoveryProgress = { busy: true, modelId, stage, probeCount }; },
      probe: async (contextWindow, kvCacheType, phase): Promise<DiscoveryProbe> => {
        const started = Date.now();
        const record: DiscoveryProbe['record'] = { contextWindow, kvCacheType, phase, startup: false, health: false, inference: false, fits: false, headroom: null, memoryBaseline: null, elapsedMs: 0 };
        let estimate: RuntimeContextEstimate | null = null;
        try {
          const switched = await llamaRuntime.switchTo(modelId, contextWindow, kvCacheType, offload);
          if (!switched.ok) {
            if (switched.state.status !== 'ready') throw new Error(`Discovery rollback failed: ${switched.error}`);
            record.reason = switched.error;
            return { record, estimate };
          }
          record.startup = true;
          const state = await syncLlamaBackend();
          if (state.status !== 'ready' || !state.serverPid) throw new Error('Probe server is not alive/healthy.');
          process.kill(state.serverPid, 0);
          record.args = (await readFile(`/proc/${state.serverPid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
          record.health = (await llamaCpp.getStatus()).available;
          if (!record.health) throw new Error('Probe health check failed.');
          await verifyContextProbeInference(modelId);
          record.inference = true;
          process.kill(state.serverPid, 0);
          estimate = await estimateModelContext(modelId);
          record.headroom = estimate.memoryHeadroom;
          record.memoryBaseline = estimate.memoryBaseline;
          record.vramBudget = estimate.vramBudget;
          record.hardware = await getHardwareStats();
          if (estimate.status !== 'estimated') record.reason = estimate.unknownReasons.join('; ');
          return { record, estimate };
        } catch (error) {
          record.reason = error instanceof Error ? error.message : String(error);
          if ((await llamaRuntime.state()).status !== 'ready') throw error;
          return { record, estimate };
        } finally {
          record.elapsedMs = Date.now() - started;
          log('context.discovery.probe', record);
        }
      },
      restore: async () => {
        const restore = await llamaRuntime.switchTo(prior.modelId!, prior.contextWindow!, prior.kvCacheType!, prior.kvOffload!);
        if (!restore.ok) throw new Error(`Max Context discovery could not restore the prior runtime: ${restore.error}`);
        await syncLlamaBackend();
      },
    });
    // Identity excludes context/cache mode, so choosing an option does not
    // invalidate the sibling mode. Model/draft/projector/backend args do.
    result.configurationId = await runtimeConfigurationIdentity(modelId);
    if (result.configurationId !== configurationId) throw new Error('Runtime/model/draft configuration changed during discovery.');
    // Only a completed discovery reaches here; its options replace the saved value for their KV mode.
    // A KV mode this run did not establish keeps its last successful saved value.
    let saved: ContextDiscoveryOption[] = [];
    try {
      const identity = await persistentDiscoveryIdentity(modelId);
      database.saveContextDiscoveryOptions(identity.key, identity.serialized, result.options);
      saved = database.loadContextDiscoveryOptions(identity.key, modelId, identity.hardLimit);
      log('context.discovery.saved', { modelId, options: result.options.map((option) => ({ contextWindow: option.contextWindow, kvCacheType: option.kvCacheType })) });
    } catch (error) {
      log('context.discovery.save.failed', { modelId, message: error instanceof Error ? error.message : String(error) });
    }
    result.options = mergeSavedDiscoveryOptions(result.options, saved);
    for (const option of result.options) discoveredContextOptions.set(discoveryKey(modelId, option.contextWindow, option.kvCacheType, option.kvOffload), { option, modelIdentity: result.configurationId });
    savedDiscoveryAttempted = modelId;
    contextDiscoveryProgress = { busy: false, modelId, stage: 'Готово', probeCount: result.probes?.length ?? 0, result };
    return result;
  } catch (error) {
    discoveredContextOptions.clear();
    const message = error instanceof Error ? error.message : String(error);
    contextDiscoveryProgress = { busy: false, modelId, stage: 'Discovery не завершён', probeCount: contextDiscoveryProgress.probeCount, error: message };
    // A failed or interrupted run leaves the previously saved result untouched and selectable.
    await adoptSavedDiscovery(modelId, message).catch(() => undefined);
    throw error;
  } finally {
    contextDiscoveryBusy = false;
  }
}
async function verifyContextProbeInference(modelId: string): Promise<void> {
  const url = process.env.LOCAL_AI_LLAMA_CPP_URL ?? 'http://127.0.0.1:8081';
  const response = await fetch(`${url.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'What is 1 + 1? Reply with exactly 2 and no explanation.' }], max_tokens: 128, temperature: 0, chat_template_kwargs: { enable_thinking: false }, stream: false }),
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
  if (!discoveredContextOptions.size && !contextDiscoveryBusy) await adoptSavedDiscovery(modelId).catch(() => undefined);
  const cachedOptions = [...discoveredContextOptions.values()];
  const option = findFreshContextDiscoveryOption(cachedOptions.map((item) => item.option), { modelId, contextWindow, kvCacheType, kvOffload });
  if (!option) throw new Error('Max Context discovery is missing, stale, or does not validate this KV configuration and context; run Discover again.');
  const cached = cachedOptions.find((item) => item.option === option);
  if (!cached || await runtimeConfigurationIdentity(modelId) !== cached.modelIdentity) throw new Error('Runtime/model/draft configuration changed since discovery; run Discover again.');
  const current = await estimateModelContext(modelId);
  if (current.status !== 'estimated' || !current.memoryBaseline || current.observedContextTokens === null) throw new Error('Current runtime memory evidence is unavailable; run Discover again.');
  if (!hostBaselineStable(option, current) || !currentDiscoveryHeadroomFits(option, current)) {
    throw new Error('Available memory changed materially since discovery; run Discover again before selecting this context.');
  }
}
async function discoveryStatus(_event?: unknown, requestedModelId?: string): Promise<ContextDiscoveryProgress> {
  if (contextDiscoveryBusy || runtimeSelectionBusy || activeGenerations.size) return contextDiscoveryProgress;
  if (typeof requestedModelId === 'string' && requestedModelId && savedDiscoveryAttempted !== requestedModelId && !contextDiscoveryProgress.error) {
    if (contextDiscoveryProgress.modelId !== requestedModelId) contextDiscoveryProgress = { busy: false, modelId: requestedModelId, stage: '', probeCount: 0 };
    if (!contextDiscoveryProgress.result) await adoptSavedDiscovery(requestedModelId).catch(() => undefined);
  }
  if (!contextDiscoveryProgress.result) return contextDiscoveryProgress;
  const result = contextDiscoveryProgress.result;
  try {
    if (!result.configurationId || await runtimeConfigurationIdentity(result.modelId) !== result.configurationId) throw new Error('Модель/runtime/draft изменились; повторите discovery.');
    const estimate = await estimateModelContext(result.modelId);
    // Saved options stay listed under memory pressure; selecting one re-runs these same checks.
    const measured = result.options.filter((option) => !option.restored);
    if (measured.length && (!estimate.memoryBaseline || measured.some((option) => !findFreshContextDiscoveryOption([option], option)
      || !hostBaselineStable(option, estimate)
      || !currentDiscoveryHeadroomFits(option, estimate)))) {
      throw new Error('Ресурсы существенно изменились или результат устарел; повторите discovery.');
    }
    if (contextDiscoveryProgress.result === result && !contextDiscoveryBusy && !runtimeSelectionBusy) {
      contextDiscoveryProgress = { ...contextDiscoveryProgress, currentVramBudget: estimate.vramBudget };
    }
  } catch (error) {
    if (contextDiscoveryProgress.result !== result || contextDiscoveryBusy || runtimeSelectionBusy) return contextDiscoveryProgress;
    discoveredContextOptions.clear();
    if (result.options.every((option) => option.restored)) {
      // A saved calibration is never discarded by a transient runtime state; it is re-adopted once the runtime matches again.
      savedDiscoveryAttempted = null;
      contextDiscoveryProgress = { busy: false, modelId: result.modelId, stage: '', probeCount: 0 };
      return contextDiscoveryProgress;
    }
    contextDiscoveryProgress = { busy: false, modelId: result.modelId, stage: 'Результат недействителен', probeCount: 0, error: error instanceof Error ? error.message : String(error) };
  }
  return contextDiscoveryProgress;
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
  log('runtime.shutdown.started', { backend: 'llama-cpp', activeGenerations: active.length });
  for (const generation of active) generation.abort.abort();
  await Promise.allSettled(active.map((generation) => waitFor(generation.settled, 4_000)));
  log('runtime.shutdown.finished', { backend: 'llama-cpp' });
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

export function registerIpc(): void {
  const interruptedRuns = database.recoverInterruptedRuns();
  if (interruptedRuns) log('generation.interrupted-recovered', { runs: interruptedRuns });
  ipcMain.handle('conversations:list', () => database.listConversations());
  ipcMain.handle('conversations:create', async (_event, requestedModelId?: string) => {
    const modelId = requestedModelId ?? (await currentLlamaRuntime()).modelId ?? llamaRuntimeModelId;
    if (!getModelProfile(modelId)) throw new Error('Выбранная модель отсутствует в реестре приложения');
    return database.createConversation(modelId);
  });
  ipcMain.handle('conversations:update', async (_event, id: string, patch: Partial<Pick<Conversation, 'title' | 'modelId' | 'mode' | 'workingDirectory' | 'secondaryWorkingDirectory' | 'contextWindow' | 'llamaKvCacheType' | 'llamaKvOffload' | 'reasoningMode' | 'webMode'>>) => {
    // Reasoning/mode/web/project/title changes never touch llama.cpp, so they must not queue behind
    // (or be refused by) a runtime switch: a refusal made the UI roll the user's choice back.
    if (!touchesRuntime(patch)) {
      if (activeGenerations.size && Object.keys(patch).some((key) => key !== 'title')) throw new Error('Дождитесь завершения активной генерации перед изменением настроек.');
      const existing = database.getConversation(id);
      if (!existing) throw new Error('Чат не найден');
      const stored = database.updateConversation(id, patch);
      if ((patch.workingDirectory !== undefined && patch.workingDirectory !== existing.workingDirectory) || (patch.secondaryWorkingDirectory !== undefined && patch.secondaryWorkingDirectory !== existing.secondaryWorkingDirectory)) sessionApprovals.delete(id);
      return database.getConversation(id) ?? stored;
    }
    if (contextDiscoveryBusy) throw new Error('Дождитесь завершения Max Context discovery перед изменением настроек runtime.');
    if (runtimeSelectionBusy) throw new Error('Дождитесь завершения переключения runtime.');
    runtimeSelectionBusy = true;
    try {
    if (activeGenerations.size && Object.keys(patch).some((key) => key !== 'title')) throw new Error('Дождитесь завершения активной генерации перед изменением настроек.');
    const current = database.getConversation(id);
    if (!current) throw new Error('Чат не найден');
    const nextModelId = patch.modelId ?? current.modelId;
    const profile = nextModelId ? getModelProfile(nextModelId) : undefined;
    if (nextModelId && !profile) throw new Error('Выбранная модель отсутствует в реестре приложения');
    const capability = profile ? await llamaCapabilityLimit(nextModelId ?? '') : 0;
    const allowed = profile ? llamaContextPresets(nextModelId ?? '', capability) : [];
    const requestedContext = patch.contextWindow ?? current.contextWindow;
    const modelChanged = nextModelId !== current.modelId;
    const contextWindow = modelChanged && patch.contextWindow === undefined && allowed.length ? normalContextForModel(requestedContext, allowed) : requestedContext;
    if (allowed.length && !allowed.includes(contextWindow)) {
      if (contextWindow % 4_096 !== 0 || contextWindow > capability || contextWindow <= 0) {
        throw new Error(`Requested context ${contextWindow} is outside the model/backend capability or runtime bucket size.`);
      }
    }
    if (nextModelId && profile) {
      const isRuntimeRequest = patch.modelId !== undefined || patch.contextWindow !== undefined || patch.llamaKvCacheType !== undefined || patch.llamaKvOffload !== undefined;
      const { llamaKvCacheType: kvCacheType, llamaKvOffload: kvOffload } = resolveLlamaKvSelection(current, patch, modelChanged);
      const requiresDiscovery = !allowed.includes(contextWindow) || kvCacheType !== defaultLlamaKv.llamaKvCacheType || kvOffload !== defaultLlamaKv.llamaKvOffload;
      if (isRuntimeRequest && requiresDiscovery) await validateDiscoveredOption(nextModelId, contextWindow, kvCacheType, kvOffload);
      patch = { ...patch, llamaKvCacheType: kvCacheType, llamaKvOffload: kvOffload };
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
      if (modelChanged) {
        discoveredContextOptions.clear();
        savedDiscoveryAttempted = null;
        contextDiscoveryProgress = { busy: false, modelId: nextModelId, stage: '', probeCount: 0 };
      }
    }
    const updated = database.updateConversation(id, { ...patch, contextWindow });
    if ((patch.workingDirectory !== undefined && patch.workingDirectory !== current.workingDirectory) || (patch.secondaryWorkingDirectory !== undefined && patch.secondaryWorkingDirectory !== current.secondaryWorkingDirectory)) sessionApprovals.delete(id);
    if (patch.modelId !== undefined && patch.modelId !== current.modelId) database.setContextUsage(id, null, null);
    return database.getConversation(id) ?? updated;
    } finally {
      runtimeSelectionBusy = false;
    }
  });
  ipcMain.handle('conversations:delete', async (_event, id: string) => {
    if (activeGenerations.has(id)) throw new Error('Нельзя удалить чат с активной генерацией.');
    sessionApprovals.delete(id); await attachments.removeManagedFiles(database.deleteConversation(id));
    await discardAgentEvidence(paths.userData, id);
  });
  ipcMain.handle('messages:list', (_event, conversationId: string) => database.listMessages(conversationId));
  ipcMain.handle('agent-plan:get', (_event, conversationId: string) => database.getAgentPlan(conversationId));
  ipcMain.handle('messages:edit', async (_event, messageId: string, content: string, fallback?: { conversationId: string; content: string }) => {
    if (activeGenerations.size) throw new Error('Дождитесь завершения активной генерации перед редактированием.');
    const message = database.getMessage(messageId) ?? (fallback ? database.findUserMessage(fallback.conversationId, fallback.content) : null); if (!message) throw new Error('Сообщение не найдено');
    const before = database.listAttachmentsForConversation(message.conversationId);
    await cancelGeneration(message.conversationId); const edited = database.editUserMessageAndTruncate(message.id, content);
    await discardAgentEvidence(paths.userData, message.conversationId);
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
    await discardAgentEvidence(paths.userData, message.conversationId);
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
    catch (error) { log('backend.models.failed', { backend: 'llama-cpp', message: error instanceof Error ? error.message : String(error) }); return []; }
  });
  ipcMain.handle('settings:get', async () => {
    const llama = await syncLlamaBackend();
    return { llamaServerPath: process.env.LOCAL_AI_LLAMA_SERVER_PATH ?? null, llamaRuntimeModelId: llama.modelId ?? undefined, llamaRuntime: llama, modelsPath: paths.models };
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
  ipcMain.handle('context:discovery-status', discoveryStatus);
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
    if (contextDiscoveryBusy) throw new Error('Дождитесь завершения Max Context discovery перед генерацией.');
    if (runtimeSelectionBusy) throw new Error('Дождитесь завершения переключения runtime перед генерацией.');
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
    // Runtime capabilities govern routing for every image turn in the active
    // history, rather than guessing from model names.
    const hasImages = database.listAttachmentsForConversation(request.conversationId).some((attachment) => attachment.kind === 'image');
    const requestUser = user ?? [...request.messages].reverse().find((message) => message.role === 'user');
    const retryAttachmentIds = requestUser ? database.listAttachments(requestUser.id).filter((attachment) => attachment.status === 'pending' || attachment.status === 'cancelled').map((attachment) => attachment.id) : [];
    const nativeImagesRequested = attachmentPipeline.hasNativeImagesForRequest(request.messages);
    const nativeVision = nativeImagesRequested && await backend.supportsVision(request.model);
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
      // Image descriptions are excluded for native-vision requests: the original
      // image payload is attached only to its owning user turn below.
      let history = attachmentPipeline.buildContext(request.messages, !hasImages);
      if (nativeVision) history = await attachmentPipeline.prepareNativeImages(history, abort.signal);
      const persistedTaskMemory = mode === 'agent' ? taskPlan(database.getAgentPlan(request.conversationId) ?? {}).taskMemory : undefined;
      const agentSupportsReasoning = mode === 'agent' && llamaCpp.supportsReasoning(request.model);
      const stream = mode === 'agent'
        ? rustAgent.stream(request.model, history, agentProjects, abort.signal, context.active, conversation.reasoningMode, conversation.webMode, generation.id, persistedTaskMemory, request.conversationId, agentSupportsReasoning, llamaRuntimeProfile(request.model)?.reasoningOptions)
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
      log('generation.failed', { generationId: generation.id, conversationId: request.conversationId, model: request.model, message: error instanceof Error ? error.message : String(error) });
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
