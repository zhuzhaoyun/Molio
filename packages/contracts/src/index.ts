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
  User,
  Entitlement,
  AuthStatus,
  SendCodeRequest,
  SendCodeResponse,
  VerifyRequest,
  TokenPair,
  VerifyResponse,
  RefreshRequest,
  RefreshResponse,
  MeResponse,
  UpdateMeRequest,
  SessionDeleteResponse,
  AccountDeleteResponse,
} from './auth.js';

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
  HubSkillSummary,
  HubSkillsQuery,
  HubSkillsListResponse,
  HubCategory,
  HubCategoriesResponse,
  InstallHubSkillRequest,
  InstallHubSkillResponse,
  HubSkillDetailQuery,
  HubSkillDetail,
  HubSkillDetailResponse,
} from './skill.js';

// SKILL.md generate/parse primitives (runtime values, shared daemon ↔ web).
export { generateSkillMd, stripFrontmatter, parseSkillMd, deriveSkillName } from './skillmd.js';
export type { ParsedSkillMd } from './skillmd.js';

export {
  MARKET_TAGS,
  MARKET_ICONS,
  MARKET_TINTS,
} from './market.js';
export type {
  MarketTag,
  MarketIcon,
  MarketTint,
  MarketListingSource,
  MarketListingStatus,
  MarketListing,
  MarketMyListing,
  MarketUploadTarget,
  MarketCreateRequest,
  MarketCreateResponse,
  MarketMyResponse,
  MarketDownloadResponse,
} from './market.js';
