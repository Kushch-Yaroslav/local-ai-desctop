import { english } from './translations';

export type Language = 'ru' | 'en';
let language: Language = 'en';
const listeners = new Set<() => void>();
export const getLanguage = () => language;
export function setLanguage(value: Language): void {
  if (value !== 'ru' && value !== 'en') throw new Error('Invalid language');
  if (language === value) return;
  language = value; listeners.forEach((listener) => listener());
}
export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
export function t(source: string): string { return language === 'en' ? english[source] ?? (english[source.trim()] ? source.replace(source.trim(), english[source.trim()]) : source) : source; }
export function tr(strings: TemplateStringsArray, ...values: unknown[]): string {
  const key = strings.reduce((result, part, index) => result + (index ? `{${index - 1}}` : '') + part, '');
  return t(key).replace(/\{(\d+)\}/g, (_match, index: string) => String(values[Number(index)]));
}
export function localizedLabels<T extends Record<string, string>>(labels: T): T {
  return new Proxy(labels, { get: (target, key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(target, key) ? t(target[key]) : Reflect.get(target, key) });
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const templates = Object.entries(english).filter(([key]) => /\{\d+\}/.test(key)).map(([ru, en]) => {
  const pattern = (text: string) => new RegExp('^' + text.split(/(\{\d+\})/).map((part) => /^\{\d+\}$/.test(part) ? '([\\s\\S]*?)' : escape(part)).join('') + '$');
  return { ru, en, ruPattern: pattern(ru), enPattern: pattern(en) };
});
const russian = Object.fromEntries(Object.entries(english).map(([ru, en]) => [en, ru]));
/** Only use on app-owned labels/errors. Never use on model answers, user text,
 * file contents, commands or tool raw output. Existing data is not rewritten. */
export function localizeMessage(message: string): string {
  const ipc = /^Error invoking remote method '[^']+': (?:Error: )?([\s\S]*)$/.exec(message);
  if (ipc) return localizeMessage(ipc[1]);
  const prefix = /^(Error: |[✓✕✗] )([\s\S]*)$/.exec(message);
  if (prefix) return prefix[1] + localizeMessage(prefix[2]);
  if ((language === 'ru' && english[message]) || (language === 'en' && russian[message])) return message;
  if (language === 'en' && english[message]) return english[message];
  if (language === 'ru' && russian[message]) return russian[message];
  for (const entry of templates) {
    const match = (language === 'en' ? entry.ruPattern : entry.enPattern).exec(message);
    if (match) return (language === 'en' ? entry.en : entry.ru).replace(/\{(\d+)\}/g, (_all, index: string) => match[Number(index) + 1] ?? '');
  }
  return message;
}
