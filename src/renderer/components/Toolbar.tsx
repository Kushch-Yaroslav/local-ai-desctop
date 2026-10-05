import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { FolderOpen, X } from 'lucide-react';
import { useAppStore } from '../store/app-store';
import { Hardware } from './Hardware';
import { projectDirectoryName } from '../../shared/project-references';
import type { ContextDiscoveryResult, RuntimeContextEstimate } from '../../shared/context-estimator';
import { buildContextChoices, cacheModeLabel, contextChoiceId } from '../../shared/context-options';
import { boundaryReasonLabel, reasoningControlText, reasoningEffortLabel, reasoningModeLabel, thinkingLabel } from '../../shared/localization';
import { resolveReasoningSelection, type ReasoningEffort } from '../../shared/reasoning-controls';

export function Toolbar() {
  const { conversations, activeId, models, hardware, settings, activeContextWindow, isGenerating, updateConversation, refreshRuntime } = useAppStore(useShallow((state) => ({ conversations: state.conversations, activeId: state.activeId, models: state.models, hardware: state.hardware, settings: state.settings, activeContextWindow: state.activeContextWindow, isGenerating: state.isGenerating, updateConversation: state.updateConversation, refreshRuntime: state.refreshRuntime })));
  const [estimateResponse, setEstimateResponse] = useState<{ modelId: string; value?: RuntimeContextEstimate; error?: string } | null>(null);
  const [discovery, setDiscovery] = useState<ContextDiscoveryResult | null>(null);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [discoveryStage, setDiscoveryStage] = useState('');
  const [currentVramBudget, setCurrentVramBudget] = useState<import('../../shared/vram-budget').VramBudget | undefined>();
  useEffect(() => {
    const timer = window.setInterval(() => void refreshRuntime(), 4_000);
    return () => window.clearInterval(timer);
  }, [refreshRuntime]);
  const chat = conversations.find((item) => item.id === activeId);
  const selectedModel = models.find((model) => model.id === chat?.modelId) ?? models[0];
  const reasoningCapability = selectedModel?.reasoning;
  const reasoningSelection = resolveReasoningSelection(reasoningCapability, chat?.reasoningMode ?? 'fast', chat ?? {});
  const selectedModelId = chat ? chat.modelId ?? selectedModel?.id ?? null : null;
  useEffect(() => {
    if (!selectedModelId) { setEstimateResponse(null); return undefined; }
    let current = true;
    setEstimateResponse((prior) => prior?.modelId === selectedModelId ? prior : { modelId: selectedModelId });
    void window.localAi.contextEstimate(selectedModelId)
      .then((value) => { if (current) setEstimateResponse({ modelId: selectedModelId, value }); })
      .catch((error: unknown) => { if (current) setEstimateResponse({ modelId: selectedModelId, error: error instanceof Error ? error.message : String(error) }); });
    return () => { current = false; };
  }, [selectedModelId, settings?.llamaRuntime?.status, settings?.llamaRuntime?.modelId, settings?.llamaRuntime?.contextWindow, settings?.llamaRuntime?.kvCacheType, settings?.llamaRuntime?.kvOffload]);
  useEffect(() => {
    setDiscovery(null);
    setDiscoveryError(null);
    setCurrentVramBudget(undefined);
  }, [selectedModelId]);
  useEffect(() => {
    let current = true;
    const poll = async () => {
      try {
        const progress = await window.localAi.contextDiscoveryStatus(selectedModelId);
        if (!current) return;
        setDiscoveryLoading(progress.busy);
        setDiscoveryStage(progress.busy ? `${progress.stage} · проверка ${progress.probeCount}` : '');
        if (progress.modelId === selectedModelId) {
          setDiscovery(progress.result ?? null);
          setDiscoveryError(progress.error ?? null);
          setCurrentVramBudget(progress.currentVramBudget);
        }
      } catch (error) {
        if (current) setDiscoveryError(error instanceof Error ? error.message : String(error));
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2_000);
    return () => { current = false; window.clearInterval(timer); };
  }, [selectedModelId]);
  if (!chat) return null;
  const chooseDirectory = async (slot: 1 | 2, currentDirectory: string | null) => { const directory = await window.localAi.dialog.chooseDirectory(currentDirectory); if (directory) await updateConversation(chat.id, slot === 1 ? { workingDirectory: directory } : { secondaryWorkingDirectory: directory }); };
  const contextLabel = `${Math.round((activeContextWindow ?? chat.contextWindow) / 1024)}K`;
  const contextEstimate = estimateResponse?.modelId === selectedModelId ? estimateResponse.value : undefined;
  const projectSelector = (slot: 1 | 2, directory: string | null) => <div className={`directory project-selector project-${slot}`}><FolderOpen size={16} /><button title={directory ?? undefined} onClick={() => void chooseDirectory(slot, directory)}>{directory ? projectDirectoryName(directory) : `Проект ${slot}: не выбран`}</button>{directory && <button className="icon-button" aria-label={`Убрать проект ${slot}`} onClick={() => void updateConversation(chat.id, slot === 1 ? { workingDirectory: null } : { secondaryWorkingDirectory: null })}><X size={14} /></button>}</div>;
  const llama = settings?.llamaRuntime;
  const runtimeLabel = !llama || llama.status === 'ready' ? `llama.cpp${llama?.speculativeMode === 'mtp' ? ' · MTP' : llama?.speculativeMode === 'eagle3' ? ' · EAGLE3' : ''}`
      : llama.status === 'switching' || llama.status === 'starting' ? 'llama.cpp · запуск модели…'
        : 'llama.cpp · не запущен';
  const missingEstimate = contextEstimate?.unknownReasons.join(', ') ?? '';
  const estimateLoading = Boolean(selectedModelId && (estimateResponse?.modelId !== selectedModelId || (!estimateResponse.value && !estimateResponse.error)));
  const discoveryForModel = discovery?.modelId === selectedModelId ? discovery : undefined;
  const maxContextLabel = discoveryLoading ? 'измеряется…' : discoveryForModel?.options.length
    ? discoveryForModel.options.map((option) => `${cacheModeLabel(option.kvCacheType)} ${option.contextWindow / 1024}K${option.restored ? ' (сохранено)' : ''}`).join(' · ')
    : 'не измерен';
  const actualRuntimeContext = contextEstimate?.observedContextTokens
    ?? (llama?.status === 'ready' && llama.modelId === chat.modelId ? llama.contextWindow : null);
  const contextOptions = (() => {
    const cacheType = chat.llamaKvCacheType ?? 'f16';
    const kvOffload = chat.llamaKvOffload ?? true;
    const options = buildContextChoices(selectedModelId ?? '', selectedModel?.supportedContextPresets ?? [], selectedModel?.maxContext ?? 0, discoveryForModel?.options ?? []);
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
    setDiscovery(null);
    setDiscoveryStage('Подготовка; llama.cpp будет перезапущен несколько раз…');
    setDiscoveryError(null);
    try { setDiscovery(await window.localAi.contextDiscover(selectedModelId)); }
    catch (error) { setDiscoveryError(error instanceof Error ? error.message : String(error)); }
    finally { setDiscoveryLoading(false); }
  };
  return (
    <header className="toolbar">
      <div className="monitoring-row" aria-label="Мониторинг llama.cpp">
        <Hardware value={hardware} />
        <span className="backend-indicator">{runtimeLabel}</span>
        <button className="context-discover" disabled={discoveryLoading || !selectedModelId || isGenerating} onClick={() => void discoverMaximum()}>{discoveryLoading ? 'Идёт проверка…' : 'Найти максимальный контекст'}</button>
        {discoveryLoading && <span role="status">{discoveryStage || 'llama.cpp будет перезапущен несколько раз…'}</span>}
        <details className="context-estimate">
          <summary>Максимальный контекст: {maxContextLabel}</summary>
          <div className="context-estimate-details">
            <p>Обычные варианты контекста — это возможности модели и llama.cpp, а не гарантия, что хватит памяти. «Максимальный контекст» добавляет варианты FP16 и Q8: ограниченный поиск по реальным запускам с проверкой состояния и пробным запросом и с запасом RAM/VRAM. llama.cpp перезапускается несколько раз, затем исходная конфигурация восстанавливается. Это граница безопасного поиска, а не абсолютный предел до нехватки памяти.</p>
            <p><span>Найдено</span><b>{maxContextLabel}</b></p>
            <p><span>Активное окно</span><b>{actualRuntimeContext ? `${Math.round(actualRuntimeContext / 1024)}K` : 'модель не загружена'}</b></p>
            {discoveryForModel?.options.map((option) => <p key={`${option.kvCacheType}-${option.contextWindow}`}><span>{option.kvCacheType.toUpperCase()} · запас после пробного запроса</span><b>RAM {Math.round(option.measuredHeadroom.hostBytes / 1024 ** 3 * 10) / 10} ГиБ · VRAM {Math.round(option.measuredHeadroom.deviceBytes / 1024 ** 3 * 10) / 10} ГиБ</b></p>)}
            {discoveryForModel?.options.map((option) => option.vramBudget && <details key={`budget-${option.kvCacheType}`}><summary>{cacheModeLabel(option.kvCacheType)} · бюджет VRAM</summary>
              {currentVramBudget && <p>Сейчас другие приложения занимают {currentVramBudget.nonLlmBytes / 1024 ** 2} МиБ; свободно {currentVramBudget.freeBytes / 1024 ** 2} МиБ; доступно для LLM {currentVramBudget.availableLlmBytes / 1024 ** 2} МиБ.</p>}
              <p>Всего на GPU {option.vramBudget.totalBytes / 1024 ** 2} МиБ; занято не LLM {option.vramBudget.nonLlmBytes / 1024 ** 2} МиБ; общий бюджет для не-LLM {option.vramBudget.backgroundBudgetBytes / 1024 ** 2} МиБ; запас {option.vramBudget.marginBytes / 1024 ** 2} МиБ.</p>
              <p>Бюджет LLM {option.vramBudget.llmBudgetBytes / 1024 ** 2} МиБ; фактически доступно LLM {option.vramBudget.availableLlmBytes / 1024 ** 2} МиБ; занято LLM {option.vramBudget.llmBytes / 1024 ** 2} МиБ; зарезервировано драйвером {option.vramBudget.driverReservedBytes / 1024 ** 2} МиБ.</p>
              <p>Граница {(option.boundaryTokens ?? 0) / 1024}K ({(option.boundaryReason && boundaryReasonLabel[option.boundaryReason]) ?? option.boundaryReason}); безопасный максимум {option.contextWindow / 1024}K. {option.vramBudget.backgroundOverBudget ? 'Другие приложения превышают бюджет; ограничивает фактически свободная VRAM.' : ''}</p>
            </details>)}
            {discoveryError && <small>Поиск не завершён: {discoveryError}</small>}
            {discoveryForModel?.unsupported.map((item) => <small key={item.kvCacheType}>{item.kvCacheType.toUpperCase()} не предложен: {item.reason}</small>)}
            <details><summary>Диагностика</summary>
              <p><span>Предел модели и llama.cpp</span><b>{contextEstimate?.configuredMaxTokens ? `${Math.round(contextEstimate.configuredMaxTokens / 1024)}K` : selectedModel ? `${Math.round(selectedModel.maxContext / 1024)}K` : 'неизвестен'}</b></p>
              {contextEstimate?.modelTrainContextTokens !== null && contextEstimate?.modelTrainContextTokens !== undefined && <p><span>Лимит из метаданных модели (обучение)</span><b>{Math.round(contextEstimate.modelTrainContextTokens / 1024)}K</b></p>}
              {contextEstimate?.allocationEvidence && <p><span>Фактический KV</span><b>{contextEstimate.allocationEvidence.kvTypeK ?? 'неизвестно'} / {contextEstimate.allocationEvidence.kvTypeV ?? 'неизвестно'}; слоты {contextEstimate.allocationEvidence.sequenceSlots ?? '?'}, draft {contextEstimate.allocationEvidence.speculativeSlots ?? '?'}</b></p>}
              <small>{estimateLoading ? 'Обновление данных llama.cpp…' : estimateResponse?.error ? `Не удалось получить метаданные: ${estimateResponse.error}.` : missingEstimate ? `Нет полных данных о выделении памяти активной модели: ${missingEstimate}.` : discoveryForModel?.options.some((option) => option.restored) ? 'Показан сохранённый результат прошлого измерения; перезапуска проб не было. «Найти максимальный контекст» пересчитает его, а выбор значения всё равно проверяет текущую память.' : discoveryForModel?.restored ? `Измерено при ${discoveryForModel.probeContextTokens / 1024}K; исходная конфигурация llama.cpp восстановлена.` : 'Максимум не рассчитан, пока вы не запустите поиск.'}</small>
            </details>
          </div>
        </details>
      </div>
      <div className="toolbar-controls">
        <label className="control"><span>Модель</span><select disabled={discoveryLoading} value={chat.modelId ?? ''} onChange={(event) => void updateConversation(chat.id, { modelId: event.target.value || null }).catch(() => undefined)}><option value="">Выберите модель</option>{models.map((model) => <option value={model.id} key={model.id} disabled={!model.installed}>{model.name}{model.installed ? '' : ' · не установлена'}</option>)}</select></label>
        <label className="control"><span>Контекст · {contextLabel}</span><select disabled={discoveryLoading} value={selectedContextOption ? contextChoiceId(selectedContextOption) : ''} onChange={(event) => { const option = contextOptions.find((candidate) => contextChoiceId(candidate) === event.target.value); if (option) void updateConversation(chat.id, { contextWindow: option.contextWindow, llamaKvCacheType: option.kvCacheType, llamaKvOffload: option.kvOffload }).catch(() => undefined); }}>{contextOptions.map((option) => <option value={contextChoiceId(option)} key={contextChoiceId(option)}>{option.label}</option>)}</select></label>
        {reasoningCapability && <label className="control" title={reasoningControlText.thinkingHint}><span>{reasoningControlText.thinking}</span>{reasoningCapability.thinkingToggle
          ? <select value={reasoningSelection.thinking === false ? 'off' : 'on'} onChange={(event) => void updateConversation(chat.id, { thinkingEnabled: event.target.value === 'on' }).catch(() => undefined)}><option value="on">{thinkingLabel.on}</option><option value="off">{thinkingLabel.off}</option></select>
          : <select disabled title={reasoningControlText.thinkingUnavailable} value="unavailable"><option value="unavailable">{reasoningControlText.unavailable}</option></select>}</label>}
        {reasoningCapability && <label className="control" title={reasoningSelection.thinking === false ? reasoningControlText.effortInactive : reasoningControlText.effortHint}><span>{reasoningControlText.effort}</span>{reasoningCapability.efforts.length
          ? <select disabled={reasoningSelection.thinking === false} value={reasoningSelection.effort ?? ''} onChange={(event) => void updateConversation(chat.id, { reasoningEffort: event.target.value as ReasoningEffort }).catch(() => undefined)}>{reasoningCapability.efforts.map((effort) => <option value={effort} key={effort}>{reasoningEffortLabel[effort]}</option>)}</select>
          : <select disabled title={reasoningControlText.effortUnavailable} value="unavailable"><option value="unavailable">{reasoningControlText.unavailable}</option></select>}</label>}
        <label className="control" title={reasoningControlText.strategyHint}><span>{reasoningControlText.strategy}</span><select value={chat.reasoningMode === 'deep' ? 'deep' : 'fast'} onChange={(event) => void updateConversation(chat.id, { reasoningMode: event.target.value as 'fast' | 'deep' }).catch(() => undefined)}><option value="fast">{reasoningModeLabel.fast}</option><option value="deep">{reasoningModeLabel.deep}</option></select></label>
        <label className="control"><span>Веб</span><select value={chat.webMode} onChange={(event) => void updateConversation(chat.id, { webMode: event.target.value as 'off' | 'auto' })}><option value="off">Выкл.</option><option value="auto">Авто</option></select></label>
        <label className="control"><span>Режим</span><select value={chat.mode} onChange={(event) => void updateConversation(chat.id, { mode: event.target.value as 'chat' | 'agent' })}><option value="chat">Чат</option><option value="agent">Агент</option></select></label>
        <div className="project-selectors">{projectSelector(1, chat.workingDirectory)}{projectSelector(2, chat.secondaryWorkingDirectory)}</div>
      </div>
    </header>
  );
}
