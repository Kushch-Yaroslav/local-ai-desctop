export type SearchPreference = 'auto' | 'duckduckgo' | 'bing';
export function searchPreference(value: unknown): SearchPreference {
  if (value === undefined) return 'auto';
  if (value === 'auto' || value === 'duckduckgo' || value === 'bing') return value;
  throw new Error('Выберите Auto, DuckDuckGo или Bing. Прямой Google Search API недоступен для новых клиентов.');
}
