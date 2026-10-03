import { memo, useEffect, useId, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { mermaidThemeVariables } from '../../shared/mermaid-theme';

// Mermaid configuration is global; serialize themed renders from different messages.
let mermaidQueue = Promise.resolve();

function MermaidBlock({ source }: { source: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const block = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const copyTimer = useRef<number | undefined>(undefined);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [svg, setSvg] = useState('');
  const [naturalWidth, setNaturalWidth] = useState(0);
  const [error, setError] = useState('');
  const [zoom, setZoom] = useState(1);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const preference = window.matchMedia('(prefers-color-scheme: dark)');
    const updateTheme = () => {
      const background = getComputedStyle(block.current ?? document.documentElement).getPropertyValue('--bg').trim();
      const hex = /^#([a-f\d]{6})$/i.exec(background)?.[1];
      const rgb = hex
        ? [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16))
        : background.match(/[\d.]+/g)?.slice(0, 3).map(Number);
      const dark = rgb?.length === 3 ? rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722 < 128 : preference.matches;
      setTheme(dark ? 'dark' : 'light');
    };
    const observer = new MutationObserver(updateTheme);
    for (const element of [document.documentElement, document.body]) {
      observer.observe(element, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    }
    preference.addEventListener('change', updateTheme);
    updateTheme();
    return () => {
      observer.disconnect();
      preference.removeEventListener('change', updateTheme);
      window.clearTimeout(copyTimer.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setSvg('');
    setNaturalWidth(0);
    setError('');
    setZoom(1);
    mermaidQueue = mermaidQueue.then(async () => {
      if (cancelled) return;
      const scratch = document.createElement('div');
      scratch.style.cssText = 'position:fixed;left:0;top:0;opacity:0;pointer-events:none;z-index:-1';
      scratch.setAttribute('aria-hidden', 'true');
      document.body.append(scratch);
      try {
        const { default: mermaid } = await import('mermaid');
        if (cancelled) return;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          suppressErrorRendering: true,
          theme: 'base',
          themeVariables: mermaidThemeVariables(theme),
          fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
          flowchart: { htmlLabels: true },
        });
        const result = await mermaid.render(`mermaid-${id}`, source, scratch);
        if (!cancelled) {
          const rendered = new DOMParser().parseFromString(result.svg, 'image/svg+xml').documentElement;
          const width = Number(rendered.getAttribute('viewBox')?.trim().split(/\s+/)[2]);
          setNaturalWidth(Number.isFinite(width) && width > 0 ? width : 0);
          setSvg(result.svg);
        }
      } catch {
        if (!cancelled) setError('Не удалось отобразить диаграмму. Проверьте исходный Mermaid-код.');
      } finally {
        scratch.remove();
      }
    });
    return () => { cancelled = true; };
  }, [id, source, theme]);

  const reset = () => {
    setZoom(1);
    viewport.current?.scrollTo({ left: 0, top: 0 });
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      setCopyError(false);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopyError(true);
    }
  };

  return <div className={`mermaid-block mermaid-${theme}${expanded ? ' mermaid-expanded' : ''}`} ref={block}>
    <div className="mermaid-toolbar">
      <span className="mermaid-title">Диаграмма</span>
      <div className="mermaid-controls" role="group" aria-label="Управление диаграммой">
        <button type="button" aria-label="Уменьшить диаграмму" disabled={!svg || zoom <= .5} onClick={() => setZoom(value => Math.max(.5, value - .25))}>−</button>
        <output aria-label="Масштаб">{Math.round(zoom * 100)}%</output>
        <button type="button" aria-label="Увеличить диаграмму" disabled={!svg || zoom >= 3} onClick={() => setZoom(value => Math.min(3, value + .25))}>+</button>
        <button type="button" disabled={!svg} onClick={reset}>Сбросить</button>
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? 'Свернуть' : 'Развернуть'}</button>
      </div>
    </div>
    <div className="mermaid-viewport" ref={viewport} tabIndex={0} role="region" aria-label="Диаграмма Mermaid. Для перемещения используйте прокрутку или перетаскивание." aria-busy={!svg && !error}
      onPointerDown={event => {
        if (event.button !== 0 || event.pointerType !== 'mouse' || !svg) return;
        drag.current = { x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        if (!drag.current) return;
        event.currentTarget.scrollLeft = drag.current.left + drag.current.x - event.clientX;
        event.currentTarget.scrollTop = drag.current.top + drag.current.y - event.clientY;
      }}
      onPointerUp={event => {
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => { drag.current = null; }}
      onLostPointerCapture={() => { drag.current = null; }}>
      {svg ? <div className="mermaid-canvas" style={{ width: `${zoom * 100}%`, minWidth: naturalWidth ? `${naturalWidth * zoom}px` : undefined }} dangerouslySetInnerHTML={{ __html: svg }} />
        : <p className="mermaid-status" role="status">{error || 'Отрисовка диаграммы…'}</p>}
    </div>
    <details className="mermaid-source" open={error ? true : undefined}>
      <summary>Исходный Mermaid-код</summary>
      <div className="mermaid-source-actions">
        <button type="button" onClick={copy}>{copied ? 'Скопировано' : 'Копировать код'}</button>
        {copyError && <span role="status">Не удалось скопировать. Выделите код ниже.</span>}
      </div>
      <pre><code>{source}</code></pre>
    </details>
  </div>;
}

function extractText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (typeof node === 'object' && 'props' in node) {
    const props = (node as { props?: { children?: React.ReactNode } }).props;
    return extractText(props?.children);
  }
  return '';
}

function CodeBlock({ children, className }: { children?: React.ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);
  const text = extractText(children).replace(/\n$/, '');
  const language = className?.replace('language-', '') ?? 'код';
  const copy = async () => { await navigator.clipboard.writeText(text); setCopied(true); window.setTimeout(() => setCopied(false), 1500); };
  return <div className="code-block"><div className="code-title"><span>{language}</span><button onClick={copy}>{copied ? 'Скопировано' : 'Копировать'}</button></div><pre><code className={className}>{children}</code></pre></div>;
}

function streamingSections(source: string): string[] {
  const sections: string[] = []; let current = ''; let fenced = false;
  for (const line of source.split(/(?<=\n)/)) {
    current += line;
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (!fenced && /^\s*$/.test(line)) { if (current) { sections.push(current); current = ''; } }
  }
  if (current) sections.push(current);
  return sections;
}

const MarkdownDocument = memo(function MarkdownDocument({ children }: { children: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={{
    pre: ({ children: child }) => <>{child}</>,
    code: ({ className, children: child, ...props }) => className?.split(/\s+/).includes('language-mermaid')
      ? <MermaidBlock source={extractText(child).replace(/\n$/, '')} />
      : className ? <CodeBlock className={className}>{child}</CodeBlock> : <code {...props}>{child}</code>,
    table: ({ children: child, ...props }) => <div className="markdown-table-scroll"><table className="markdown-table" {...props}>{child}</table></div>,
  }}>{children}</ReactMarkdown>;
});

/** Completed Markdown sections remain mounted; only the live tail is reparsed and revealed. */
export function Markdown({ children, streaming = false }: { children: string; streaming?: boolean }) {
  if (!streaming) return <MarkdownDocument>{children}</MarkdownDocument>;
  const sections = streamingSections(children);
  return <div className="markdown-stream">{sections.map((section, index) => {
    const live = index === sections.length - 1;
    return <div className={live ? 'stream-reveal' : undefined} key={live ? `tail-${section.length}` : `section-${index}`}><MarkdownDocument>{section}</MarkdownDocument></div>;
  })}</div>;
}
