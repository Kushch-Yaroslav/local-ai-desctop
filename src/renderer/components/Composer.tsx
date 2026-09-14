import { Paperclip, Send, Square, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/app-store';
import { ContextUsage } from './ContextUsage';

const isImageFile = (file: File): boolean => file.type.startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(file.name);

export function Composer() {
  const [value, setValue] = useState(''); const [files, setFiles] = useState<File[]>([]); const [attachmentError, setAttachmentError] = useState<string | null>(null); const ref = useRef<HTMLTextAreaElement>(null); const inputRef = useRef<HTMLInputElement>(null);
  const manualHeight = useRef<number | null>(null); const resizeHandle = useRef(false);
  const { sendMessage, stop, isGenerating } = useAppStore();
  const resetHeight = () => { const textarea = ref.current; if (!textarea) return; manualHeight.current = null; textarea.style.height = ''; textarea.style.overflowY = 'hidden'; };
  const addFiles = useCallback((incoming: File[]) => {
    let imageCount = files.filter(isImageFile).length; const next = [...files];
    let rejected = false;
    for (const file of incoming) { if (isImageFile(file)) { if (imageCount >= 10) { rejected = true; continue; } imageCount += 1; } next.push(file); }
    setAttachmentError(rejected ? 'Максимум 10 изображений на сообщение' : null);
    setFiles(next);
  }, [files]);
  const submit = () => { if (!isGenerating && (value.trim() || files.length)) { void sendMessage(value, files); setValue(''); setFiles([]); setAttachmentError(null); } };
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
  return <div className="composer-wrap"><div className="composer" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); addFiles([...event.dataTransfer.files]); }}>
    {files.length > 0 && <div className="attachment-draft">{files.map((file, index) => <DraftAttachment key={`${file.name}-${index}`} file={file} index={isImageFile(file) ? files.slice(0, index + 1).filter(isImageFile).length - 1 : index} onRemove={() => { setFiles((items) => items.filter((_, itemIndex) => itemIndex !== index)); setAttachmentError(null); }} />)}</div>}
    <input ref={inputRef} className="attachment-input" type="file" multiple accept=".png,.jpg,.jpeg,.webp,.txt,.md,.json,.csv,.log,.js,.ts,.jsx,.tsx,.html,.css,.yaml,.yml,.xml,.docx,.xlsx,.xls,.pdf" onChange={(event) => { addFiles([...(event.target.files ?? [])]); event.currentTarget.value = ''; }} />
    <button className="attach-button" type="button" disabled={isGenerating} title="Прикрепить файлы" onClick={() => inputRef.current?.click()}><Paperclip size={18} /></button>
    <textarea ref={ref} value={value} placeholder="Напишите сообщение…" rows={1} onPointerDown={startResize} onPointerUp={finishResize} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); } }} />
    <ContextUsage />{isGenerating ? <button className="send-button stop" onClick={() => void stop()} title="Остановить генерацию"><Square size={16} fill="currentColor" /></button> : <button className="send-button" disabled={!value.trim() && files.length === 0} onClick={submit} title="Отправить"><Send size={18} /></button>}
  </div>{attachmentError && <p className="attachment-error" role="status">{attachmentError}</p>}<p>Enter — отправить · Shift+Enter — новая строка · вставьте или перетащите файлы</p></div>;
}

function DraftAttachment({ file, index, onRemove }: { file: File; index: number; onRemove: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => { if (!isImageFile(file)) return; const next = URL.createObjectURL(file); setUrl(next); return () => URL.revokeObjectURL(next); }, [file]);
  return <div className={`attachment-draft-item ${url ? 'image' : ''}`}>{url ? <img src={url} alt={`Image ${index + 1}`} /> : <span className="attachment-file-icon">{file.name.split('.').at(-1)?.toUpperCase() ?? 'FILE'}</span>}<span className="attachment-number">{url ? index + 1 : file.name}</span><button type="button" title="Удалить вложение" onClick={onRemove}><X size={13} /></button></div>;
}
