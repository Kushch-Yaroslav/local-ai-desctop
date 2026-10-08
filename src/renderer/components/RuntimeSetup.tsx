import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { AppSettings, RuntimeConfiguration, RuntimeModelConfiguration } from '../../shared/types';
import { useAppStore } from '../store/app-store';

type SetupState = NonNullable<AppSettings['setup']>;
const labelForStatus = (status: SetupState['models'][number]['status']) => ({
  ready: 'Готова к запуску', 'missing-model': 'Выберите файл модели', 'missing-server': 'Нужен llama-server', 'invalid-projector': 'Projector не найден; текст доступен',
}[status]);

export function RuntimeSetup({ setup, onClose }: { setup: SetupState; onClose: () => void }) {
  const [config, setConfig] = useState<RuntimeConfiguration>(setup.config);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { setConfig(setup.config); }, [setup.config]);
  const selected = config.models.find((model) => model.id === editingId) ?? null;
  const updateModel = (id: string, patch: Partial<RuntimeModelConfiguration>) => setConfig((current) => ({
    ...current, models: current.models.map((model) => model.id === id ? { ...model, ...patch } : model),
  }));
  const chooseFile = async (apply: (path: string) => void) => {
    try { const path = await window.localAi.dialog.chooseFile(); if (path) apply(path); }
    catch { setMessage('Не удалось открыть выбор файла. Проверьте разрешения рабочего стола.'); }
  };
  const addModel = () => { void chooseFile((path) => {
    const filename = path.split(/[\\/]/).at(-1) ?? path;
    const displayName = filename.replace(/\.gguf$/i, '') || 'Новая модель';
    const model: RuntimeModelConfiguration = { id: `custom:${globalThis.crypto.randomUUID()}`, displayName,
      modelPath: path, mmprojPath: '', gpuLayers: null, supportsTools: false, speculative: 'none', builtin: false };
    setConfig((current) => ({ ...current, models: [...current.models, model] }));
    setEditingId(model.id); setMessage('');
  }); };
  const save = async () => {
    setSaving(true); setMessage('');
    try {
      const result = await window.localAi.settings.save(config);
      useAppStore.setState({ settings: result });
      await useAppStore.getState().refreshRuntime();
      setMessage('Настройки сохранены. Перезапустите приложение, чтобы применить путь llama-server.');
    } catch (error) {
      setMessage((error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally { setSaving(false); }
  };
  const remove = (model: RuntimeModelConfiguration) => {
    if (!window.confirm(`Удалить профиль «${model.displayName}»? История чатов сохранится, но для новых ответов нужно будет снова добавить эту модель.`)) return;
    setConfig((current) => ({ ...current, models: current.models.filter((entry) => entry.id !== model.id) }));
    if (editingId === model.id) setEditingId(null);
  };
  return <div className="runtime-setup-backdrop"><section className="runtime-setup" role="dialog" aria-modal="true" aria-labelledby="runtime-setup-title">
    <header><div><h2 id="runtime-setup-title">Модели и runtime</h2><p>{setup.ready ? 'Есть модель, готовая к запуску.' : 'Добавьте GGUF и укажите llama-server.'}</p></div><button onClick={onClose} aria-label="Закрыть настройки">Закрыть</button></header>
    <section className={`runtime-readiness ${setup.ready ? 'is-ready' : 'is-incomplete'}`} role="status">
      <strong>{setup.ready ? 'Всё готово' : 'Требуется настройка'}</strong>
      <span>{setup.server ? `llama-server: ${setup.server}` : 'Не выбран llama-server'}</span>
      <span>{setup.models.filter((model) => model.installed).length} моделей с доступным GGUF</span>
    </section>
    {setup.issues.map((issue) => <p className="runtime-setup-issue" role="alert" key={issue}>{issue}</p>)}
    <label>Исполняемый файл llama-server<div className="setup-path"><input aria-label="Путь к llama-server" value={config.llamaServerPath ?? ''} placeholder="Путь к файлу или llama-server из PATH" onChange={(event) => setConfig({ ...config, llamaServerPath: event.target.value || null })} /><button onClick={() => void chooseFile((path) => setConfig({ ...config, llamaServerPath: path }))}>Обзор…</button></div><small>Это сервер из установленной вами сборки llama.cpp. Он нужен для запуска любой модели.</small></label>
    <label>Каталог для относительных путей<div className="setup-path"><input aria-label="Каталог моделей" value={config.modelsPath} onChange={(event) => setConfig({ ...config, modelsPath: event.target.value })} /><button onClick={async () => { try { const path = await window.localAi.dialog.chooseDirectory(config.modelsPath); if (path) setConfig({ ...config, modelsPath: path }); } catch { setMessage('Не удалось открыть выбор папки.'); } }}>Обзор…</button></div><small>Модели можно хранить в любом месте. Для каждого профиля ниже можно выбрать файл отдельно.</small></label>
    <label>GPU-слои по умолчанию<input aria-label="GPU-слои по умолчанию" type="number" min="0" max="999" value={config.gpuLayers} onChange={(event) => setConfig({ ...config, gpuLayers: Number(event.target.value) })} /><small>999 отправляет доступные слои на GPU; 0 использует CPU. Объём VRAM зависит от модели.</small></label>

    <div className="runtime-model-heading"><div><h3>Мои модели</h3><p>Можно добавить любую совместимую GGUF-модель.</p></div><button className="runtime-add-model" onClick={addModel}><Plus size={16} /> Добавить GGUF</button></div>
    <ul className="runtime-model-list">{setup.models.map((model) => {
      const profile = config.models.find((item) => item.id === model.id);
      if (!profile) return null;
      return <li key={model.id} className={model.status === 'ready' ? 'model-ready' : 'model-needs-setup'}>
        <button className="runtime-model-select" aria-label={`Редактировать ${profile.displayName}`} onClick={() => setEditingId(profile.id)}>
          <strong>{profile.displayName}</strong><span>{labelForStatus(model.status)}</span>{model.issue && <small>{model.issue}</small>}
        </button>
        <button aria-label={`Удалить профиль ${profile.displayName}`} title="Удалить профиль" onClick={() => remove(profile)}><Trash2 size={16} /></button>
      </li>;
    })}</ul>
    {!config.models.length && <p>Профилей пока нет. Нажмите «Добавить GGUF», чтобы выбрать модель с компьютера.</p>}

    {selected && <fieldset className="runtime-model-editor"><legend>{selected.builtin ? 'Настройки профиля' : 'Новый профиль'}</legend>
      <label>Название в приложении<input aria-label="Название модели" maxLength={80} value={selected.displayName} onChange={(event) => updateModel(selected.id, { displayName: event.target.value })} /></label>
      <label>Файл модели GGUF<div className="setup-path"><input aria-label="Файл модели GGUF" value={selected.modelPath} onChange={(event) => updateModel(selected.id, { modelPath: event.target.value })} /><button onClick={() => void chooseFile((path) => updateModel(selected.id, { modelPath: path }))}>Выбрать…</button></div><small>Выберите первый файл модели. Части split GGUF должны лежать рядом.</small></label>
      <label>Projector для изображений — необязательно<div className="setup-path"><input aria-label="Проектор GGUF" value={selected.mmprojPath} onChange={(event) => updateModel(selected.id, { mmprojPath: event.target.value })} /><button onClick={() => void chooseFile((path) => updateModel(selected.id, { mmprojPath: path }))}>Выбрать…</button></div><small>Нужен, чтобы эта модель понимала изображения. Без него остаётся текстовый чат.</small></label>
      <label>GPU-слои для этой модели<input aria-label="GPU-слои модели" type="number" min="0" max="999" placeholder={`По умолчанию: ${config.gpuLayers}`} value={selected.gpuLayers ?? ''} onChange={(event) => updateModel(selected.id, { gpuLayers: event.target.value === '' ? null : Number(event.target.value) })} /><small>Оставьте пустым, чтобы использовать значение по умолчанию выше.</small></label>
      {selected.builtin ? <label className="runtime-option"><input type="checkbox" checked={selected.speculative === 'mtp'} onChange={(event) => updateModel(selected.id, { speculative: event.target.checked ? 'mtp' : 'none' })} />Использовать встроенное ускорение MTP</label> : <>
        <label className="runtime-option"><input type="checkbox" checked={selected.supportsTools} onChange={(event) => updateModel(selected.id, { supportsTools: event.target.checked })} />Модель поддерживает вызов инструментов</label>
        <label>Ускорение генерации<select value={selected.speculative} onChange={(event) => updateModel(selected.id, { speculative: event.target.value as 'mtp' | 'none' })}><option value="none">Отключено</option><option value="mtp">Встроенное MTP (проверить по GGUF)</option></select><small>Для неизвестной модели ускорение выключено. MTP будет проверен перед запуском.</small></label>
      </>}
    </fieldset>}
    <small>Настройки: {setup.configPath}<br />Данные приложения: {setup.dataDirectory}. Пути с пробелами и ~/ поддерживаются.</small>
    {message && <p role="status" className="runtime-setup-message">{message}</p>}
    <footer><button disabled={saving} onClick={() => void save()}>{saving ? 'Сохранение…' : 'Сохранить изменения'}</button></footer>
  </section></div>;
}
