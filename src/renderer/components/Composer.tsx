import { Send, Square } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/app-store';

export function Composer() {
  const [value, setValue] = useState(''); const ref = useRef<HTMLTextAreaElement>(null);
  const manualHeight = useRef<number | null>(null); const resizeHandle = useRef(false);
  const { sendMessage, stop, isGenerating } = useAppStore();
  const resetHeight = () => { const textarea = ref.current; if (!textarea) return; manualHeight.current = null; textarea.style.height = ''; textarea.style.overflowY = 'hidden'; };
  const submit = () => { if (!isGenerating && value.trim()) { void sendMessage(value); setValue(''); } };
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
  const startResize = (event: React.PointerEvent<HTMLTextAreaElement>) => {
    const { right, bottom } = event.currentTarget.getBoundingClientRect();
    resizeHandle.current = event.clientX > right - 28 && event.clientY > bottom - 28;
  };
  const finishResize = () => {
    if (!resizeHandle.current || !ref.current) return;
    resizeHandle.current = false;
    window.requestAnimationFrame(() => { if (ref.current) { manualHeight.current = ref.current.offsetHeight; ref.current.style.overflowY = 'auto'; } });
  };
  return <div className="composer-wrap"><div className="composer"><textarea ref={ref} value={value} placeholder="Напишите сообщение…" rows={1} onPointerDown={startResize} onPointerUp={finishResize} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); } }} />{isGenerating ? <button className="send-button stop" onClick={() => void stop()} title="Остановить генерацию"><Square size={16} fill="currentColor" /></button> : <button className="send-button" disabled={!value.trim()} onClick={submit} title="Отправить"><Send size={18} /></button>}</div><p>Enter — отправить · Shift+Enter — новая строка</p></div>;
}
