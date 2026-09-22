export type ChatMode = 'chat' | 'agent';
export type WebMode = 'off' | 'auto';
export type BackendId = 'ollama' | 'llama-cpp';
/** A backend-native reasoning control. It never changes the output token budget. */
export type ReasoningMode = 'auto' | 'fast' | 'deep';
export type FinishReason = 'stop' | 'length' | 'cancelled' | 'error';
export type RiskCategory = 'git_commit' | 'git_push' | 'destructive_git' | 'package_install' | 'package_remove' | 'file_delete' | 'chmod_chown' | 'shell_redirection' | 'shell_chaining' | 'system_command';
export type ApprovalDecision = 'reject' | 'once' | 'session';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'session-approved';
export type AttachmentKind = 'image' | 'text' | 'document' | 'spreadsheet' | 'pdf';
export type AttachmentStatus = 'pending' | 'processing' | 'ready' | 'error' | 'cancelled' | 'ocr_required';

export interface Attachment {
  id: string;
  messageId: string;
  index: number;
  kind: AttachmentKind;
  mimeType: string;
  filename: string;
  size: number;
  storageRef: string;
  status: AttachmentStatus;
  extractedText?: string;
  structuredData?: string;
  visionAnalysis?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AttachmentInput {
  id?: string;
  messageId: string;
  index: number;
  filename: string;
  mimeType: string;
  /** Bytes are copied to application-managed storage in Electron main, never executed. */
  data: Uint8Array;
}

export interface ActionApproval {
  approvalId: string;
  category: RiskCategory;
  status: ApprovalStatus;
}

export interface GenerationDiagnostics {
  generationId: string;
  conversationId: string;
  reasoningMode: ReasoningMode;
  requestedMaxOutputTokens: number;
  effectiveMaxOutputTokens: number;
  contextLimit: number;
  inputTokens: number;
  agentStepCount: number;
  finishReason: FinishReason;
  /** All duration values are whole nanoseconds. Ollama reports them natively; llama.cpp milliseconds are converted and rounded. evalCount contains generated completion tokens only. */
  promptEvalCount?: number;
  promptEvalDuration?: number;
  evalCount?: number;
  evalDuration?: number;
  tokensPerSecond?: number;
  promptTokensPerSecond?: number;
  timeToFirstTokenMs?: number;
  /** Agent-only runtime diagnostics; persisted logs retain the full per-attempt detail. */
  ollamaRequestAttempt?: number;
  ollamaRetryCount?: number;
  toolResultContextSize?: number;
  toolResultContextBudget?: number;
  toolResultCompacted?: number;
  createdAt: string;
}

/** Message-owned subset of backend-authoritative completion metrics. */
export interface GenerationStats {
  /** Completion tokens reported by the backend. Reasoning runtimes may count visible and thinking tokens together. */
  outputTokens: number;
  tokensPerSecond?: number;
  generationDurationMs?: number;
  timeToFirstTokenMs?: number;
  inputTokens?: number;
}

export interface ModelInfo {
  id: string;
  name: string;
  size?: number;
  backend: BackendId;
  installed: boolean;
  quantization: string;
  maxContext: number;
  supportedContextPresets: number[];
  supportsTools: boolean;
  supportsReasoning: boolean;
  shortName: string;
}

export interface Conversation {
  id: string;
  title: string;
  modelId: string | null;
  mode: ChatMode;
  workingDirectory: string | null;
  /** Stable identity for the primary project. workingDirectory remains for old chats. */
  primaryProjectId: string | null;
  /** Optional second project. Its identity is independent of its slot. */
  secondaryWorkingDirectory: string | null;
  secondaryProjectId: string | null;
  contextWindow: number;
  reasoningMode: ReasoningMode;
  contextTokens: number | null;
  contextModelId: string | null;
  webMode: WebMode;
  createdAt: string;
  updatedAt: string;
}

export type ProjectReferenceKind = 'file' | 'folder';

/** A message-owned resource locator. projectPath is retained so changing a slot never retargets history. */
export interface ProjectReference {
  id: string;
  projectId: string;
  projectSlot: 1 | 2;
  projectPath: string;
  projectLabel: string;
  relativePath: string;
  kind: ProjectReferenceKind;
}

export type ProjectSuggestion = ProjectReference;

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  attachments?: Attachment[];
  projectReferences?: ProjectReference[];
  /** Native model reasoning, when the backend exposes it. It is never inferred from tool activity. */
  thinking?: string;
  /** Ordered reasoning/activity references for Agent turns. Older messages omit this. */
  thinkingTimeline?: ThinkingTimelineEvent[];
  /** Optional for conversations written before per-message generation statistics existed. */
  generationStats?: GenerationStats;
  /** Ephemeral base64 image inputs for Ollama. These are rebuilt from managed attachment storage and are never persisted in SQLite. */
  images?: string[];
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
  llamaRuntimeModelId?: string;
  modelsPath: string;
}

export interface ChatRequest {
  conversationId: string;
  model: string;
  /** Renderer mode snapshot for this logical generation, including Regenerate. */
  mode?: ChatMode;
  messages: ChatMessage[];
  generationId: string;
  persistUserMessage: boolean;
  attachmentIds?: string[];
  attachments?: AttachmentInput[];
}

export interface ToolActivity {
  id: string;
  label: string;
  detail?: string;
  /** User-visible execution category. Missing means a record saved by an older app version. */
  kind?: 'progress' | 'planning' | 'notes' | 'context' | 'file_read' | 'search' | 'directory' | 'terminal' | 'mutation' | 'git' | 'web' | 'other';
  /** Lifecycle of an action. Progress events are informational and never consume the Agent action budget. */
  state?: 'running' | 'completed' | 'error';
  /** Compact, user-facing fields shown only when this activity is expanded. */
  metadata?: Record<string, string | number | boolean | null>;
  /** Bounded command output or error text, rendered lazily when details are expanded. */
  output?: string;
  /** Full raw tool result for SQLite run history. It is stripped before IPC/UI rendering. */
  rawOutput?: string;
  approval?: ActionApproval;
  status?: AttachmentStatus;
  attachment?: Attachment;
  /** Ephemeral current-run plan snapshot. Database persistence deliberately strips this field. */
  plan?: AgentPlan;
  /** Monotonic event order within an Agent turn; assigned by the stream coordinator. */
  timelinePosition?: number;
}

export type ThinkingTimelineEvent =
  | { id: string; kind: 'reasoning'; content: string; position: number }
  | { id: string; kind: 'activity'; activityId: string; position: number };

export type AgentPlanStepStatus = 'pending' | 'in_progress' | 'completed';
export interface AgentPlanStep { id: string; label: string; status: AgentPlanStepStatus; }
export interface AgentPlan { steps: AgentPlanStep[]; }

export interface AnalysisRun {
  id: string;
  conversationId: string;
  assistantMessageId: string | null;
  reasoningMode: ReasoningMode;
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
  | { type: 'thinking'; content: string; timelinePosition?: number }
  | { type: 'tool'; activity: ToolActivity; runId?: string }
  | { type: 'attachment'; activity: ToolActivity }
  | { type: 'approval-request'; actionId: string; approval: ActionApproval }
  | { type: 'approval-resolved'; actionId: string; approvalId: string; status: Exclude<ApprovalStatus, 'pending'> }
  | { type: 'analysis-run'; run: AnalysisRun }
  | { type: 'analysis'; progress: AnalysisProgress }
  | { type: 'context'; requested: number; active: number; supported?: number }
  | { type: 'context-usage'; used: number; maximum: number }
  | { type: 'diagnostics'; diagnostics: Omit<GenerationDiagnostics, 'generationId' | 'conversationId' | 'createdAt'> }
  | { type: 'done'; assistant?: ChatMessage | null; finishReason?: FinishReason }
  | { type: 'cancelled' }
  | { type: 'error'; message: string; details?: string };

export interface LocalAiApi {
  conversations: {
    list(): Promise<Conversation[]>;
    create(modelId?: string): Promise<Conversation>;
    update(id: string, patch: Partial<Pick<Conversation, 'title' | 'modelId' | 'mode' | 'workingDirectory' | 'secondaryWorkingDirectory' | 'contextWindow' | 'reasoningMode' | 'webMode'>>): Promise<Conversation>;
    delete(id: string): Promise<void>;
  };
  messages: { list(conversationId: string): Promise<ChatMessage[]>; edit(id: string, content: string, fallback?: Pick<ChatMessage, 'conversationId' | 'content'>): Promise<ChatMessage[]>; regenerate(id: string): Promise<ChatMessage[]> };
  projects: { search(conversationId: string, query: string): Promise<ProjectSuggestion[]> };
  attachments: {
    import(input: AttachmentInput): Promise<Attachment>;
    list(messageId: string): Promise<Attachment[]>;
    dataUrl(id: string): Promise<string | null>;
  };
  analysis: { list(conversationId: string): Promise<AnalysisRun[]> };
  models: { list(): Promise<ModelInfo[]> };
  settings: { get(): Promise<AppSettings> };
  hardware: { get(): Promise<HardwareStats> };
  dialog: { chooseDirectory(initialDirectory?: string | null): Promise<string | null> };
  chat: {
    send(request: ChatRequest): Promise<void>;
    stop(conversationId: string, generationId?: string): Promise<void>;
    approve(request: { conversationId: string; generationId: string; approvalId: string; decision: ApprovalDecision }): Promise<boolean>;
    onStream(listener: (event: StreamEvent & { conversationId: string; generationId: string; modelId?: string }) => void): () => void;
  };
}
