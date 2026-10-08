import assert from 'node:assert/strict';
import { getLanguage, setLanguage, subscribeLanguage, t, tr, localizeMessage } from './locale';
import { chatModeLabel, deliverableStatusLabel, reasoningModeLabel } from './localization';
export function runLocaleRegression() {
  assert.equal(getLanguage(), 'ru');
  let changes = 0; const unsubscribe = subscribeLanguage(() => changes++);
  setLanguage('en'); assert.equal(changes, 1); setLanguage('en'); assert.equal(changes, 1);
  assert.equal(t('Да'), 'Yes'); assert.equal(t('Нет'), 'No'); assert.equal(t('Настроить модели'), 'Configure models');
  assert.equal(chatModeLabel.chat, 'Chat'); assert.equal(reasoningModeLabel.fast, 'Fast');
  assert.equal(deliverableStatusLabel.implemented, 'Implemented, not verified');
  assert.equal(tr`Проект ${2}: не выбран`, 'Project 2: not selected');
  assert.equal(localizeMessage('Не найден читаемый GGUF-файл: /my model.gguf'), 'Readable GGUF file not found: /my model.gguf');
  assert.equal(t('custom model /a/b'), 'custom model /a/b');
  setLanguage('ru'); assert.equal(t('Да'), 'Да'); assert.equal(chatModeLabel.chat, 'Чат');
  unsubscribe(); assert.equal(changes, 2);
}
if (require.main === module) runLocaleRegression();
