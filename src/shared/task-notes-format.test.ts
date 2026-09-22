import assert from 'node:assert/strict';
import { parseTaskNotes } from './task-notes-format';

export function runTaskNotesFormatRegression(): void {
  const source = 'Project 1 — platform\n\nОсновные модули\n- Exchange\n* Deposit\n\nСледующий шаг\n1. Запустить npm test\n2. Прочитать src/main/app.ts';
  const blocks = parseTaskNotes(source);
  assert.deepEqual(blocks, [
    { kind: 'paragraph', lines: ['Project 1 — platform'] },
    { kind: 'paragraph', lines: ['Основные модули'] },
    { kind: 'unordered', lines: ['Exchange', 'Deposit'] },
    { kind: 'paragraph', lines: ['Следующий шаг'] },
    { kind: 'ordered', lines: ['Запустить npm test', 'Прочитать src/main/app.ts'] },
  ], 'Task Notes display parsing changed note text or lost simple list structure');
}

if (require.main === module) runTaskNotesFormatRegression();
