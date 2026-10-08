import { useShallow } from 'zustand/react/shallow';
import { MessageSquarePlus, Settings, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { RuntimeSetup } from './RuntimeSetup';
import { useAppStore } from '../store/app-store';

export function Sidebar() {
  const [setupOpen, setSetupOpen] = useState(false);
  const openedAutomatically = useRef(false);
  const settings = useAppStore((state) => state.settings);
  useEffect(() => {
    if (settings?.setup?.autoOpen && !openedAutomatically.current) { openedAutomatically.current = true; setSetupOpen(true); }
  }, [settings?.setup?.autoOpen]);
  const closeSetup = () => {
    setSetupOpen(false);
    void window.localAi.settings.dismissSetup().then((updated) => useAppStore.setState({ settings: updated })).catch(() => undefined);
  };
  const { conversations, models, activeId, generationConversationId, createConversation, selectConversation, updateConversation, deleteConversation } = useAppStore(useShallow((state) => ({ conversations: state.conversations, models: state.models, activeId: state.activeId, generationConversationId: state.generationConversationId, createConversation: state.createConversation, selectConversation: state.selectConversation, updateConversation: state.updateConversation, deleteConversation: state.deleteConversation })));
  const rename = async (id: string, title: string) => { const value = window.prompt('Название чата', title)?.trim(); if (value) await updateConversation(id, { title: value }); };
  const formatDate = (value: string) => { const date = new Date(value); return Number.isNaN(date.valueOf()) ? null : new Intl.DateTimeFormat('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date); };
  const groups = new Map<string, typeof conversations>();
  [...conversations]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .forEach((chat) => { const key = formatDate(chat.createdAt) ?? 'Без даты'; groups.set(key, [...(groups.get(key) ?? []), chat]); });
  const groupedChats = [...groups.entries()].sort(([dateA, chatsA], [dateB, chatsB]) => {
    if (dateA === 'Без даты') return 1;
    if (dateB === 'Без даты') return -1;
    return chatsB[0].createdAt.localeCompare(chatsA[0].createdAt);
  });
  const shortModelName = (modelId: string | null) => models.find((model) => model.id === modelId)?.shortName ?? 'Модель не выбрана';
  const incomplete = Boolean(settings?.setup && !settings.setup.ready);
  return <aside className="sidebar"><button className="new-chat" onClick={() => void createConversation()}><MessageSquarePlus size={18} /> Новый чат</button><div className="chat-list">{groupedChats.map(([date, chats]) => <section className="chat-date-group" key={date}><h2>{date}{date === 'Без даты' ? '' : ` · ${chats.length}`}</h2>{chats.map((chat) => <div className={`chat-row ${activeId === chat.id ? 'active' : ''}`} key={chat.id}><button className="chat-select" onClick={() => void selectConversation(chat.id)} title={chat.title}><span className="chat-title">{chat.title}</span><span className="model-badge">{generationConversationId === chat.id ? '● Выполняется · ' : ''}{shortModelName(chat.modelId)}</span></button><div className="chat-actions"><button aria-label="Переименовать" onClick={() => void rename(chat.id, chat.title)}><Pencil size={14} /></button><button aria-label="Удалить" disabled={generationConversationId === chat.id} onClick={() => void deleteConversation(chat.id)}><Trash2 size={14} /></button></div></div>)}</section>)}</div><button className={`sidebar-footer runtime-setup-action${incomplete ? ' needs-setup' : ' is-ready'}`} onClick={() => setSetupOpen(true)} disabled={!settings?.setup} aria-label={incomplete ? 'Настроить модели, настройка не завершена' : 'Настройки моделей и runtime'}><Settings size={18} /><span className="runtime-setup-action-copy"><strong>{incomplete ? 'Настроить модели' : 'Модели и runtime'}</strong><small>{incomplete ? 'Добавьте модель и llama-server' : 'Настройка готова'}</small></span></button>{setupOpen && settings?.setup && <RuntimeSetup setup={settings.setup} onClose={closeSetup} />}</aside>;
}
