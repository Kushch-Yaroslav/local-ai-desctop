import { memo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

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
    code: ({ className, children: child, ...props }) => className ? <CodeBlock className={className}>{child}</CodeBlock> : <code {...props}>{child}</code>,
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
