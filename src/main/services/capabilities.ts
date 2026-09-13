export type RuntimeCapabilities = {
  webAvailable: boolean;
  projectRoot?: string;
  projectWriteAvailable?: boolean;
  terminalAvailable?: boolean;
};

/** One capability-aware instruction shared by Chat and Agent tool loops. */
export function capabilitySystemContext(capabilities: RuntimeCapabilities): string {
  const web = capabilities.webAvailable
    ? 'Доступен live web через инструменты web_search, web_open, web_read, web_follow_link и web_back. Для вопросов о сегодняшних событиях, текущих версиях, ценах, погоде, новостях и актуальной документации используй web-инструменты, а не память модели. Не говори, что у тебя нет доступа к интернету: он доступен через эти инструменты. При важных выводах используй несколько качественных, предпочтительно официальных источников. Доступ к web только для чтения и ограничен политикой безопасности приложения.'
    : 'Live web сейчас недоступен. Не утверждай, что проверил актуальные данные в интернете; честно сообщи об этой недоступности, если для ответа нужны текущие сведения.';
  const project = capabilities.projectRoot && capabilities.projectWriteAvailable
    ? ` Выбрана рабочая папка проекта: ${capabilities.projectRoot}. Доступны чтение и поиск файлов, apply_patch, создание файлов, удаление файла с подтверждением, git status/diff и run_terminal внутри этой папки. Терминал ограничен policy: безопасные диагностические команды запускаются сразу, рискованные запрашивают пользователя. Не говори, что у тебя нет доступа к файлам, patch или terminal, когда эти инструменты присутствуют. Сначала изучай файлы, затем меняй минимально, запускай проверки и читай результат.`
    : capabilities.projectRoot
      ? ` Выбрана рабочая папка проекта: ${capabilities.projectRoot}. Инструменты проекта доступны только для чтения.`
    : '';
  return `${web}${project}`;
}
