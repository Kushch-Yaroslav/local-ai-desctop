import { useEffect, useState } from 'react';
import { FolderOpen, X } from 'lucide-react';
import { useAppStore } from '../store/app-store';
import { Hardware } from './Hardware';
import { projectDirectoryName } from '../../shared/project-references';
import type { ContextDiscoveryResult, RuntimeContextEstimate } from '../../shared/context-estimator';

export function Toolbar() {
  const { conversations, activeId, models, hardware, settings, activeContextWindow, isGenerating, updateConversation, refreshRuntime } = useAppStore();
  const [estimateResponse, setEstimateResponse] = useState<{ modelId: string; value?: RuntimeContextEstimate; error?: string } | null>(null);
  const [discovery, setDiscovery] = useState<ContextDiscoveryResult | null>(null);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const pollsRuntime = settings?.selectedBackend === 'llama-cpp';
  useEffect(() => {
    if (!pollsRuntime) return undefined;
    const timer = window.setInterval(() => void refreshRuntime(), 4_000);
    return () => window.clearInterval(timer);
  }, [pollsRuntime, refreshRuntime]);
  const chat = conversations.find((item) => item.id === activeId);
  const selectedModel = models.find((model) => model.id === chat?.modelId) ?? models[0];
  const selectedModelId = chat ? chat.modelId ?? selectedModel?.id ?? null : null;
  useEffect(() => {
    if (!selectedModelId) { setEstimateResponse(null); return undefined; }
    let current = true;
    setEstimateResponse((prior) => prior?.modelId === selectedModelId ? prior : { modelId: selectedModelId });
    setDiscovery(null);
    setDiscoveryError(null);
    void window.localAi.contextEstimate(selectedModelId)
      .then((value) => { if (current) setEstimateResponse({ modelId: selectedModelId, value }); })
      .catch((error: unknown) => { if (current) setEstimateResponse({ modelId: selectedModelId, error: error instanceof Error ? error.message : String(error) }); });
    return () => { current = false; };
  }, [selectedModelId, settings?.selectedBackend, settings?.llamaRuntime?.status, settings?.llamaRuntime?.modelId, settings?.llamaRuntime?.contextWindow, settings?.llamaRuntime?.kvCacheType, settings?.llamaRuntime?.kvOffload]);
  if (!chat) return null;
  const chooseDirectory = async (slot: 1 | 2, currentDirectory: string | null) => { const directory = await window.localAi.dialog.chooseDirectory(currentDirectory); if (directory) await updateConversation(chat.id, slot === 1 ? { workingDirectory: directory } : { secondaryWorkingDirectory: directory }); };
  const contextLabel = `${Math.round((activeContextWindow ?? chat.contextWindow) / 1024)}K`;
  const contextEstimate = estimateResponse?.modelId === selectedModelId ? estimateResponse.value : undefined;
  const projectSelector = (slot: 1 | 2, directory: string | null) => <div className={`directory project-selector project-${slot}`}><FolderOpen size={16} /><button title={directory ?? undefined} onClick={() => void chooseDirectory(slot, directory)}>{directory ? projectDirectoryName(directory) : `Project ${slot}: не выбран`}</button>{directory && <button className="icon-button" aria-label={`Убрать Project ${slot}`} onClick={() => void updateConversation(chat.id, slot === 1 ? { workingDirectory: null } : { secondaryWorkingDirectory: null })}><X size={14} /></button>}</div>;
  const llama = settings?.llamaRuntime;
  const runtimeLabel = settings?.selectedBackend !== 'llama-cpp' ? 'Ollama'
    : !llama || llama.status === 'ready' ? settings.llamaRuntimeModelId === 'gpt-oss:20b' ? 'llama.cpp · EAGLE-3' : settings.llamaRuntimeModelId === 'qwen3.8:27b-q4_K_M' ? 'llama.cpp · MTP' : 'llama.cpp'
      : llama.status === 'switching' || llama.status === 'starting' ? 'llama.cpp · запуск модели…'
        : 'llama.cpp · не запущен';
  const missingEstimate = contextEstimate?.unknownReasons.join(', ') ?? '';
  const estimateLoading = Boolean(selectedModelId && (estimateResponse?.modelId !== selectedModelId || (!estimateResponse.value && !estimateResponse.error)));
  const discoveryForModel = discovery?.modelId === selectedModelId ? discovery : undefined;
  const maxContextLabel = discoveryLoading ? 'измеряется…' : discoveryForModel?.options.length
    ? discoveryForModel.options.map((option) => `${option.kvCacheType.toUpperCase()} ${option.contextWindow / 1024}K`).join(' · ')
    : 'не измерен';
  const actualRuntimeContext = contextEstimate?.observedContextTokens
    ?? (llama?.status === 'ready' && llama.modelId === chat.modelId ? llama.contextWindow : null);
  const contextOptions = (() => {
    const cacheType = chat.llamaKvCacheType ?? 'f16';
    const kvOffload = chat.llamaKvOffload ?? true;
    const modeMaximum = discoveryForModel?.options.find((option) => option.kvCacheType === cacheType && option.kvOffload === kvOffload)?.contextWindow ?? 32_768;
    const options = (selectedModel?.supportedContextPresets ?? []).filter((contextWindow) => contextWindow <= modeMaximum).map((contextWindow) => ({
      contextWindow, kvCacheType: cacheType, kvOffload,
      label: `${Math.round(contextWindow / 1024)}K`,
    }));
    for (const option of discoveryForModel?.options ?? []) {
      const found = options.find((candidate) => candidate.contextWindow === option.contextWindow
        && candidate.kvCacheType === option.kvCacheType && candidate.kvOffload === option.kvOffload);
      const label = `${option.contextWindow / 1024}K · Max Context (${option.kvCacheType.toUpperCase()})`;
      if (found) found.label = label;
      else options.push({ ...option, label });
    }
    if (!options.some((option) => option.contextWindow === chat.contextWindow
      && option.kvCacheType === cacheType && option.kvOffload === kvOffload)) {
      options.push({ contextWindow: chat.contextWindow, kvCacheType: cacheType, kvOffload, label: `${Math.round(chat.contextWindow / 1024)}K · текущий` });
    }
    return options;
  })();
  const selectedContextOption = contextOptions.find((option) => option.contextWindow === chat.contextWindow
    && option.kvCacheType === (chat.llamaKvCacheType ?? 'f16') && option.kvOffload === (chat.llamaKvOffload ?? true));
  const discoverMaximum = async () => {
    if (!selectedModelId) return;
    setDiscoveryLoading(true);
    setDiscoveryError(null);
    try { setDiscovery(await window.localAi.contextDiscover(selectedModelId)); }
    catch (error) { setDiscoveryError(error instanceof Error ? error.message : String(error)); }
    finally { setDiscoveryLoading(false); }
  };
  return (
    <header className="toolbar">
      <div className="monitoring-row" aria-label="Мониторинг runtime">
        <Hardware value={hardware} />
        <span className="backend-indicator">{runtimeLabel}</span>
        {settings?.selectedBackend === 'llama-cpp' && <button className="context-discover" disabled={discoveryLoading || !selectedModelId || isGenerating} onClick={() => void discoverMaximum()}>{discoveryLoading ? 'Идёт проверка…' : 'Найти Max Context'}</button>}
        <details className="context-estimate">
          <summary>Max Context: {settings?.selectedBackend === 'llama-cpp' ? maxContextLabel : 'runtime не измеряет KV'}</summary>
          <div className="context-estimate-details">
            <p>Max Context — наибольшее кратное 4K окно, которое discovery консервативно рассчитало, затем реально запустило с выбранным KV и проверило через health check и inference. В расчёте учтены веса/KV allocations, MTP/draft, слоты, свободные VRAM/RAM и резервы. Выберите найденный вариант как обычный пункт «Контекст».</p>
            <p><span>Найдено</span><b>{maxContextLabel}</b></p>
            <p><span>Активное окно</span><b>{actualRuntimeContext ? `${Math.round(actualRuntimeContext / 1024)}K` : 'runtime не загружен'}</b></p>
            {discoveryForModel?.options.map((option) => <p key={`${option.kvCacheType}-${option.contextWindow}`}><span>{option.kvCacheType.toUpperCase()} · запас после inference</span><b>RAM {Math.round(option.measuredHeadroom.hostBytes / 1024 ** 3 * 10) / 10} GiB · VRAM {Math.round(option.measuredHeadroom.deviceBytes / 1024 ** 3 * 10) / 10} GiB</b></p>)}
            {discoveryError && <small>Discovery не завершён: {discoveryError}</small>}
            {discoveryForModel?.unsupported.map((item) => <small key={item.kvCacheType}>{item.kvCacheType.toUpperCase()} не предложен: {item.reason}</small>)}
            <details><summary>Диагностика</summary>
              <p><span>Предел модели/runtime</span><b>{contextEstimate?.configuredMaxTokens ? `${Math.round(contextEstimate.configuredMaxTokens / 1024)}K` : selectedModel ? `${Math.round(selectedModel.maxContext / 1024)}K` : 'неизвестен'}</b></p>
              {contextEstimate?.modelTrainContextTokens !== null && contextEstimate?.modelTrainContextTokens !== undefined && <p><span>Metadata train limit</span><b>{Math.round(contextEstimate.modelTrainContextTokens / 1024)}K</b></p>}
              {contextEstimate?.allocationEvidence && <p><span>Фактический KV</span><b>{contextEstimate.allocationEvidence.kvTypeK ?? 'unknown'} / {contextEstimate.allocationEvidence.kvTypeV ?? 'unknown'}; слоты {contextEstimate.allocationEvidence.sequenceSlots ?? '?'}, draft {contextEstimate.allocationEvidence.speculativeSlots ?? '?'}</b></p>}
              <small>{estimateLoading ? 'Обновление runtime данных…' : estimateResponse?.error ? `Не удалось получить метаданные: ${estimateResponse.error}.` : missingEstimate ? `Нет полной активной allocation evidence: ${missingEstimate}.` : discoveryForModel?.restored ? `Измерено при ${discoveryForModel.probeContextTokens / 1024}K; runtime восстановлен.` : 'Максимум не рассчитан до явного discovery.'}</small>
            </details>
          </div>
        </details>
      </div>
      <div className="toolbar-controls">
        <label className="control"><span>Модель</span><select value={chat.modelId ?? ''} onChange={(event) => void updateConversation(chat.id, { modelId: event.target.value || null }).catch(() => undefined)}><option value="">Выберите модель</option>{models.map((model) => <option value={model.id} key={model.id} disabled={!model.installed}>{model.name}{model.installed ? '' : ' · не установлена'}</option>)}</select></label>
        <label className="control"><span>Контекст · {contextLabel}</span><select value={selectedContextOption ? `${selectedContextOption.contextWindow}:${selectedContextOption.kvCacheType}:${selectedContextOption.kvOffload ? 'gpu' : 'ram'}` : ''} onChange={(event) => { const [contextWindow, kvCacheType, placement] = event.target.value.split(':'); if (contextWindow) void updateConversation(chat.id, { contextWindow: Number(contextWindow), ...(settings?.selectedBackend === 'llama-cpp' ? { llamaKvCacheType: kvCacheType as 'f16' | 'q8_0', llamaKvOffload: placement === 'gpu' } : {}) }).catch(() => undefined); }}>{contextOptions.map((option) => <option value={`${option.contextWindow}:${option.kvCacheType}:${option.kvOffload ? 'gpu' : 'ram'}`} key={`${option.contextWindow}:${option.kvCacheType}:${option.kvOffload ? 'gpu' : 'ram'}`}>{option.label}</option>)}</select></label>
        {selectedModel?.supportsReasoning && <label className="control"><span>Рассуждение</span><select value={chat.reasoningMode === 'deep' ? 'deep' : 'fast'} onChange={(event) => void updateConversation(chat.id, { reasoningMode: event.target.value as 'fast' | 'deep' })}><option value="fast">Быстро</option><option value="deep">Глубоко</option></select></label>}
        <label className="control"><span>Web</span><select value={chat.webMode} onChange={(event) => void updateConversation(chat.id, { webMode: event.target.value as 'off' | 'auto' })}><option value="off">Off</option><option value="auto">Auto</option></select></label>
        <label className="control"><span>Режим</span><select value={chat.mode} onChange={(event) => void updateConversation(chat.id, { mode: event.target.value as 'chat' | 'agent' })}><option value="chat">Чат</option><option value="agent">Агент</option></select></label>
        <div className="project-selectors">{projectSelector(1, chat.workingDirectory)}{projectSelector(2, chat.secondaryWorkingDirectory)}</div>
      </div>
    </header>
  );
}
