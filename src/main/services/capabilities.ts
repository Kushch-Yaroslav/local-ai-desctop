export type RuntimeCapabilities = {
  webAvailable: boolean;
  projectRoot?: string;
  projectWriteAvailable?: boolean;
  terminalAvailable?: boolean;
  terminalInitialCwd?: string;
};

/** One capability-aware instruction shared by Chat and Agent tool loops. */
export function capabilitySystemContext(capabilities: RuntimeCapabilities): string {
  const web = capabilities.webAvailable
    ? 'Доступен live web через инструменты web_search, web_open, web_read, web_follow_link и web_back. Для вопросов о сегодняшних событиях, текущих версиях, ценах, погоде, новостях и актуальной документации используй web-инструменты, а не память модели. Не говори, что у тебя нет доступа к интернету: он доступен через эти инструменты. При важных выводах используй несколько качественных, предпочтительно официальных источников. Доступ к web только для чтения и ограничен политикой безопасности приложения.'
    : 'Live web сейчас недоступен. Не утверждай, что проверил актуальные данные в интернете; честно сообщи об этой недоступности, если для ответа нужны текущие сведения.';
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
