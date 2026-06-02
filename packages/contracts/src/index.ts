// @kge/contracts — shared types for daemon, web, and desktop

export type {
  RuntimeAgentDef,
  RuntimeModelOption,
  RuntimeBuildOptions,
  RuntimeContext,
  AgentDetectSource,
  AgentInfo,
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
  ProjectListResponse,
  ConversationListResponse,
  MessageListResponse,
  CreateProjectRequest,
  CreateConversationRequest,
} from './api.js';

export type { SSEEnvelope } from './sse.js';
