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
  ActivityInfo,
  SubagentActivity,
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
  DeleteMessagesRequest,
  DeleteMessagesResponse,
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
  ListHistoryQuery,
  ConversationHistoryPage,
  ProjectListResponse,
  ConversationListResponse,
  ConversationHistoryListResponse,
  MessageListResponse,
  CreateProjectRequest,
  CreateConversationRequest,
  UpdateConversationRequest,
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

export type {
  SkillKind,
  SkillManifestEntry,
  CreateSkillRequest,
  UpdateSkillRequest,
  ImportSkillRequest,
  PrefillRequest,
  PrefillResult,
  SkillListResponse,
  SkillResponse,
  SkillDetailResponse,
  PrefillResponse,
  VaultSkillEntry,
  VaultSkillListResponse,
  VaultSkillToggleRequest,
} from './skill.js';

// SKILL.md generate/parse primitives (runtime values, shared daemon ↔ web).
export { generateSkillMd, stripFrontmatter, parseSkillMd } from './skillmd.js';
export type { ParsedSkillMd } from './skillmd.js';
