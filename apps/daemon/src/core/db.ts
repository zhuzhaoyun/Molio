/**
 * SQLite persistence layer for projects, conversations, and messages.
 * Adapted from open-design's db.ts, simplified for Molio's scope.
 *
 * Database file: ~/.molio/app.sqlite (WAL mode, foreign keys)
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ChatMessage, Project, Conversation, ConversationHistoryItem, ConversationHistoryPage, ListHistoryQuery, Vault, KbHistoryEntry } from '@molio/contracts';

type SqliteDb = Database.Database;

export const CHANNELS_PROJECT_ID = '__molio_channels__';
export const DESKTOP_PROJECT_ID = '__molio_desktop__';

let dbInstance: SqliteDb | null = null;
let dbFile: string | null = null;

/**
 * Migrate legacy data directory from ~/.kge to ~/.molio.
 * Only runs once: if ~/.molio doesn't exist but ~/.kge does, rename it.
 */
function migrateLegacyDir(): void {
  const legacyDir = path.join(os.homedir(), '.kge');
  const newDir = path.join(os.homedir(), '.molio');

  if (!fs.existsSync(legacyDir) || fs.existsSync(newDir)) return;

  try {
    fs.renameSync(legacyDir, newDir);
    console.log(`Migrated data directory: ${legacyDir} → ${newDir}`);
  } catch (err) {
    console.error(`Failed to migrate ${legacyDir} → ${newDir}:`, err);
  }
}

/**
 * Open (or return existing) SQLite database.
 * Creates the data directory and runs migrations on first open.
 */
export function openDatabase(dataDir?: string): SqliteDb {
  if (!dataDir) migrateLegacyDir();

  const dir = dataDir ?? path.join(os.homedir(), '.molio');
  const file = path.join(dir, 'app.sqlite');

  if (dbInstance && dbFile === file) return dbInstance;
  if (dbInstance) closeDatabase();

  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  assertSqliteVersion(db);
  migrate(db);
  dbInstance = db;
  dbFile = file;
  return db;
}

export function closeDatabase(_db?: SqliteDb): void {
  if (!dbInstance) return;
  dbInstance.close();
  dbInstance = null;
  dbFile = null;
}

function migrate(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT,
      channel_type TEXT NOT NULL DEFAULT 'desktop',
      external_session_id TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_conv_project
      ON conversations(project_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      agent_id TEXT,
      run_id TEXT,
      agent_name TEXT,
      events_json TEXT,
      started_at INTEGER,
      ended_at INTEGER,
      position INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conv
      ON messages(conversation_id, position);

    CREATE TABLE IF NOT EXISTS vaults (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kb_history (
      id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(vault_id) REFERENCES vaults(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_kb_history_vault
      ON kb_history(vault_id, created_at DESC);

    -- Global skill library: metadata + the master switch (replaces the old
    -- ~/.molio/skills/manifest.json). kind: 'bundled' (multi-file, shipped) |
    -- 'library' (single-file, user-managed). core=1 marks the writing trio --
    -- hidden, always-on, not configurable (exempt from the enabled switch).
    -- A skill body stays a file; this table only holds config.
    CREATE TABLE IF NOT EXISTS skills (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      kind        TEXT NOT NULL DEFAULT 'library',
      core        INTEGER NOT NULL DEFAULT 0,
      built_in    INTEGER NOT NULL DEFAULT 0,
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Skill-hub (skillhub.cn) install registry: which hub skills are installed
    -- and which local skill row they became. Identity is (namespace, slug) —
    -- hub slugs are NOT globally unique, same-slug skills from different
    -- namespaces coexist. Lets the store UI show an "installed/update" state
    -- and lets reinstall refresh the same skill id in place (keeping the
    -- master-switch state). Deleting the skill row removes the mapping
    -- (routes/skills.ts DELETE handler).
    CREATE TABLE IF NOT EXISTS hub_skill_installs (
      slug         TEXT NOT NULL,
      skill_id     TEXT NOT NULL,
      version      TEXT NOT NULL DEFAULT '',
      namespace    TEXT NOT NULL DEFAULT '',
      installed_at INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      PRIMARY KEY (namespace, slug)
    );
  `);

  // hub_skill_installs was first shipped (pre-release) with slug alone as the
  // PRIMARY KEY; rebuild it with the composite (namespace, slug) PK while
  // preserving rows. Detection: in the old schema namespace carries pk=0.
  const hubCols = db.prepare('PRAGMA table_info(hub_skill_installs)').all() as Array<{ name: string; pk: number }>;
  const hubNsCol = hubCols.find((c) => c.name === 'namespace');
  if (hubNsCol && hubNsCol.pk === 0) {
    db.exec(`
      CREATE TABLE hub_skill_installs_new (
        slug         TEXT NOT NULL,
        skill_id     TEXT NOT NULL,
        version      TEXT NOT NULL DEFAULT '',
        namespace    TEXT NOT NULL DEFAULT '',
        installed_at INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        PRIMARY KEY (namespace, slug)
      );
      INSERT OR REPLACE INTO hub_skill_installs_new
        (slug, skill_id, version, namespace, installed_at, updated_at)
        SELECT slug, skill_id, version, namespace, installed_at, updated_at FROM hub_skill_installs;
      DROP TABLE hub_skill_installs;
      ALTER TABLE hub_skill_installs_new RENAME TO hub_skill_installs;
    `);
  }

  addColumnIfMissing(db, 'conversations', 'channel_type', "TEXT NOT NULL DEFAULT 'desktop'");
  addColumnIfMissing(db, 'conversations', 'external_session_id', 'TEXT');
  addColumnIfMissing(db, 'conversations', 'metadata_json', 'TEXT');
  addColumnIfMissing(db, 'conversations', 'closed_at', 'INTEGER');
  addColumnIfMissing(db, 'messages', 'run_id', 'TEXT');

  // Rebuild the external session unique index to only enforce uniqueness
  // on open (non-closed) conversations. This allows /new to create a fresh
  // conversation while preserving the old one for history.
  db.exec(`DROP INDEX IF EXISTS idx_conv_external_session`);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_external_session_open
      ON conversations(channel_type, external_session_id)
      WHERE external_session_id IS NOT NULL AND closed_at IS NULL;
  `);

  // vault_id on conversations (nullable; no FK — deleting a vault must not
  // cascade-delete conversations). Surfaced as a history filter dimension.
  addColumnIfMissing(db, 'conversations', 'vault_id', 'TEXT');
  addColumnIfMissing(db, 'conversations', 'vault_name', 'TEXT');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_conversations_vault
           ON conversations(vault_id, updated_at DESC)`);

  addColumnIfMissing(db, 'conversations', 'pinned_at', 'INTEGER');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_conversations_pinned_at
           ON conversations(pinned_at) WHERE pinned_at IS NOT NULL`);

  // Full-text search over message content. trigram tokenizer: CJK substring
  // friendly, case-insensitive, no external jieba dependency (SQLite >= 3.34).
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content, conversation_id UNINDEXED, message_id UNINDEXED,
      tokenize = 'trigram'
    );

    CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(content, conversation_id, message_id)
        VALUES (new.content, new.conversation_id, new.id);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
      DELETE FROM messages_fts WHERE message_id = old.id;
    END;
    CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
      DELETE FROM messages_fts WHERE message_id = old.id;
      INSERT INTO messages_fts(content, conversation_id, message_id)
        VALUES (new.content, new.conversation_id, new.id);
    END;
  `);

  // One-time backfill of pre-existing messages. Guarded by kv flag so repeated
  // openDatabase calls stay O(1). Disaster recovery uses POST /api/maintenance/rebuild-fts.
  if (!getKv(db, 'fts_seeded')) {
    db.exec(`INSERT INTO messages_fts(content, conversation_id, message_id)
             SELECT content, conversation_id, id FROM messages;`);
    setKv(db, 'fts_seeded', '1');
  }
}

function addColumnIfMissing(db: SqliteDb, table: string, column: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function assertSqliteVersion(db: SqliteDb): void {
  const row = db.prepare('SELECT sqlite_version() AS v').get() as { v: string };
  const [maj, min] = row.v.split('.').map(Number) as [number, number];
  if (maj < 3 || (maj === 3 && min < 34)) {
    throw new Error(
      `SQLite >= 3.34 required for trigram FTS5 tokenizer (got ${row.v}). ` +
      `Upgrade better-sqlite3 to a build bundling SQLite >= 3.34.`,
    );
  }
}

// ─── Project CRUD ───

export function listProjects(db: SqliteDb): Project[] {
  const rows = db.prepare(
    'SELECT * FROM projects WHERE id NOT IN (?, ?) ORDER BY updated_at DESC'
  ).all(CHANNELS_PROJECT_ID, DESKTOP_PROJECT_ID) as Array<Record<string, unknown>>;
  return rows.map(rowToProject);
}

export function getProject(db: SqliteDb, id: string): Project | null {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToProject(row) : null;
}

export function createProject(db: SqliteDb, name: string, metadata?: Record<string, unknown>): Project {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    'INSERT INTO projects (id, name, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, name, metadata ? JSON.stringify(metadata) : null, now, now);
  return { id, name, metadata, createdAt: now, updatedAt: now };
}

export function ensureChannelsProject(db: SqliteDb): Project {
  const existing = getProject(db, CHANNELS_PROJECT_ID);
  if (existing) return existing;

  const now = Date.now();
  const metadata = { system: true, purpose: 'channels' };
  db.prepare(
    'INSERT INTO projects (id, name, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(CHANNELS_PROJECT_ID, 'Molio Channels', JSON.stringify(metadata), now, now);
  return {
    id: CHANNELS_PROJECT_ID,
    name: 'Molio Channels',
    metadata,
    createdAt: now,
    updatedAt: now,
  };
}

export function ensureDesktopProject(db: SqliteDb): Project {
  const existing = getProject(db, DESKTOP_PROJECT_ID);
  if (existing) return existing;

  const now = Date.now();
  const metadata = { system: true, purpose: 'desktop' };
  db.prepare(
    'INSERT INTO projects (id, name, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(DESKTOP_PROJECT_ID, 'Molio Desktop', JSON.stringify(metadata), now, now);
  return {
    id: DESKTOP_PROJECT_ID,
    name: 'Molio Desktop',
    metadata,
    createdAt: now,
    updatedAt: now,
  };
}

export function deleteProject(db: SqliteDb, id: string): void {
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
}

// ─── Conversation CRUD ───

export function listConversations(db: SqliteDb, projectId: string): Conversation[] {
  const rows = db.prepare(
    'SELECT * FROM conversations WHERE project_id = ? ORDER BY updated_at DESC'
  ).all(projectId) as Array<Record<string, unknown>>;
  return rows.map(rowToConversation);
}

/**
 * Search message content via the messages_fts trigram index. Returns the set
 * of conversation_ids whose messages match `query` (substring / phrase match).
 * Empty/whitespace query returns [] — the caller MUST short-circuit (skip the
 * FTS subquery entirely) on empty so the plain filter path stays fast.
 *
 * The raw query is sanitized into an FTS5 string literal: internal double
 * quotes are doubled, newlines become spaces, and the result is wrapped in
 * double quotes so FTS5 operator characters (`*` `:` `"`) are treated as
 * literal phrase content. With the trigram tokenizer a phrase match is a
 * substring match.
 *
 * The trigram tokenizer requires ≥3 characters to form any trigram, so a
 * 1- or 2-character query (e.g. the Chinese word "修仙") would match nothing
 * even when the content contains "凡人修仙传". For sanitized queries shorter
 * than 3 characters we fall back to a `LIKE '%q%'` scan over `messages.content`
 * (acceptable: short queries are rare and yield small result sets). LIKE
 * wildcards (`%` `_`) in the query are escaped with `ESCAPE '\'`. SQLite LIKE
 * is case-insensitive for ASCII by default, which suffices for latin content;
 * CJK has no case distinction.
 */
export function searchConversationIds(db: SqliteDb, query: string): string[] {
  const trimmed = query.replace(/[\r\n]+/g, ' ').trim();
  if (!trimmed) return [];
  const truncated = trimmed.slice(0, 200);

  // Short-query fallback: trigram FTS5 cannot match < 3 chars. Use a LIKE
  // scan over the source messages table instead.
  if (truncated.length < 3) {
    const escaped = truncated.replace(/[%_\\]/g, '\\$&');
    const rows = db
      .prepare(
        "SELECT DISTINCT conversation_id FROM messages WHERE content LIKE ? ESCAPE '\\'",
      )
      .all(`%${escaped}%`) as Array<{ conversation_id: string }>;
    return rows.map((r) => r.conversation_id);
  }

  const escaped = truncated.replace(/"/g, '""');
  const rows = db
    .prepare('SELECT DISTINCT conversation_id FROM messages_fts WHERE messages_fts MATCH ?')
    .all(`"${escaped}"`) as Array<{ conversation_id: string }>;
  return rows.map((r) => r.conversation_id);
}

/**
 * Rebuild the messages_fts index from scratch by repopulating from `messages`
 * (the source of truth). Used by POST /api/maintenance/rebuild-fts as a
 * disaster-recovery lever if the FTS index becomes corrupted/emptied.
 *
 * The DELETE + INSERT are wrapped in a transaction so a failure during
 * repopulation rolls back the delete (the FTS index is never left emptied).
 */
export function rebuildMessagesFts(db: SqliteDb): void {
  const rebuild = db.transaction(() => {
    db.exec('DELETE FROM messages_fts');
    db.exec(`INSERT INTO messages_fts(content, conversation_id, message_id)
             SELECT content, conversation_id, id FROM messages`);
  });
  rebuild();
}

export function listConversationHistory(
  db: SqliteDb,
  opts: ListHistoryQuery = {},
): ConversationHistoryPage {
  const limit = clampHistoryLimit(opts.limit);

  // If a search query is provided, resolve matching conversation_ids first.
  let hitIds: string[] | null = null;
  if (opts.query && opts.query.trim()) {
    hitIds = searchConversationIds(db, opts.query);
    if (hitIds.length === 0) return { pinnedItems: [], items: [], nextCursor: null };
  }

  // Shared filter builder: vault + search hit set (+ optional before cursor).
  const buildFilters = (withBefore: boolean): { where: string[]; params: unknown[] } => {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.vaultId === '__none__') {
      where.push('c.vault_id IS NULL');
    } else if (opts.vaultId) {
      where.push('c.vault_id = ?');
      params.push(opts.vaultId);
    }
    if (hitIds) {
      where.push(`c.id IN (${hitIds.map(() => '?').join(', ')})`);
      params.push(...hitIds);
    }
    if (withBefore && opts.before != null && !Number.isNaN(opts.before)) {
      where.push('c.updated_at < ?');
      params.push(opts.before);
    }
    return { where, params };
  };

  const baseSelect = `
    SELECT
      c.*,
      COALESCE(v.name, c.vault_name) AS vault_name,
      (v.name IS NOT NULL) AS vault_exists,
      COALESCE(stats.message_count, 0) AS message_count,
      lm.id AS last_id,
      lm.role AS last_role,
      lm.content AS last_content,
      lm.agent_id AS last_agent_id,
      lm.run_id AS last_run_id,
      lm.events_json AS last_events_json,
      lm.created_at AS last_created_at
    FROM conversations c
    LEFT JOIN vaults v ON v.id = c.vault_id
    LEFT JOIN (
      SELECT conversation_id, COUNT(*) AS message_count, MAX(position) AS max_position
      FROM messages
      GROUP BY conversation_id
    ) stats ON stats.conversation_id = c.id
    LEFT JOIN messages lm
      ON lm.conversation_id = c.id AND lm.position = stats.max_position
  `;

  // Pinned: full set, filtered, ordered by recency. Not paginated (small).
  const pinnedF = buildFilters(false);
  pinnedF.where.push('c.pinned_at IS NOT NULL');
  const pinnedRows = db.prepare(
    `${baseSelect} WHERE ${pinnedF.where.join(' AND ')} ORDER BY c.updated_at DESC`
  ).all(...pinnedF.params) as Array<Record<string, unknown>>;
  const pinnedItems = pinnedRows.map(rowToHistoryItem);

  // Regular (unpinned): cursor-paginated as before.
  const regF = buildFilters(true);
  regF.where.push('c.pinned_at IS NULL');
  const rows = db.prepare(
    `${baseSelect} WHERE ${regF.where.join(' AND ')} ORDER BY c.updated_at DESC LIMIT ?`
  ).all(...regF.params, limit) as Array<Record<string, unknown>>;

  const items = rows.map(rowToHistoryItem);
  const lastItem = items.at(-1);
  const nextCursor = items.length === limit && lastItem ? lastItem.conversation.updatedAt : null;
  return { pinnedItems, items, nextCursor };
}

function clampHistoryLimit(n: number | undefined): number {
  if (n == null || Number.isNaN(n) || n < 1) return 50;
  return Math.min(Math.floor(n), 100);
}

function rowToHistoryItem(row: Record<string, unknown>): ConversationHistoryItem {
  return {
    conversation: rowToConversation(row),
    lastMessage: row.last_id ? rowToMessage({
      id: row.last_id,
      role: row.last_role,
      content: row.last_content,
      agent_id: row.last_agent_id,
      run_id: row.last_run_id,
      events_json: row.last_events_json,
      created_at: row.last_created_at,
    }) : null,
    messageCount: Number(row.message_count ?? 0),
    vaultId: (row.vault_id as string | null) ?? null,
    vaultName: (row.vault_name as string | null) ?? null,
    vaultExists: Boolean(row.vault_exists),
  };
}

export function getConversation(db: SqliteDb, id: string): Conversation | null {
  const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToConversation(row) : null;
}

export function updateConversation(
  db: SqliteDb,
  id: string,
  patch: { title?: string; pinned?: boolean },
): Conversation | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) throw new Error('Title must be a non-empty string');
    sets.push('title = ?');
    params.push(title);
  }
  if (patch.pinned !== undefined) {
    sets.push('pinned_at = ?');
    params.push(patch.pinned ? Date.now() : null);
  }
  if (sets.length === 0) return getConversation(db, id);
  params.push(id);
  db.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getConversation(db, id);
}

export function createConversation(db: SqliteDb, projectId: string, title?: string): Conversation {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    'INSERT INTO conversations (id, project_id, title, channel_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, projectId, title ?? null, 'desktop', now, now);
  return { id, projectId, title: title ?? null, channelType: 'desktop', externalSessionId: null, createdAt: now, updatedAt: now };
}

export function createDesktopConversation(
  db: SqliteDb,
  title?: string,
  vaultId?: string | null,
  vaultName?: string | null,
): Conversation {
  ensureDesktopProject(db);
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    'INSERT INTO conversations (id, project_id, title, channel_type, vault_id, vault_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, DESKTOP_PROJECT_ID, title ?? null, 'desktop', vaultId ?? null, vaultName ?? null, now, now);
  return {
    id,
    projectId: DESKTOP_PROJECT_ID,
    title: title ?? null,
    channelType: 'desktop',
    externalSessionId: null,
    createdAt: now,
    updatedAt: now,
  };
}

export interface ExternalConversationInput {
  channelType: string;
  externalSessionId: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

export function getConversationByExternalSession(
  db: SqliteDb,
  channelType: string,
  externalSessionId: string,
): Conversation | null {
  // Only return the latest open (not closed) conversation for this external session
  const row = db.prepare(
    'SELECT * FROM conversations WHERE channel_type = ? AND external_session_id = ? AND closed_at IS NULL ORDER BY created_at DESC LIMIT 1'
  ).get(channelType, externalSessionId) as Record<string, unknown> | undefined;
  return row ? rowToConversation(row) : null;
}

/**
 * Mark a conversation as closed so it won't be returned by getConversationByExternalSession.
 * The conversation and its messages are preserved for history viewing.
 */
export function closeConversation(db: SqliteDb, id: string): void {
  db.prepare('UPDATE conversations SET closed_at = ?, updated_at = ? WHERE id = ?').run(Date.now(), Date.now(), id);
}

export function createExternalConversation(db: SqliteDb, input: ExternalConversationInput): Conversation {
  ensureChannelsProject(db);
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO conversations (
      id, project_id, title, channel_type, external_session_id, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    CHANNELS_PROJECT_ID,
    input.title ?? null,
    input.channelType,
    input.externalSessionId,
    input.metadata ? JSON.stringify(input.metadata) : null,
    now,
    now,
  );
  return {
    id,
    projectId: CHANNELS_PROJECT_ID,
    title: input.title ?? null,
    channelType: input.channelType,
    externalSessionId: input.externalSessionId,
    metadata: input.metadata,
    createdAt: now,
    updatedAt: now,
  };
}

export function deleteConversation(db: SqliteDb, id: string): void {
  db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
}

// ─── Message CRUD ───

export function listMessages(db: SqliteDb, conversationId: string): ChatMessage[] {
  const rows = db.prepare(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY position ASC'
  ).all(conversationId) as Array<Record<string, unknown>>;
  return rows.map(rowToMessage);
}

/**
 * Find the rewind point for regenerate/edit: the position of the last user
 * message, plus the run_id of the most recent assistant message after it
 * (the conversation's currently-active run, if any).
 */
export function getRewindPoint(
  db: SqliteDb,
  conversationId: string,
): { position: number; activeRunId: string | null } | null {
  const userRow = db.prepare(
    "SELECT position FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY position DESC LIMIT 1",
  ).get(conversationId) as { position: number } | undefined;
  if (!userRow) return null;
  const assistantRow = db.prepare(
    "SELECT run_id FROM messages WHERE conversation_id = ? AND position > ? AND role = 'assistant' ORDER BY position DESC LIMIT 1",
  ).get(conversationId, userRow.position) as { run_id: string | null } | undefined;
  return { position: userRow.position, activeRunId: assistantRow?.run_id ?? null };
}

/** Delete all messages with position >= `position` in the conversation. */
export function deleteMessagesFromPosition(
  db: SqliteDb,
  conversationId: string,
  position: number,
): number {
  const r = db
    .prepare('DELETE FROM messages WHERE conversation_id = ? AND position >= ?')
    .run(conversationId, position);
  return r.changes;
}

/** List messages with position < `position` (i.e. the surviving history after a rewind). */
export function listMessagesBefore(
  db: SqliteDb,
  conversationId: string,
  position: number,
): ChatMessage[] {
  const rows = db
    .prepare('SELECT * FROM messages WHERE conversation_id = ? AND position < ? ORDER BY position ASC')
    .all(conversationId, position) as Array<Record<string, unknown>>;
  return rows.map(rowToMessage);
}

/** Delete a set of messages by id within a conversation. Returns rows deleted. */
export function deleteMessagesById(
  db: SqliteDb,
  conversationId: string,
  ids: string[],
): number {
  if (ids.length === 0) return 0;
  // Bind each id as a separate parameter; conversationId scopes the delete so
  // an id from another conversation cannot be hit.
  const placeholders = ids.map(() => '?').join(', ');
  const r = db
    .prepare(
      `DELETE FROM messages WHERE conversation_id = ? AND id IN (${placeholders})`,
    )
    .run(conversationId, ...ids);
  return r.changes;
}

/**
 * Upsert a message. If the message id already exists, update it.
 * Otherwise, insert with auto-incremented position.
 */
export function upsertMessage(db: SqliteDb, conversationId: string, msg: ChatMessage): void {
  const existing = db.prepare('SELECT id FROM messages WHERE id = ?').get(msg.id);

  if (existing) {
    // Update existing message
    db.prepare(`
      UPDATE messages SET
        content = ?,
        agent_id = ?,
        run_id = ?,
        agent_name = ?,
        events_json = ?,
        ended_at = ?,
        started_at = COALESCE(started_at, ?)
      WHERE id = ?
    `).run(
      msg.content,
      msg.agentId ?? null,
      msg.runId ?? null,
      null, // agent_name
      msg.tools ? JSON.stringify(msg.tools) : null,
      msg.usage ? Date.now() : null,
      Date.now(),
      msg.id,
    );
  } else {
    // Insert new message with auto-incremented position
    const maxPos = db.prepare(
      'SELECT COALESCE(MAX(position), -1) as max_pos FROM messages WHERE conversation_id = ?'
    ).get(conversationId) as { max_pos: number };

    db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, agent_id, run_id, agent_name, events_json, started_at, ended_at, position, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      msg.id,
      conversationId,
      msg.role,
      msg.content,
      msg.agentId ?? null,
      msg.runId ?? null,
      null, // agent_name
      msg.tools ? JSON.stringify(msg.tools) : null,
      Date.now(),
      null,
      maxPos.max_pos + 1,
      msg.timestamp || Date.now(),
    );
  }

  // Update conversation's updated_at
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now(), conversationId);
}

/**
 * Append an agent event to a message's events_json and update content for text deltas.
 */
export function appendMessageEvent(db: SqliteDb, messageId: string, event: unknown, textDelta?: string): void {
  const row = db.prepare('SELECT events_json, content FROM messages WHERE id = ?').get(messageId) as {
    events_json: string | null;
    content: string;
  } | undefined;

  if (!row) return;

  const events: unknown[] = row.events_json ? JSON.parse(row.events_json) : [];
  events.push(event);

  const newContent = textDelta ? row.content + textDelta : row.content;

  db.prepare('UPDATE messages SET events_json = ?, content = ? WHERE id = ?').run(
    JSON.stringify(events),
    newContent,
    messageId,
  );
}

// ─── Vault CRUD ───

export function listVaults(db: SqliteDb): Vault[] {
  const rows = db.prepare('SELECT * FROM vaults ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;
  return rows.map(rowToVault);
}

export function getVault(db: SqliteDb, id: string): Vault | null {
  const row = db.prepare('SELECT * FROM vaults WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToVault(row) : null;
}

export function getVaultByPath(db: SqliteDb, vaultPath: string): Vault | null {
  const row = db.prepare('SELECT * FROM vaults WHERE path = ?').get(vaultPath) as Record<string, unknown> | undefined;
  return row ? rowToVault(row) : null;
}

export function createVault(db: SqliteDb, name: string, vaultPath: string, description?: string): Vault {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    'INSERT INTO vaults (id, name, path, description, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, name, vaultPath, description ?? null, now);
  return { id, name, path: vaultPath, description, fileCount: 0, createdAt: now };
}

export function deleteVault(db: SqliteDb, id: string): void {
  db.prepare('DELETE FROM vaults WHERE id = ?').run(id);
  // Clear active-vault if it pointed at the deleted vault.
  if (getActiveVaultId(db) === id) {
    setActiveVaultId(db, null);
  }
}

// ─── Key/value store (active-vault etc.) ───

export function getKv(db: SqliteDb, key: string): string | null {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setKv(db: SqliteDb, key: string, value: string): void {
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value, Date.now());
}

export function deleteKv(db: SqliteDb, key: string): void {
  db.prepare('DELETE FROM kv WHERE key = ?').run(key);
}

// ─── Active vault ───

const ACTIVE_VAULT_KEY = 'active_vault';

/** Returns the id of the user's currently-selected vault, or null. */
export function getActiveVaultId(db: SqliteDb): string | null {
  return getKv(db, ACTIVE_VAULT_KEY);
}

/** Set/clear the active vault. Pass null to clear. */
export function setActiveVaultId(db: SqliteDb, id: string | null): void {
  if (id) {
    setKv(db, ACTIVE_VAULT_KEY, id);
  } else {
    deleteKv(db, ACTIVE_VAULT_KEY);
  }
}

// ─── KB History ───

export function listKbHistory(db: SqliteDb, vaultId: string, limit = 50): KbHistoryEntry[] {
  const rows = db.prepare(
    'SELECT * FROM kb_history WHERE vault_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(vaultId, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToKbHistory);
}

export function addKbHistory(db: SqliteDb, vaultId: string, action: string, detail: string): void {
  db.prepare(
    'INSERT INTO kb_history (id, vault_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(randomUUID(), vaultId, action, detail, Date.now());
}

// ─── Row mappers ───

function rowToProject(row: Record<string, unknown>): Project {
  return {
    id: row.id as string,
    name: row.name as string,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json as string) : undefined,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function rowToConversation(row: Record<string, unknown>): Conversation {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    title: (row.title as string) ?? null,
    channelType: (row.channel_type as string) ?? 'desktop',
    externalSessionId: (row.external_session_id as string) ?? null,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json as string) : undefined,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    pinnedAt: (row.pinned_at as number | null) ?? null,
  };
}

function rowToMessage(row: Record<string, unknown>): ChatMessage {
  return {
    id: row.id as string,
    role: row.role as 'user' | 'assistant' | 'system',
    content: row.content as string,
    timestamp: row.created_at as number,
    agentId: (row.agent_id as string) ?? undefined,
    runId: (row.run_id as string) ?? undefined,
    tools: row.events_json ? JSON.parse(row.events_json as string) : undefined,
  };
}

function rowToVault(row: Record<string, unknown>): Vault {
  return {
    id: row.id as string,
    name: row.name as string,
    path: row.path as string,
    description: (row.description as string) ?? undefined,
    fileCount: 0, // Computed at tree-scan time
    createdAt: row.created_at as number,
  };
}

function rowToKbHistory(row: Record<string, unknown>): KbHistoryEntry {
  return {
    id: row.id as string,
    vaultId: row.vault_id as string,
    action: row.action as KbHistoryEntry['action'],
    detail: (row.detail as string) ?? '',
    createdAt: row.created_at as number,
  };
}
