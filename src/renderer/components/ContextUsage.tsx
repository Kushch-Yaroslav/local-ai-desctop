import { useAppStore } from '../store/app-store';
import { formatContextTokens } from '../../shared/context-format';

export { formatContextTokens } from '../../shared/context-format';

export function ContextUsage() {
  const { conversations, activeId, activeContextWindow } = useAppStore();
  const chat = conversations.find((item) => item.id === activeId);
  if (!chat) return null;
  const maximum = activeContextWindow ?? chat.contextWindow;
  const current = chat.contextModelId === chat.modelId ? chat.contextTokens : null;
  const used = Math.min(current ?? 0, maximum); const percent = current === null ? 0 : Math.min(100, used / maximum * 100);
  const tone = percent >= 90 ? 'danger' : percent >= 80 ? 'warning' : percent >= 60 ? 'cool' : 'calm';
  const status = current === null ? 'Будет измерен после следующего ответа модели.' : percent >= 100 ? 'Старые сообщения уже начинают вытесняться.' : 'После достижения лимита самые ранние сообщения начнут вытесняться.';
  return <div className={`context-usage ${tone}`} title={`Контекст\nИспользовано: ${formatContextTokens(used)}\nМаксимум: ${formatContextTokens(maximum)}\nОсталось: ${formatContextTokens(Math.max(0, maximum - used))}\n${status}`} aria-label={`Контекст: ${percent.toFixed(1)}%`}><svg viewBox="0 0 36 36" aria-hidden="true"><circle className="context-track" cx="18" cy="18" r="15.5" /><circle className="context-progress" cx="18" cy="18" r="15.5" pathLength="100" strokeDasharray={`${percent} ${100 - percent}`} /></svg><span>{current === null ? '—' : `${Math.round(percent)}%`}</span></div>;
}
