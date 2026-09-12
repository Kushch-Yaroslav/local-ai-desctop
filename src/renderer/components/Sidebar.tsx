import { MessageSquarePlus, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { useAppStore } from '../store/app-store';

export function Sidebar() {
  const { conversations, activeId, createConversation, selectConversation, updateConversation, deleteConversation } = useAppStore();
  const rename = async (id: string, title: string) => { const value = window.prompt('Название чата', title)?.trim(); if (value) await updateConversation(id, { title: value }); };
  return <aside className="sidebar"><button className="new-chat" onClick={() => void createConversation()}><MessageSquarePlus size={18} /> Новый чат</button><div className="chat-list">{conversations.map((chat) => <div className={`chat-row ${activeId === chat.id ? 'active' : ''}`} key={chat.id}><button className="chat-select" onClick={() => void selectConversation(chat.id)} title={chat.title}>{chat.title}</button><div className="chat-actions"><button aria-label="Переименовать" onClick={() => void rename(chat.id, chat.title)}><Pencil size={14} /></button><button aria-label="Удалить" onClick={() => void deleteConversation(chat.id)}><Trash2 size={14} /></button></div></div>)}</div><div className="sidebar-footer"><MoreHorizontal size={16} /> Local AI Desktop</div></aside>;
}
