import { useEffect, useState } from 'react';
import { FolderOpen, X } from 'lucide-react';
import { useAppStore } from '../store/app-store';
import { Hardware } from './Hardware';
import { projectDirectoryName } from '../../shared/project-references';
import type { RuntimeContextEstimate } from '../../shared/context-estimator';

export function Toolbar() {
  const { conversations, activeId, models, hardware, settings, activeContextWindow, updateConversation, refreshRuntime } = useAppStore();
  const [estimateResponse, setEstimateResponse] = useState<{ modelId: string; value?: RuntimeContextEstimate; error?: string } | null>(null);
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
    setEstimateResponse({ modelId: selectedModelId });
    void window.localAi.contextEstimate(selectedModelId)
      .then((value) => { if (current) setEstimateResponse({ modelId: selectedModelId, value }); })
      .catch((error: unknown) => { if (current) setEstimateResponse({ modelId: selectedModelId, error: error instanceof Error ? error.message : String(error) }); });
    return () => { current = false; };
  }, [selectedModelId, settings?.selectedBackend, settings?.llamaRuntime?.status, settings?.llamaRuntime?.modelId, settings?.llamaRuntime?.contextWindow, hardware?.ramUsedBytes, hardware?.vramUsedBytes, chat?.contextWindow]);
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
  const contextBackend = selectedModel?.backend ?? settings?.selectedBackend;
  const safeEstimateLabel = contextEstimate?.status === 'estimated' && contextEstimate.hardwareSafeTokens !== null
    ? contextEstimate.hardwareSafeTokens === 0 ? 'нет подходящего размера' : `${Math.round(contextEstimate.hardwareSafeTokens / 1024)}K (оценка)`
    : estimateResponse?.error
      ? 'недоступен'
      : contextEstimate?.observedContextTokens
        ? `оценка неизвестна · загружено ${Math.round(contextEstimate.observedContextTokens / 1024)}K`
        : contextEstimate?.hardwareSafeTokens === 0
      ? 'нет подходящего размера'
      : 'неизвестен';
  const actualRuntimeContext = contextEstimate?.observedContextTokens
    ?? (llama?.status === 'ready' && llama.modelId === chat.modelId ? llama.contextWindow : null);
  return (
    <header className="toolbar">
      <div className="monitoring-row" aria-label="Мониторинг runtime">
        <Hardware value={hardware} />
        <span className="backend-indicator">{runtimeLabel}</span>
        <details className="context-estimate">
          <summary>Безопасный контекст: {estimateLoading ? 'получение данных…' : safeEstimateLabel}</summary>
          <div className="context-estimate-details">
            <p>Оценка ограничена уже загруженным окном и его текущими KV, offload и draft/MTP настройками. Больший контекст требует нового измерения; это не доказательство абсолютного максимума оборудования.</p>
            <p><span>Предел модели/backend</span><b>{contextEstimate?.configuredMaxTokens ? `${Math.round(contextEstimate.configuredMaxTokens / 1024)}K` : selectedModel ? `${Math.round(selectedModel.maxContext / 1024)}K` : 'неизвестен'}</b></p>
            {contextEstimate?.modelTrainContextTokens !== null && contextEstimate?.modelTrainContextTokens !== undefined && <p><span>Модель обучена до (metadata, не runtime limit)</span><b>{Math.round(contextEstimate.modelTrainContextTokens / 1024)}K</b></p>}
            <p><span>Выбранное окно</span><b>{Math.round(chat.contextWindow / 1024)}K</b></p>
            {actualRuntimeContext !== null && <p><span>{contextBackend === 'ollama' ? 'Загруженный Ollama context_length (наблюдение)' : 'Загруженный llama-server n_ctx (наблюдение)'}</span><b>{Math.round(actualRuntimeContext / 1024)}K</b></p>}
            {contextEstimate?.modelFileSizeBytes !== null && contextEstimate?.modelFileSizeBytes !== undefined && <p><span>Размер модели по runtime metadata (не VRAM)</span><b>{(contextEstimate.modelFileSizeBytes / 1024 ** 3).toFixed(1)} GB</b></p>}
            {contextEstimate?.observedResidentBytes !== null && contextEstimate?.observedResidentBytes !== undefined && <p><span>Загрузка Ollama (reported)</span><b>{(contextEstimate.observedResidentBytes / 1024 ** 3).toFixed(1)} GB</b></p>}
            {contextEstimate?.observedDeviceResidentBytes !== null && contextEstimate?.observedDeviceResidentBytes !== undefined && <p><span>Из неё VRAM (reported)</span><b>{(contextEstimate.observedDeviceResidentBytes / 1024 ** 3).toFixed(1)} GB</b></p>}
            <p><span>Безопасный максимум памяти</span><b>{safeEstimateLabel}</b></p>
            <p>{contextBackend === 'ollama' ? 'Ollama получает выбранный num_ctx в каждом запросе; это не измерение фактической KV-cache или загрузки модели.' : 'llama.cpp сообщает загруженный серверный n_ctx; успешный запуск не гарантирует запас памяти для других нагрузок.'}</p>
            <small>{estimateLoading ? 'Получаем сведения активного runtime…' : estimateResponse?.error ? `Не удалось получить метаданные: ${estimateResponse.error}.` : missingEstimate ? `Нет надёжной оценки: ${missingEstimate}.` : contextEstimate?.status === 'estimated' ? 'Оценка масштабирует наблюдаемые allocation sizes и учитывает явно заданные резервы.' : 'Максимум модели/runtime не является гарантией аппаратной безопасности.'}</small>
          </div>
        </details>
      </div>
      <div className="toolbar-controls">
        <label className="control"><span>Модель</span><select value={chat.modelId ?? ''} onChange={(event) => void updateConversation(chat.id, { modelId: event.target.value || null }).catch(() => undefined)}><option value="">Выберите модель</option>{models.map((model) => <option value={model.id} key={model.id} disabled={!model.installed}>{model.name}{model.installed ? '' : ' · не установлена'}</option>)}</select></label>
        <label className="control"><span>Контекст · {contextLabel}</span><select value={chat.contextWindow} onChange={(event) => void updateConversation(chat.id, { contextWindow: Number(event.target.value) }).catch(() => undefined)}>{(selectedModel?.supportedContextPresets ?? []).map((preset) => <option value={preset} key={preset}>{Math.round(preset / 1024)}K</option>)}</select></label>
        {selectedModel?.supportsReasoning && <label className="control"><span>Рассуждение</span><select value={chat.reasoningMode === 'deep' ? 'deep' : 'fast'} onChange={(event) => void updateConversation(chat.id, { reasoningMode: event.target.value as 'fast' | 'deep' })}><option value="fast">Быстро</option><option value="deep">Глубоко</option></select></label>}
        <label className="control"><span>Web</span><select value={chat.webMode} onChange={(event) => void updateConversation(chat.id, { webMode: event.target.value as 'off' | 'auto' })}><option value="off">Off</option><option value="auto">Auto</option></select></label>
        <label className="control"><span>Режим</span><select value={chat.mode} onChange={(event) => void updateConversation(chat.id, { mode: event.target.value as 'chat' | 'agent' })}><option value="chat">Чат</option><option value="agent">Агент</option></select></label>
        <div className="project-selectors">{projectSelector(1, chat.workingDirectory)}{projectSelector(2, chat.secondaryWorkingDirectory)}</div>
      </div>
    </header>
  );
}
