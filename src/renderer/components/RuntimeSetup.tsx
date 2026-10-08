import { useState } from 'react';
import type { AppSettings, RuntimeConfiguration } from '../../shared/types';
import { useAppStore } from '../store/app-store';

export function RuntimeSetup({ setup, onClose }: { setup: NonNullable<AppSettings['setup']>; onClose: () => void }) {
  const [config, setConfig] = useState<RuntimeConfiguration>(() => ({ ...setup.config, models: Object.fromEntries(setup.models.map((model) => [model.id, { modelPath: model.modelPath, mmprojPath: model.mmprojPath ?? '' }])) }));
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const updateFile = (id: string, key: 'modelPath' | 'mmprojPath', value: string) => setConfig((current) => ({ ...current, models: { ...current.models, [id]: { ...current.models[id], [key]: value } } }));
  const choose = async (apply: (path: string) => void, directory = false) => {
    try { const path = directory ? await window.localAi.dialog.chooseDirectory(config.modelsPath) : await window.localAi.dialog.chooseFile(); if (path) apply(path); }
    catch (error) { setMessage(String(error)); }
  };
  const save = async () => {
    setSaving(true); setMessage('');
    try {
      // Missing default weights for unused profiles must not prevent setup of
      // one installed model. Explicit choices remain validated in the backend.
      const models = Object.fromEntries(Object.entries(config.models).map(([id, files]) => {
        const initial = setup.models.find((model) => model.id === id)!;
        return [id, { ...files, ...(!initial.installed && files.modelPath === initial.modelPath ? { modelPath: '' } : {}) }];
      }));
      await window.localAi.settings.save({ ...config, models });
      await useAppStore.getState().refreshRuntime();
      setMessage('Сохранено. Перезапустите приложение, затем выберите модель в верхней панели.');
    } catch (error) { setMessage((error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
    finally { setSaving(false); }
  };
  return <div className="runtime-setup-backdrop"><section className="runtime-setup" role="dialog" aria-modal="true" aria-labelledby="runtime-setup-title">
    <header><h2 id="runtime-setup-title">Настройка runtime</h2><button onClick={onClose} aria-label="Закрыть настройки">Закрыть</button></header>
    <p>Установите llama.cpp отдельно и выберите llama-server и GGUF нужных моделей. Для настройки файлов приложение должно быть без загруженной модели.</p>
    {setup.issues.length > 0 && <ul>{setup.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
    <label>llama-server (пусто — поиск в PATH)<div className="setup-path"><input value={config.llamaServerPath ?? ''} onChange={(event) => setConfig({ ...config, llamaServerPath: event.target.value || null })} /><button onClick={() => void choose((path) => setConfig({ ...config, llamaServerPath: path }))}>Выбрать файл</button></div></label>
    <label>Каталог моделей<div className="setup-path"><input value={config.modelsPath} onChange={(event) => setConfig({ ...config, modelsPath: event.target.value, models: {} })} /><button onClick={() => void choose((path) => setConfig({ ...config, modelsPath: path, models: {} }), true)}>Выбрать папку</button></div></label>
    <label>GPU-слои: 0 — CPU, 999 — все доступные<input type="number" min="0" max="999" value={config.gpuLayers} onChange={(event) => setConfig({ ...config, gpuLayers: Number(event.target.value) })} /></label>
    <p>~ раскрывается в домашний каталог; пробелы в путях поддерживаются. Projector нужен только для изображений. Оставьте его пустым для текстового режима.</p>
    {setup.models.map((model) => <fieldset key={model.id}><legend>{model.name}</legend>
      <label>Основной GGUF<div className="setup-path"><input value={config.models[model.id]?.modelPath ?? ''} onChange={(event) => updateFile(model.id, 'modelPath', event.target.value)} /><button onClick={() => void choose((path) => updateFile(model.id, 'modelPath', path))}>Выбрать файл</button></div></label>
      <label>Projector GGUF (необязательно)<div className="setup-path"><input value={config.models[model.id]?.mmprojPath ?? ''} onChange={(event) => updateFile(model.id, 'mmprojPath', event.target.value)} /><button onClick={() => void choose((path) => updateFile(model.id, 'mmprojPath', path))}>Выбрать файл</button></div></label>
    </fieldset>)}
    <small>Данные: {setup.dataDirectory}<br />Настройки: {setup.configPath}</small>
    {message && <p role="status">{message}</p>}
    <footer><button disabled={saving} onClick={() => void save()}>{saving ? 'Сохранение…' : 'Сохранить'}</button></footer>
  </section></div>;
}
