import { MessageSquarePlus, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { useAppStore } from '../store/app-store';

export function Sidebar() {
  const { conversations, models, activeId, createConversation, selectConversation, updateConversation, deleteConversation } = useAppStore();
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
  return <aside className="sidebar"><button className="new-chat" onClick={() => void createConversation()}><MessageSquarePlus size={18} /> Новый чат</button><div className="chat-list">{groupedChats.map(([date, chats]) => <section className="chat-date-group" key={date}><h2>{date}{date === 'Без даты' ? '' : ` · ${chats.length}`}</h2>{chats.map((chat) => <div className={`chat-row ${activeId === chat.id ? 'active' : ''}`} key={chat.id}><button className="chat-select" onClick={() => void selectConversation(chat.id)} title={chat.title}><span className="chat-title">{chat.title}</span><span className="model-badge">{shortModelName(chat.modelId)}</span></button><div className="chat-actions"><button aria-label="Переименовать" onClick={() => void rename(chat.id, chat.title)}><Pencil size={14} /></button><button aria-label="Удалить" onClick={() => void deleteConversation(chat.id)}><Trash2 size={14} /></button></div></div>)}</section>)}</div><div className="sidebar-footer"><MoreHorizontal size={16} /> Local AI Desktop</div></aside>;
}
