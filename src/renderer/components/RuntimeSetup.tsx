import { useLocale } from '../use-locale';
import { t, tr, localizeMessage, getLanguage } from '../../shared/locale';
import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { AppSettings, RuntimeConfiguration, RuntimeModelConfiguration } from '../../shared/types';
import { useAppStore } from '../store/app-store';

type SetupState = NonNullable<AppSettings['setup']>;
const labelForStatus = (status: SetupState['models'][number]['status']) => ({
  ready: t("Готова к запуску"), 'missing-model': t("Выберите файл модели"), 'missing-server': t("Нужен llama-server"), 'invalid-projector': t("Projector не найден; текст доступен"),
}[status]);

export function RuntimeSetup({ setup, onClose }: { setup: SetupState; onClose: () => void }) {
  useLocale();
  const [config, setConfig] = useState<RuntimeConfiguration>(setup.config);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { void useAppStore.getState().refreshRuntime(); }, []);
  useEffect(() => { setConfig(setup.config); }, [setup.config]);
  const selected = config.models.find((model) => model.id === editingId) ?? null;
  const updateModel = (id: string, patch: Partial<RuntimeModelConfiguration>) => setConfig((current) => ({
    ...current, models: current.models.map((model) => model.id === id ? { ...model, ...patch } : model),
  }));
  const chooseFile = async (apply: (path: string) => void) => {
    try { const path = await window.localAi.dialog.chooseFile(); if (path) apply(path); }
    catch { setMessage(t("Не удалось открыть выбор файла. Проверьте разрешения рабочего стола.")); }
  };
  const addModel = () => { void chooseFile((path) => {
    const filename = path.split(/[\\/]/).at(-1) ?? path;
    const displayName = filename.replace(/\.gguf$/i, '') || t("Новая модель");
    const model: RuntimeModelConfiguration = { id: `custom:${globalThis.crypto.randomUUID()}`, displayName,
      modelPath: path, mmprojPath: '', gpuLayers: null, supportsTools: false, speculative: 'none', builtin: false };
    setConfig((current) => ({ ...current, models: [...current.models, model] }));
    setEditingId(model.id); setMessage('');
  }); };
  const save = async () => {
    setSaving(true); setMessage('');
    try {
      const result = await window.localAi.settings.save({ ...config, language: getLanguage() });
      useAppStore.setState({ settings: result });
      await useAppStore.getState().refreshRuntime();
      setMessage(t("Настройки сохранены. Перезапустите приложение, чтобы применить путь llama-server."));
    } catch (error) {
      setMessage((error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally { setSaving(false); }
  };
  const remove = (model: RuntimeModelConfiguration) => {
    if (!window.confirm(tr`Удалить профиль «${model.displayName}»? История чатов сохранится, но для новых ответов нужно будет снова добавить эту модель.`)) return;
    setConfig((current) => ({ ...current, models: current.models.filter((entry) => entry.id !== model.id) }));
    if (editingId === model.id) setEditingId(null);
  };
  return <div className="runtime-setup-backdrop"><section className="runtime-setup" role="dialog" aria-modal="true" aria-labelledby="runtime-setup-title">
    <header><div><h2 id="runtime-setup-title">{t("Модели и runtime")}</h2><p>{setup.ready ? t("Есть модель, готовая к запуску.") : t("Добавьте GGUF и укажите llama-server.")}</p></div><button onClick={onClose} aria-label={t("Закрыть настройки")}>{t("Закрыть")}</button></header>
    <section className={`runtime-readiness ${setup.ready ? 'is-ready' : 'is-incomplete'}`} role="status">
      <strong>{setup.ready ? t("Всё готово") : t("Требуется настройка")}</strong>
      <span>{setup.server ? `llama-server: ${setup.server}` : t("Не выбран llama-server")}</span>
      <span>{setup.models.filter((model) => model.installed).length} {t(" моделей с доступным GGUF")}</span>
    </section>
    {setup.issues.map((issue) => <p className="runtime-setup-issue" role="alert" key={issue}>{localizeMessage(issue)}</p>)}
    <label>{t("Исполняемый файл llama-server")}<div className="setup-path"><input aria-label={t("Путь к llama-server")} value={config.llamaServerPath ?? ''} placeholder={t("Путь к файлу или llama-server из PATH")} onChange={(event) => setConfig({ ...config, llamaServerPath: event.target.value || null })} /><button onClick={() => void chooseFile((path) => setConfig({ ...config, llamaServerPath: path }))}>{t("Обзор…")}</button></div><small>{t("Это сервер из установленной вами сборки llama.cpp. Он нужен для запуска любой модели.")}</small></label>
    <label>{t("Каталог для относительных путей")}<div className="setup-path"><input aria-label={t("Каталог моделей")} value={config.modelsPath} onChange={(event) => setConfig({ ...config, modelsPath: event.target.value })} /><button onClick={async () => { try { const path = await window.localAi.dialog.chooseDirectory(config.modelsPath); if (path) setConfig({ ...config, modelsPath: path }); } catch { setMessage(t("Не удалось открыть выбор папки.")); } }}>{t("Обзор…")}</button></div><small>{t("Модели можно хранить в любом месте. Для каждого профиля ниже можно выбрать файл отдельно.")}</small></label>
    <label>{t("GPU-слои по умолчанию")}<input aria-label={t("GPU-слои по умолчанию")} type="number" min="0" max="999" value={config.gpuLayers} onChange={(event) => setConfig({ ...config, gpuLayers: Number(event.target.value) })} /><small>{t("999 отправляет доступные слои на GPU; 0 использует CPU. Объём VRAM зависит от модели.")}</small></label>

    <div className="runtime-model-heading"><div><h3>{t("Мои модели")}</h3><p>{t("Можно добавить любую совместимую GGUF-модель.")}</p></div><button className="runtime-add-model" onClick={addModel}><Plus size={16} /> {t(" Добавить GGUF")}</button></div>
    <ul className="runtime-model-list">{setup.models.map((model) => {
      const profile = config.models.find((item) => item.id === model.id);
      if (!profile) return null;
      return <li key={model.id} className={model.status === 'ready' ? 'model-ready' : 'model-needs-setup'}>
        <button className="runtime-model-select" aria-label={tr`Редактировать ${profile.displayName}`} onClick={() => setEditingId(profile.id)}>
          <strong>{profile.displayName}</strong><span>{labelForStatus(model.status)}</span>{model.issue && <small>{localizeMessage(model.issue)}</small>}
        </button>
        <button aria-label={tr`Удалить профиль ${profile.displayName}`} title={t("Удалить профиль")} onClick={() => remove(profile)}><Trash2 size={16} /></button>
      </li>;
    })}</ul>
    {!config.models.length && <p>{t("Профилей пока нет. Нажмите «Добавить GGUF», чтобы выбрать модель с компьютера.")}</p>}

    {selected && <fieldset className="runtime-model-editor"><legend>{selected.builtin ? t("Настройки профиля") : t("Новый профиль")}</legend>
      <label>{t("Название в приложении")}<input aria-label={t("Название модели")} maxLength={80} value={selected.displayName} onChange={(event) => updateModel(selected.id, { displayName: event.target.value })} /></label>
      <label>{t("Файл модели GGUF")}<div className="setup-path"><input aria-label={t("Файл модели GGUF")} value={selected.modelPath} onChange={(event) => updateModel(selected.id, { modelPath: event.target.value })} /><button onClick={() => void chooseFile((path) => updateModel(selected.id, { modelPath: path }))}>{t("Выбрать…")}</button></div><small>{t("Выберите первый файл модели. Части split GGUF должны лежать рядом.")}</small></label>
      <label>{t("Projector для изображений — необязательно")}<div className="setup-path"><input aria-label={t("Проектор GGUF")} value={selected.mmprojPath} onChange={(event) => updateModel(selected.id, { mmprojPath: event.target.value })} /><button onClick={() => void chooseFile((path) => updateModel(selected.id, { mmprojPath: path }))}>{t("Выбрать…")}</button></div><small>{t("Нужен, чтобы эта модель понимала изображения. Без него остаётся текстовый чат.")}</small></label>
      <label>{t("GPU-слои для этой модели")}<input aria-label={t("GPU-слои модели")} type="number" min="0" max="999" placeholder={tr`По умолчанию: ${config.gpuLayers}`} value={selected.gpuLayers ?? ''} onChange={(event) => updateModel(selected.id, { gpuLayers: event.target.value === '' ? null : Number(event.target.value) })} /><small>{t("Оставьте пустым, чтобы использовать значение по умолчанию выше.")}</small></label>
      <p>{t("Устройство vision projector")}: {t("Выберите CPU или GPU в меню «Обработка изображений». Это не меняет GPU-слои модели.")}</p>
      {selected.builtin ? <label className="runtime-option"><input type="checkbox" checked={selected.speculative === 'mtp'} onChange={(event) => updateModel(selected.id, { speculative: event.target.checked ? 'mtp' : 'none' })} />{t("Использовать встроенное ускорение MTP")}</label> : <>
        <label className="runtime-option"><input type="checkbox" checked={selected.supportsTools} onChange={(event) => updateModel(selected.id, { supportsTools: event.target.checked })} />{t("Модель поддерживает вызов инструментов")}</label>
        <label>{t("Ускорение генерации")}<select value={selected.speculative} onChange={(event) => updateModel(selected.id, { speculative: event.target.value as 'mtp' | 'none' })}><option value="none">{t("Отключено")}</option><option value="mtp">{t("Встроенное MTP (проверить по GGUF)")}</option></select><small>{t("Для неизвестной модели ускорение выключено. MTP будет проверен перед запуском.")}</small></label>
      </>}
    </fieldset>}
    <small>{t("Настройки: ")}{setup.configPath}<br />{t("Данные приложения: ")}{setup.dataDirectory}{t(". Пути с пробелами и ~/ поддерживаются.")}</small>
    {message && <p role="status" className="runtime-setup-message">{localizeMessage(message)}</p>}
    <footer><button disabled={saving} onClick={() => void save()}>{saving ? t("Сохранение…") : t("Сохранить изменения")}</button></footer>
  </section></div>;
}
