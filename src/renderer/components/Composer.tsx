import { File, Folder, Paperclip, Send, Square, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/app-store';
import { ContextUsage } from './ContextUsage';
import type { AgentPlan, ProjectReference, ProjectSuggestion } from '../../shared/types';
import { removeProjectReferenceQuery } from '../../shared/project-references';

const isImageFile = (file: File): boolean => file.type.startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(file.name);

export function Composer() {
  const [value, setValue] = useState(''); const [files, setFiles] = useState<File[]>([]); const [projectReferences, setProjectReferences] = useState<ProjectReference[]>([]); const [suggestions, setSuggestions] = useState<ProjectSuggestion[]>([]); const [referenceQuery, setReferenceQuery] = useState<{ start: number; text: string } | null>(null); const [activeSuggestion, setActiveSuggestion] = useState(0); const [attachmentError, setAttachmentError] = useState<string | null>(null); const ref = useRef<HTMLTextAreaElement>(null); const inputRef = useRef<HTMLInputElement>(null);
  const manualHeight = useRef<number | null>(null); const resizeHandle = useRef(false);
  const { sendMessage, stop, isGenerating, conversations, activeId, activeTaskPlan } = useAppStore();
  const chat = conversations.find((item) => item.id === activeId);
  const projectEnabled = Boolean(chat?.workingDirectory);
  const resetHeight = () => { const textarea = ref.current; if (!textarea) return; manualHeight.current = null; textarea.style.height = ''; textarea.style.overflowY = 'hidden'; };
  const addFiles = useCallback((incoming: File[]) => {
    let imageCount = files.filter(isImageFile).length; const next = [...files];
    let rejected = false;
    for (const file of incoming) { if (isImageFile(file)) { if (imageCount >= 10) { rejected = true; continue; } imageCount += 1; } next.push(file); }
    setAttachmentError(rejected ? 'Максимум 10 изображений на сообщение' : null);
    setFiles(next);
  }, [files]);
  const submit = () => { if (!isGenerating && (value.trim() || files.length)) { void sendMessage(value, files, projectReferences); setValue(''); setFiles([]); setProjectReferences([]); setSuggestions([]); setReferenceQuery(null); setAttachmentError(null); } };
  useEffect(() => {
    if (!projectEnabled || !activeId || !referenceQuery) { setSuggestions([]); return; }
    let cancelled = false;
    const timer = window.setTimeout(() => { void window.localAi.projects.search(activeId, referenceQuery.text).then((results) => { if (!cancelled) { setSuggestions(results); setActiveSuggestion(0); } }).catch(() => { if (!cancelled) setSuggestions([]); }); }, 80);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [activeId, projectEnabled, referenceQuery]);
  useEffect(() => { if (!projectEnabled) { setReferenceQuery(null); setSuggestions([]); } }, [projectEnabled]);
  const updateValue = (next: string, cursor: number) => {
    setValue(next);
    if (!projectEnabled) { setReferenceQuery(null); return; }
    const beforeCursor = next.slice(0, cursor); const match = /(?:^|\s)@([^\s@]*)$/.exec(beforeCursor);
    setReferenceQuery(match ? { start: cursor - match[1].length - 1, text: match[1] } : null);
  };
  const selectSuggestion = (suggestion: ProjectSuggestion) => {
    if (!referenceQuery) return;
    const end = ref.current?.selectionStart ?? referenceQuery.start + referenceQuery.text.length + 1;
    const next = removeProjectReferenceQuery(value, referenceQuery.start, end);
    setValue(next.value); setProjectReferences((items) => [...items, { ...suggestion, id: crypto.randomUUID() }]); setReferenceQuery(null); setSuggestions([]);
    window.requestAnimationFrame(() => { ref.current?.focus(); ref.current?.setSelectionRange(next.cursor, next.cursor); });
  };
  useLayoutEffect(() => {
    const textarea = ref.current; if (!textarea) return;
    if (!value) { resetHeight(); return; }
    if (manualHeight.current !== null) return;
    textarea.style.height = '0px';
    const height = Math.min(textarea.scrollHeight, 184);
    textarea.style.height = `${height}px`;
    textarea.style.overflowY = textarea.scrollHeight > 184 ? 'auto' : 'hidden';
  }, [value]);
  useLayoutEffect(() => { ref.current?.focus(); }, []);
  useEffect(() => {
    const element = ref.current; const onPaste = (event: ClipboardEvent) => { const images = [...(event.clipboardData?.files ?? [])].filter(isImageFile); if (images.length) { event.preventDefault(); addFiles(images); } };
    element?.addEventListener('paste', onPaste); return () => element?.removeEventListener('paste', onPaste);
  }, [addFiles]);
  const startResize = (event: React.PointerEvent<HTMLTextAreaElement>) => {
    const { right, bottom } = event.currentTarget.getBoundingClientRect();
    resizeHandle.current = event.clientX > right - 28 && event.clientY > bottom - 28;
  };
  const finishResize = () => {
    if (!resizeHandle.current || !ref.current) return;
    resizeHandle.current = false;
    window.requestAnimationFrame(() => { if (ref.current) { manualHeight.current = ref.current.offsetHeight; ref.current.style.overflowY = 'auto'; } });
  };
  return <div className="composer-wrap">{activeTaskPlan && <TaskPlanPanel plan={activeTaskPlan} active />}<div className="composer" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); addFiles([...event.dataTransfer.files]); }}>
    {(files.length > 0 || projectReferences.length > 0) && <div className="attachment-draft">{projectReferences.map((reference) => <ProjectReferenceChip key={reference.id} reference={reference} onRemove={() => setProjectReferences((items) => items.filter((item) => item.id !== reference.id))} />)}{files.map((file, index) => <DraftAttachment key={`${file.name}-${index}`} file={file} index={isImageFile(file) ? files.slice(0, index + 1).filter(isImageFile).length - 1 : index} onRemove={() => { setFiles((items) => items.filter((_, itemIndex) => itemIndex !== index)); setAttachmentError(null); }} />)}</div>}
    <input ref={inputRef} className="attachment-input" type="file" multiple accept=".png,.jpg,.jpeg,.webp,.txt,.md,.json,.csv,.log,.js,.ts,.jsx,.tsx,.html,.css,.yaml,.yml,.xml,.docx,.xlsx,.xls,.pdf" onChange={(event) => { addFiles([...(event.target.files ?? [])]); event.currentTarget.value = ''; }} />
    <button className="attach-button" type="button" disabled={isGenerating} title="Прикрепить файлы" onClick={() => inputRef.current?.click()}><Paperclip size={18} /></button>
    <textarea ref={ref} value={value} placeholder="Напишите сообщение…" rows={1} onPointerDown={startResize} onPointerUp={finishResize} onChange={(event) => updateValue(event.target.value, event.target.selectionStart)} onKeyDown={(event) => { if (suggestions.length) { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActiveSuggestion((index) => (index + (event.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length); return; } if ((event.key === 'Enter' || event.key === 'Tab') && suggestions[activeSuggestion]) { event.preventDefault(); selectSuggestion(suggestions[activeSuggestion]); return; } if (event.key === 'Escape') { event.preventDefault(); setReferenceQuery(null); setSuggestions([]); return; } } if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); } }} />
    {suggestions.length > 0 && <div className="project-reference-menu" role="listbox" aria-label="Файлы проекта">{suggestions.map((suggestion, index) => <button type="button" role="option" aria-selected={index === activeSuggestion} className={index === activeSuggestion ? 'active' : ''} key={suggestion.id} onMouseDown={(event) => { event.preventDefault(); selectSuggestion(suggestion); }} onMouseEnter={() => setActiveSuggestion(index)}>{suggestion.kind === 'folder' ? <Folder size={15} /> : <File size={15} />}<span>{suggestion.relativePath}</span><small className={`project-badge project-${suggestion.projectSlot}`}>{suggestion.projectLabel}</small></button>)}</div>}
    <ContextUsage />{isGenerating ? <button className="send-button stop" onClick={() => void stop()} title="Остановить генерацию"><Square size={16} fill="currentColor" /></button> : <button className="send-button" disabled={!value.trim() && files.length === 0} onClick={submit} title="Отправить"><Send size={18} /></button>}
  </div>{attachmentError && <p className="attachment-error" role="status">{attachmentError}</p>}<p>Enter — отправить · Shift+Enter — новая строка · вставьте или перетащите файлы</p></div>;
}

export function TaskPlanPanel({ plan, active = false }: { plan: AgentPlan; active?: boolean }) {
  const completed = plan.steps.filter((step) => step.status === 'completed').length;
  return <details className={`task-plan-panel${active ? ' active' : ''}`} open={active}><summary>Task Plan · {completed}/{plan.steps.length}{active && plan.steps.find((step) => step.status === 'in_progress') ? ` · ${plan.steps.find((step) => step.status === 'in_progress')!.label}` : ''}</summary><ol>{plan.steps.map((step) => <li className={step.status} key={step.id}>{step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '●' : '○'} {step.label}</li>)}</ol></details>;
}

function ProjectReferenceChip({ reference, onRemove }: { reference: ProjectReference; onRemove: () => void }) {
  return <div className={`project-reference-chip project-${reference.projectSlot}`}>{reference.kind === 'folder' ? <Folder size={13} /> : <File size={13} />}<span>{reference.relativePath}</span><small>{reference.projectLabel}</small><button type="button" title="Удалить ссылку на проект" onClick={onRemove}><X size={12} /></button></div>;
}

function DraftAttachment({ file, index, onRemove }: { file: File; index: number; onRemove: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => { if (!isImageFile(file)) return; const next = URL.createObjectURL(file); setUrl(next); return () => URL.revokeObjectURL(next); }, [file]);
  return <div className={`attachment-draft-item ${url ? 'image' : ''}`}>{url ? <img src={url} alt={`Image ${index + 1}`} /> : <span className="attachment-file-icon">{file.name.split('.').at(-1)?.toUpperCase() ?? 'FILE'}</span>}<span className="attachment-number">{url ? index + 1 : file.name}</span><button type="button" title="Удалить вложение" onClick={onRemove}><X size={13} /></button></div>;
}
