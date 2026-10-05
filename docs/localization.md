# Russian localization of the runtime and context UI

Internal values (reasoning mode `fast|deep`, chat mode `chat|agent`, statuses, model ids, protocol and event fields) are
never translated. They are mapped to text where they are shown (`src/shared/localization.ts`), so no logic depends on
the wording.

## Presentation layer

- Labels: Reasoning/Mode chips (`Быстро`/`Глубоко`, `Чат`/`Агент`, the same words as the toolbar selectors), Context popover
  (`Контекст`, `Входные токены`, `Выходные токены`, `Всего за запуск`, `Кэш промпта`, `Запись в кэш`, `Скорость` in
  `ток/с`, `Прошло`, `Ход`, `Действия`, `Сжатия`), timeline headings (`Размышляет`, `Размышлял 12 с`, `Чтение`,
  `Просмотр структуры проекта`, `$ Терминал`, `Контекст сжат`, `Агент остановлен`), terminal diagnostics
  (`каталог`, `статус`, `код выхода`, `Стандартный вывод`, `Вывод ошибок`), Task Planning (`План задач`) and attachments.
- Numbers and units: Russian grouping (`28 450`), plural-aware words (`1 токен`, `2 токена`, `5 токенов`, `2 записи знаний`),
  durations (`45 с`, `6 мин 12 с`, `1 ч 02 мин`), `МиБ`/`ГиБ`.
- Project identity labels built for the model (`Project 1 — name`) are shown as `Проект 1 — name`; the model-facing string
  is unchanged.
- Kept as they are: model ids, file paths, command output (`stdout`/`stderr` content), source code and technical terms
  that have no better Russian form (`llama.cpp`, `FP16`/`Q8`, `RAM`/`VRAM`, `KV`, `GPU`, `MTP`, `draft`, `launcher`).

## Max Context

Every user-facing Max Context text is Russian: the search button and summary (`Найти максимальный контекст`,
`Максимальный контекст: …`), the explanatory paragraph, the restored-result notice (`(сохранено)`), the VRAM budget
breakdown, the boundary reason (`предел модели`, `защитный порог памяти`, …), the diagnostics block, and the messages that
come from the main process: discovery progress and failures, why a KV mode was not offered, memory-estimate gaps
(`в журнале запуска нет …`), refusal reasons when a saved value no longer fits (`запустите «Найти максимальный контекст»
заново`), reserve-configuration errors, and the GPU, GGUF and VRAM-accounting errors that can surface there. These strings
exist only to be shown, so they are written in Russian at their source; logs keep their English event names.

## Guarding it

`src/shared/localization-coverage.test.ts` fails if English text appears in a renderer text node, `title`, `aria-label`,
`placeholder` or `alt`, if a previously English label comes back, or if a display-only message in the Max Context,
estimate, hardware, GGUF or VRAM sources is not Russian (protocol values such as `user_stop` are exempt).
`src/shared/localization.test.ts` covers the plural, duration and number helpers.
