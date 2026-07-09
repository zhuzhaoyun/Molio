// ─── REST API types ───

/**
 * Chat message for conversation history.
 * Used in CreateRunRequest to pass prior messages for transcript building.
 */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  agentId?: string;
  runId?: string;
  // Assistant-only fields
  thinking?: string;
  tools?: ToolEvent[];
  usage?: {
    input?: number;
    output?: number;
    cost?: number;
  };
}

export interface ToolEvent {
  id: string;
  name: string;
  input: unknown;
  result?: string;
  isError?: boolean;
  status: 'running' | 'done' | 'error';
}

export interface CreateRunRequest {
  agentId: string;
  message: string;
  model?: string;
  cwd?: string;
  // Phase 2: Multi-turn conversation
  conversationId?: string;
  history?: ChatMessage[];
}

export interface RewindResendRequest {
  /** New user message content (edited text, or the original for regenerate). */
  newContent: string;
  agentId?: string;
  cwd?: string;
}

export interface RewindResendResponse {
  runId: string;
  conversationId: string;
}

export interface DeleteMessagesRequest {
  ids: string[];
}

export interface DeleteMessagesResponse {
  deleted: number;
}

export interface CreateRunResponse {
  runId: string;
  conversationId?: string;
}

export interface ToolResultRequest {
  toolUseId: string;
  content: string;
}

export interface AgentListResponse {
  agents: import('./agent.js').AgentInfo[];
}

export interface RunListResponse {
  runs: import('./run.js').RunInfo[];
}

export interface HealthResponse {
  status: 'ok';
  version: string;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}

// ─── Project & Conversation types (Phase 3) ───

export interface Project {
  id: string;
  name: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface Conversation {
  id: string;
  projectId: string;
  title: string | null;
  channelType?: string;
  externalSessionId?: string | null;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationHistoryItem {
  conversation: Conversation;
  lastMessage: ChatMessage | null;
  messageCount: number;
  vaultId?: string | null;
  vaultName?: string | null;
}

export interface ProjectListResponse {
  projects: Project[];
}

export interface ConversationListResponse {
  conversations: Conversation[];
}

export interface ConversationHistoryListResponse {
  conversations: ConversationHistoryItem[];
}

export interface ListHistoryQuery {
  /** undefined/null = all conversations; '__none__' = only unassociated (vault_id IS NULL) */
  vaultId?: string | null;
  /** Full-text search over message content. Empty = skip FTS. */
  query?: string;
  /** updated_at cursor (exclusive). Omit for first page. */
  before?: number;
  limit?: number;
}

export interface ConversationHistoryPage {
  items: ConversationHistoryItem[];
  nextCursor: number | null;
}

export interface MessageListResponse {
  messages: ChatMessage[];
}

export interface CreateProjectRequest {
  name: string;
  metadata?: Record<string, unknown>;
}

export interface CreateConversationRequest {
  title?: string;
}
