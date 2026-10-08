import { contextBridge, ipcRenderer } from 'electron';
import type { LocalAiApi } from '../shared/types';

const api: LocalAiApi = {
  conversations: {
    list: () => ipcRenderer.invoke('conversations:list'),
    create: (modelId) => ipcRenderer.invoke('conversations:create', modelId),
    update: (id, patch) => ipcRenderer.invoke('conversations:update', id, patch),
    delete: (id) => ipcRenderer.invoke('conversations:delete', id),
  },
  messages: { list: (conversationId) => ipcRenderer.invoke('messages:list', conversationId), edit: (id, content, fallback) => ipcRenderer.invoke('messages:edit', id, content, fallback), regenerate: (id) => ipcRenderer.invoke('messages:regenerate', id) },
  agentPlans: { get: (conversationId) => ipcRenderer.invoke('agent-plan:get', conversationId) },
  projects: { search: (conversationId, query) => ipcRenderer.invoke('projects:search', conversationId, query) },
  attachments: {
    import: (input) => ipcRenderer.invoke('attachments:import', input),
    list: (messageId) => ipcRenderer.invoke('attachments:list', messageId),
    dataUrl: (id) => ipcRenderer.invoke('attachments:dataUrl', id),
  },
  analysis: { list: (conversationId) => ipcRenderer.invoke('analysis:list', conversationId) },
  models: { list: () => ipcRenderer.invoke('models:list') },
  runtime: { state: () => ipcRenderer.invoke('runtime:state') },
  settings: { get: () => ipcRenderer.invoke('settings:get'), save: (config) => ipcRenderer.invoke('settings:save', config), dismissSetup: () => ipcRenderer.invoke('settings:dismissSetup') },
  hardware: { get: () => ipcRenderer.invoke('hardware:get') },
  contextEstimate: (modelId) => ipcRenderer.invoke('context:estimate', modelId),
  contextDiscover: (modelId) => ipcRenderer.invoke('context:discover', modelId),
  contextDiscoveryStatus: (modelId) => ipcRenderer.invoke('context:discovery-status', modelId),
  dialog: { chooseDirectory: (initialDirectory) => ipcRenderer.invoke('dialog:chooseDirectory', initialDirectory), chooseFile: () => ipcRenderer.invoke('dialog:chooseFile') },
  chat: {
    send: (request) => ipcRenderer.invoke('chat:send', request),
    steer: (conversationId, generationId, content, intent) => ipcRenderer.invoke('chat:steer', conversationId, generationId, content, intent),
    stop: (conversationId, generationId) => ipcRenderer.invoke('chat:stop', conversationId, generationId),
    approve: (request) => ipcRenderer.invoke('chat:approve', request),
    onStream: (listener) => { const callback = (_: unknown, event: Parameters<typeof listener>[0]) => listener(event); ipcRenderer.on('chat:stream', callback); return () => ipcRenderer.removeListener('chat:stream', callback); },
  },
};
contextBridge.exposeInMainWorld('localAi', api);
