export const SCHEMA_VERSION = 1;
export const MAX_DIR_ENTRIES = 1000;
export const MAX_TOTAL = 50000;
export const DEFAULT_CAPACITY = Object.freeze({
  maxLeafPages: 200,
  maxLeafIndexTokens: 12000,
  maxTopicDepth: 6,
});
export const FILE_STATUSES = Object.freeze([
  'pending', 'running', 'succeeded', 'failed', 'skipped',
]);
export const BATCH_STATUSES = FILE_STATUSES;
export const BUILD_PHASES = Object.freeze([
  'not_started', 'scanned', 'draft', 'approved', 'running',
  'paused', 'completed', 'completed_with_errors',
]);
