export type ChatMode = 'chat' | 'agent';
export type BackendId = 'ollama' | 'llama-cpp';
export type AnalysisDepth = 'fast' | 'normal' | 'deep';

export interface ModelInfo {
  id: string;
  name: string;
  size?: number;
  backend: BackendId;
}

export interface Conversation {
  id: string;
  title: string;
  modelId: string | null;
  mode: ChatMode;
  workingDirectory: string | null;
  contextWindow: number;
  analysisDepth: AnalysisDepth;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
}

export interface HardwareStats {
  ramUsedBytes: number;
  ramTotalBytes: number;
  vramUsedBytes: number | null;
  vramTotalBytes: number | null;
  gpuUtilization: number | null;
  available: boolean;
}

export interface AppSettings {
  selectedBackend: BackendId;
  ollamaUrl: string;
  llamaServerPath: string | null;
  modelsPath: string;
}

export interface ChatRequest {
  conversationId: string;
  model: string;
  messages: ChatMessage[];
}

export interface ToolActivity {
  id: string;
  label: string;
  detail?: string;
}

export interface AnalysisRun {
  id: string;
  conversationId: string;
  assistantMessageId: string | null;
  depth: AnalysisDepth;
  status: 'running' | 'completed' | 'error' | 'cancelled';
  actionCount: number;
  actions: ToolActivity[];
  createdAt: string;
  completedAt: string | null;
}

export interface AnalysisProgress {
  stage: 'reconnaissance' | 'project-map' | 'prioritization' | 'investigation' | 'coverage' | 'synthesis';
  status: 'active' | 'complete';
}

export type StreamEvent =
  | { type: 'token'; content: string }
  | { type: 'tool'; activity: ToolActivity; runId?: string }
  | { type: 'analysis-run'; run: AnalysisRun }
  | { type: 'analysis'; progress: AnalysisProgress }
  | { type: 'context'; requested: number; active: number; supported?: number }
  | { type: 'done' }
  | { type: 'error'; message: string; details?: string };

export interface LocalAiApi {
  conversations: {
    list(): Promise<Conversation[]>;
    create(): Promise<Conversation>;
    update(id: string, patch: Partial<Pick<Conversation, 'title' | 'modelId' | 'mode' | 'workingDirectory' | 'contextWindow' | 'analysisDepth'>>): Promise<Conversation>;
    delete(id: string): Promise<void>;
  };
  messages: { list(conversationId: string): Promise<ChatMessage[]> };
  analysis: { list(conversationId: string): Promise<AnalysisRun[]> };
  models: { list(): Promise<ModelInfo[]> };
  settings: { get(): Promise<AppSettings> };
  hardware: { get(): Promise<HardwareStats> };
  dialog: { chooseDirectory(): Promise<string | null> };
  chat: {
    send(request: ChatRequest): Promise<void>;
    stop(): Promise<void>;
    onStream(listener: (event: StreamEvent & { conversationId: string }) => void): () => void;
  };
}
