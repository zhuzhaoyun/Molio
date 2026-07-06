// @molio/contracts — shared types for daemon, web, and desktop

export type {
  RuntimeAgentDef,
  RuntimeModelOption,
  RuntimeBuildOptions,
  RuntimeContext,
  AgentDetectSource,
  AgentInfo,
  InstallEvent,
  InstallSource,
  NpmNativeInstallSource,
  PlatformRequirement,
  InstallConfig,
  InstallPhase,
  ErrorCategory,
} from './agent.js';

export type {
  AgentEvent,
  UsageInfo,
  StreamHandler,
} from './event.js';

export type {
  RunStatus,
  RunInfo,
} from './run.js';

export type {
  CreateRunRequest,
  CreateRunResponse,
  RewindResendRequest,
  RewindResendResponse,
  ToolResultRequest,
  AgentListResponse,
  RunListResponse,
  HealthResponse,
  ApiError,
  // Phase 2: Multi-turn
  ChatMessage,
  ToolEvent,
  // Phase 3: Persistence
  Project,
  Conversation,
  ConversationHistoryItem,
  ProjectListResponse,
  ConversationListResponse,
  ConversationHistoryListResponse,
  MessageListResponse,
  CreateProjectRequest,
  CreateConversationRequest,
} from './api.js';

export type { SSEEnvelope } from './sse.js';

export type {
  Vault,
  TreeNode,
  IngestStatus,
  FileContent,
  KbHistoryEntry,
  CreateVaultRequest,
  VaultListResponse,
  FileTreeResponse,
  KbHistoryListResponse,
  // Wiki
  WikiOperationType,
  WikiStatusResponse,
  WikiBuildRequest,
  WikiIngestRequest,
  WikiLintRequest,
  WikiQueryRequest,
  WikiSaveRequest,
  WikiRunResponse,
  // Graph
  GraphNode,
  GraphEdge,
  GraphData,
  DeadLinkInfo,
  // Search
  SearchResult,
  SearchResponse,
} from './knowledge.js';
