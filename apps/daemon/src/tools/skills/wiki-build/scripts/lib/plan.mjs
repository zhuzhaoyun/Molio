import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CAPACITY, SCHEMA_VERSION } from './contracts.mjs';
import { atomicWriteJson, readJson, sha256 } from './workspace.mjs';

/**
 * @typedef {object} TopicNode
 * @property {string} id
 * @property {string} slug
 * @property {'branch'|'leaf'} kind
 * @property {number} depth
 * @property {number} estimatedPages
 * @property {number} estimatedIndexTokens
 * @property {TopicNode[]} [children]
 * @property {string[]} [fileIds]
 */

/**
 * @typedef {object} FileAssignment
 * @property {string} fileId
 * @property {string} primaryTopicId
 * @property {string[]} relatedTopicIds
 * @property {string} processor
 */

/**
 * @typedef {object} Batch
 * @property {string} id
 * @property {string} topicId
 * @property {number} order
 * @property {string[]} fileIds
 * @property {number} estimatedInputTokens
 */

const RESERVED_SLUGS = new Set(['index.md', 'log.md', 'hot.md', 'meta']);

function issue(errors, code, details = {}) {
  errors.push({ code, ...details });
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function fileIdFrom(value) {
  return typeof value === 'string' ? value : value?.fileId;
}

function exceedsCapacity(node, capacity) {
  return node.estimatedPages > capacity.maxLeafPages
    || node.estimatedIndexTokens > capacity.maxLeafIndexTokens;
}

function readApprovedVersions(paths) {
  const versions = [];
  if (existsSync(paths.plan)) {
    const plan = readJson(paths.plan);
    if (isPositiveInteger(plan.planVersion)) versions.push(plan.planVersion);
  }
  if (existsSync(paths.planHistory)) {
    for (const file of readdirSync(paths.planHistory)) {
      const match = /^plan-v(\d+)\.json$/.exec(file);
      if (match) versions.push(Number(match[1]));
    }
  }
  return versions;
}

/**
 * Validate a proposed semantic topic plan without writing it.
 * @param {object} candidate
 * @param {Array<{id: string}>} inventory
 * @param {string} inventoryDigest
 */
export function validatePlan(candidate, inventory, inventoryDigest) {
  const errors = [];
  if (!candidate || typeof candidate !== 'object') {
    return { valid: false, errors: [{ code: 'PLAN_NOT_OBJECT' }], topicCounts: { branch: 0, leaf: 0 } };
  }
  if (candidate.schemaVersion !== SCHEMA_VERSION) issue(errors, 'SCHEMA_VERSION_INVALID');
  if (candidate.inventoryDigest !== inventoryDigest) issue(errors, 'INVENTORY_DIGEST_MISMATCH');
  if (!isPositiveInteger(candidate.planVersion)) issue(errors, 'PLAN_VERSION_INVALID');

  const capacity = candidate.capacity && typeof candidate.capacity === 'object'
    ? candidate.capacity : DEFAULT_CAPACITY;
  for (const key of ['maxLeafPages', 'maxLeafIndexTokens', 'maxTopicDepth']) {
    if (!isPositiveInteger(capacity[key])) issue(errors, 'CAPACITY_INVALID', { field: key });
  }

  const topicIds = new Set();
  const slugs = new Set();
  const leaves = new Map();
  const topicCounts = { branch: 0, leaf: 0 };
  let topologyValid = true;
  const topics = Array.isArray(candidate.topics) ? candidate.topics : [];
  if (!Array.isArray(candidate.topics)) issue(errors, 'TOPICS_INVALID');

  const visitTopic = (topic, expectedDepth) => {
    if (!topic || typeof topic !== 'object') {
      issue(errors, 'TOPIC_INVALID');
      return;
    }
    if (typeof topic.id !== 'string' || !topic.id) issue(errors, 'TOPIC_ID_INVALID');
    else if (topicIds.has(topic.id)) issue(errors, 'TOPIC_ID_DUPLICATE', { id: topic.id });
    else topicIds.add(topic.id);
    if (typeof topic.slug !== 'string' || !topic.slug) issue(errors, 'TOPIC_SLUG_INVALID');
    else if (slugs.has(topic.slug)) issue(errors, 'TOPIC_SLUG_DUPLICATE', { slug: topic.slug });
    else {
      slugs.add(topic.slug);
      if (RESERVED_SLUGS.has(topic.slug.toLowerCase())) issue(errors, 'TOPIC_SLUG_RESERVED', { slug: topic.slug });
    }
    if (topic.depth !== expectedDepth) issue(errors, 'TOPIC_DEPTH_INVALID', { id: topic.id });
    if (topic.depth > capacity.maxTopicDepth) issue(errors, 'TOPIC_DEPTH_EXCEEDED', { id: topic.id });

    const children = Array.isArray(topic.children) ? topic.children : [];
    if (topic.kind === 'branch') {
      topicCounts.branch += 1;
      if (children.length < 2) {
        issue(errors, 'BRANCH_REQUIRES_TWO_CHILDREN', { id: topic.id });
        topologyValid = false;
      }
      if (Object.hasOwn(topic, 'fileIds')) issue(errors, 'BRANCH_HAS_FILE_IDS', { id: topic.id });
      if (topic.splitReason !== undefined && topic.splitReason !== 'capacity' && topic.splitReason !== 'semantic') {
        issue(errors, 'SPLIT_REASON_INVALID', { id: topic.id });
      }
      if (topic.splitReason === 'capacity' && !exceedsCapacity(topic, capacity)) {
        issue(errors, 'CAPACITY_SPLIT_BELOW_LIMIT', { id: topic.id });
      }
      // Descendant and reference diagnostics would only repeat the invalid branch shape.
      if (children.length >= 2) for (const child of children) visitTopic(child, expectedDepth + 1);
      return;
    }
    if (topic.kind !== 'leaf') issue(errors, 'TOPIC_KIND_INVALID', { id: topic.id });
    topicCounts.leaf += 1;
    if (!Array.isArray(topic.fileIds) || topic.fileIds.length === 0) issue(errors, 'LEAF_REQUIRES_FILE_IDS', { id: topic.id });
    if (children.length) issue(errors, 'LEAF_HAS_CHILDREN', { id: topic.id });
    if (exceedsCapacity(topic, capacity) && topic.indexStrategy !== 'shards') {
      issue(errors, 'LEAF_EXCEEDS_CAPACITY', { id: topic.id });
    }
    if (typeof topic.id === 'string' && !leaves.has(topic.id)) leaves.set(topic.id, topic);
  };
  for (const topic of topics) visitTopic(topic, 1);

  const inventoryIds = new Set(Array.isArray(inventory) ? inventory.map((record) => record.id) : []);
  const classifications = new Map();
  const classify = (fileId, source) => {
    if (typeof fileId !== 'string' || !fileId) {
      issue(errors, 'FILE_ID_INVALID', { source });
      return;
    }
    if (!inventoryIds.has(fileId)) issue(errors, 'FILE_ID_UNKNOWN', { fileId, source });
    if (classifications.has(fileId)) issue(errors, 'FILE_CLASSIFICATION_DUPLICATE', { fileId });
    else classifications.set(fileId, source);
  };

  const assignments = Array.isArray(candidate.assignments) ? candidate.assignments : [];
  if (!Array.isArray(candidate.assignments)) issue(errors, 'ASSIGNMENTS_INVALID');
  for (const assignment of assignments) {
    classify(assignment?.fileId, 'assignment');
    const leaf = leaves.get(assignment?.primaryTopicId);
    if (!leaf) {
      if (topologyValid) issue(errors, 'ASSIGNMENT_TOPIC_NOT_LEAF', { fileId: assignment?.fileId });
    } else if (!leaf.fileIds?.includes(assignment.fileId)) issue(errors, 'ASSIGNMENT_FILE_NOT_IN_TOPIC', { fileId: assignment.fileId });
  }
  for (const excluded of Array.isArray(candidate.excluded) ? candidate.excluded : []) classify(fileIdFrom(excluded), 'excluded');
  for (const undecided of Array.isArray(candidate.undecided) ? candidate.undecided : []) classify(fileIdFrom(undecided), 'undecided');
  for (const fileId of inventoryIds) {
    if (!classifications.has(fileId)) issue(errors, 'FILE_CLASSIFICATION_MISSING', { fileId });
  }

  const policy = candidate.batchPolicy;
  if (!policy || typeof policy !== 'object') issue(errors, 'BATCH_POLICY_INVALID');
  else {
    if (typeof policy.maxInputFraction !== 'number' || policy.maxInputFraction < 0.2 || policy.maxInputFraction > 0.3) {
      issue(errors, 'BATCH_INPUT_FRACTION_INVALID');
    }
    if (!Number.isInteger(policy.contextWindowTokens) || policy.contextWindowTokens < 1
      || policy.maxInputTokens !== Math.floor(policy.contextWindowTokens * policy.maxInputFraction)) {
      issue(errors, 'BATCH_INPUT_TOKENS_INVALID');
    }
  }
  const batches = Array.isArray(candidate.batches) ? candidate.batches : [];
  if (!Array.isArray(candidate.batches)) issue(errors, 'BATCHES_INVALID');
  const batchIds = new Set();
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index] ?? {};
    if (batch.order !== index + 1) issue(errors, 'BATCH_ORDER_INVALID', { id: batch.id });
    if (batchIds.has(batch.id)) issue(errors, 'BATCH_ID_DUPLICATE', { id: batch.id });
    else batchIds.add(batch.id);
    if (!leaves.has(batch.topicId) && topologyValid) issue(errors, 'BATCH_TOPIC_NOT_LEAF', { id: batch.id });
    if (!Array.isArray(batch.fileIds)) issue(errors, 'BATCH_FILE_IDS_INVALID', { id: batch.id });
    else {
      if (batch.fileIds.length > 50 || (policy?.maxFiles && batch.fileIds.length > policy.maxFiles)) issue(errors, 'BATCH_TOO_MANY_FILES', { id: batch.id });
      for (const fileId of batch.fileIds) if (!inventoryIds.has(fileId)) issue(errors, 'FILE_ID_UNKNOWN', { fileId, source: 'batch' });
    }
    if (!Number.isInteger(batch.estimatedInputTokens) || batch.estimatedInputTokens > policy?.maxInputTokens) {
      issue(errors, 'BATCH_INPUT_TOKENS_EXCEEDED', { id: batch.id });
    }
  }
  return { valid: errors.length === 0, errors, topicCounts };
}

export function saveDraft(paths, candidate) {
  atomicWriteJson(paths.planDraft, { ...candidate, status: 'draft' });
  return paths.planDraft;
}

export function approvePlan(paths, candidate) {
  const versions = readApprovedVersions(paths);
  const latest = versions.length ? Math.max(...versions) : 0;
  if (candidate.planVersion <= latest) {
    const error = new Error(`Plan version ${candidate.planVersion} is already frozen`);
    error.code = 'PLAN_VERSION_FROZEN';
    throw error;
  }
  if (latest && candidate.planVersion !== latest + 1) {
    const error = new Error(`Plan version must increment from ${latest}`);
    error.code = 'PLAN_VERSION_NOT_INCREMENTED';
    throw error;
  }
  const approved = { ...candidate, status: 'approved', approvedAt: new Date().toISOString() };
  approved.planDigest = sha256(approved);
  atomicWriteJson(paths.plan, approved);
  atomicWriteJson(join(paths.planHistory, `plan-v${String(candidate.planVersion).padStart(4, '0')}.json`), approved);
  return approved;
}
