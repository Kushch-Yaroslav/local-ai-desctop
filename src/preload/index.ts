import { contextBridge, ipcRenderer } from 'electron';
import type { LocalAiApi } from '../shared/types';

const api: LocalAiApi = {
  conversations: {
    list: () => ipcRenderer.invoke('conversations:list'),
    create: () => ipcRenderer.invoke('conversations:create'),
    update: (id, patch) => ipcRenderer.invoke('conversations:update', id, patch),
    delete: (id) => ipcRenderer.invoke('conversations:delete', id),
  },
  messages: { list: (conversationId) => ipcRenderer.invoke('messages:list', conversationId) },
  analysis: { list: (conversationId) => ipcRenderer.invoke('analysis:list', conversationId) },
  models: { list: () => ipcRenderer.invoke('models:list') },
  settings: { get: () => ipcRenderer.invoke('settings:get') },
  hardware: { get: () => ipcRenderer.invoke('hardware:get') },
  dialog: { chooseDirectory: () => ipcRenderer.invoke('dialog:chooseDirectory') },
  chat: {
    send: (request) => ipcRenderer.invoke('chat:send', request),
    stop: () => ipcRenderer.invoke('chat:stop'),
    onStream: (listener) => { const callback = (_: unknown, event: Parameters<typeof listener>[0]) => listener(event); ipcRenderer.on('chat:stream', callback); return () => ipcRenderer.removeListener('chat:stream', callback); },
  },
};
contextBridge.exposeInMainWorld('localAi', api);
