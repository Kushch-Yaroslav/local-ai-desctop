import type { ChatMessage } from '../../shared/types';

export type RuntimeCapabilities = {
  webAvailable: boolean;
  projectRoot?: string;
  projectWriteAvailable?: boolean;
  terminalAvailable?: boolean;
  terminalInitialCwd?: string;
};

/** Chat-only instruction: Agent has its own execution policy and must remain separate. */
export function chatCompletionGuidance(mode: 'fast' | 'deep' = 'deep'): string {
  const boundaries = 'Отвечай только по доступным сообщениям, результатам инструментов и явно указанным данным. В Chat нет инструментов файловой системы или terminal: не ищи скрытые инструменты и не проверяй это повторно. Не выдумывай доступ, результаты инструментов или доказательства. Если пользователь явно общается на одном языке, отвечай последовательно на этом языке, если он не просит другой. Не вставляй символы или слова из несвязанных систем письма, кроме случаев, когда это намеренно нужно для запроса, цитаты или исходного текста, кода, идентификаторов, имён, URL, технических данных или многоязычного содержания.';
  if (mode === 'fast') return `${boundaries} Рассуждай кратко и переходи к прямому ответу без ненужного предварительного анализа. Если часть запроса недоступна, отметь это один раз и дай сфокусированную полезную часть ответа; не разворачивай блокер в большой отчёт без явной необходимости.`;
  return `${boundaries} Отсутствие данных или инструмента ограничивает только связанные с ними утверждения: отметь это ограничение один раз и продолжай максимально полезную часть задачи. Если пользователь запросил структуру, разделы, checklist или deliverable, сохраняй их, когда это не вводит в заблуждение. Чётко различай подтверждённые факты, непроверенные предположения и следующие шаги. Не проси уточнение либо файлы, пока уже можно дать содержательный частичный ответ.`;
}

/** Complete system context for ordinary Chat mode. */
export function chatSystemContext(capabilities: RuntimeCapabilities, mode: 'fast' | 'deep' = 'deep'): string {
  return `${chatCompletionGuidance(mode)}\n${capabilitySystemContext(capabilities)}`;
}

/**
 * llama.cpp requires every system message to precede the conversational turns.
 * Older persisted turns and the continuation feature can contain a system
 * instruction in history, so retain its text but compose it into one prefix.
 */
export function chatMessagesWithSystemPrefix(history: ChatMessage[], fragments: string[], conversationId: string, id: string): ChatMessage[] {
  const historicalSystem = history.filter((message) => message.role === 'system').map((message) => message.content);
  const prefix = [...fragments, ...historicalSystem].map((content) => content.trim()).filter(Boolean).join('\n\n');
  const conversation = history.filter((message) => message.role !== 'system');
  return prefix ? [{ id, conversationId, role: 'system', content: prefix, createdAt: new Date().toISOString() }, ...conversation] : conversation;
}

/** One capability-aware instruction shared by Chat and Agent tool loops. */
export function capabilitySystemContext(capabilities: RuntimeCapabilities): string {
  const web = capabilities.webAvailable
    ? 'Доступен live web через инструменты web_search, web_open, web_read, web_follow_link и web_back. Для вопросов о сегодняшних событиях, текущих версиях, ценах, погоде, новостях и актуальной документации используй web-инструменты, а не память модели. Не говори, что у тебя нет доступа к интернету: он доступен через эти инструменты. При важных выводах используй несколько качественных, предпочтительно официальных источников. Доступ к web только для чтения и ограничен политикой безопасности приложения.'
    : 'Live web сейчас недоступен. Не утверждай, что проверил актуальные данные в интернете; если это критично для вывода, отметь ограничение один раз.';
  const project = capabilities.projectRoot && capabilities.projectWriteAvailable
    ? ` Выбрана рабочая папка проекта: ${capabilities.projectRoot}. Project filesystem tools доступны только внутри неё: чтение и поиск файлов, apply_patch, создание, удаление файла с подтверждением, git status/diff. Сначала изучай файлы, затем меняй минимально, запускай проверки и читай результат.`
    : capabilities.projectRoot
      ? ` Выбрана рабочая папка проекта: ${capabilities.projectRoot}. Инструменты проекта доступны только для чтения.`
      : '';
  const terminal = capabilities.terminalAvailable
    ? ` Доступен run_terminal. Его начальная папка: ${capabilities.terminalInitialCwd ?? 'домашняя папка пользователя'}. Terminal не ограничен project root и может работать с пользовательскими путями, включая ~/.config и ~/.local. Без подтверждения запускай только безопасные пользовательские и диагностические команды; системные, привилегированные или разрушительные команды требуют подтверждения. Не говори, что terminal недоступен только из-за отсутствия проекта.`
    : '';
  return `${web}${project}${terminal}`;
}
