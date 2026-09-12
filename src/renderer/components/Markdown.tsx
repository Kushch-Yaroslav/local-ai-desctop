import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

function CodeBlock({ children, className }: { children?: React.ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);
  const text = String(children).replace(/\n$/, '');
  const language = className?.replace('language-', '') ?? 'код';
  const copy = async () => { await navigator.clipboard.writeText(text); setCopied(true); window.setTimeout(() => setCopied(false), 1500); };
  return <div className="code-block"><div className="code-title"><span>{language}</span><button onClick={copy}>{copied ? 'Скопировано' : 'Копировать'}</button></div><pre><code className={className}>{children}</code></pre></div>;
}

export function Markdown({ children }: { children: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={{ pre: ({ children: child }) => <>{child}</>, code: ({ className, children: child, ...props }) => className ? <CodeBlock className={className}>{child}</CodeBlock> : <code {...props}>{child}</code> }}>{children}</ReactMarkdown>;
}
