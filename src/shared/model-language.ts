import { getLanguage, type Language } from './locale';

/** A request-level preference, never a translation of generated content. */
export function modelLanguageDirective(language: Language = getLanguage()): string {
  return language === 'ru'
    ? 'Язык интерфейса: русский. По умолчанию предпочитай русский для ответов, пояснений и предоставляемых моделью рассуждений. Явная просьба пользователя о другом языке имеет приоритет. Не переводи код, пути, идентификаторы инструментов или машинные протоколы.'
    : 'Interface language: English. By default prefer English for responses, explanations and model-provided reasoning. An explicit user request for another language takes priority. Do not translate code, paths, tool identifiers or machine-readable protocols.';
}
