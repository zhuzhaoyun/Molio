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
import type { ChatMessage, Project, Conversation, Vault, KbHistoryEntry } from '@molio/contracts';

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

  migrate(db);
  dbInstance = db;
  dbFile = file;
  return db;
}

export function closeDatabase(): void {
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
  `);

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
    CREATE UNIQUE INDEX idx_conv_external_session_open
      ON conversations(channel_type, external_session_id)
      WHERE external_session_id IS NOT NULL AND closed_at IS NULL;
  `);
}

function addColumnIfMissing(db: SqliteDb, table: string, column: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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

export function listConversationHistory(
  db: SqliteDb,
  limit = 100,
): Array<{ conversation: Conversation; lastMessage: ChatMessage | null; messageCount: number }> {
  const rows = db.prepare(`
    SELECT
      c.*,
      COALESCE(stats.message_count, 0) AS message_count,
      lm.id AS last_id,
      lm.role AS last_role,
      lm.content AS last_content,
      lm.agent_id AS last_agent_id,
      lm.run_id AS last_run_id,
      lm.events_json AS last_events_json,
      lm.created_at AS last_created_at
    FROM conversations c
    LEFT JOIN (
      SELECT conversation_id, COUNT(*) AS message_count, MAX(position) AS max_position
      FROM messages
      GROUP BY conversation_id
    ) stats ON stats.conversation_id = c.id
    LEFT JOIN messages lm
      ON lm.conversation_id = c.id AND lm.position = stats.max_position
    ORDER BY c.updated_at DESC
    LIMIT ?
  `).all(limit) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
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
  }));
}

export function getConversation(db: SqliteDb, id: string): Conversation | null {
  const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToConversation(row) : null;
}

export function createConversation(db: SqliteDb, projectId: string, title?: string): Conversation {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    'INSERT INTO conversations (id, project_id, title, channel_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, projectId, title ?? null, 'desktop', now, now);
  return { id, projectId, title: title ?? null, channelType: 'desktop', externalSessionId: null, createdAt: now, updatedAt: now };
}

export function createDesktopConversation(db: SqliteDb, title?: string): Conversation {
  ensureDesktopProject(db);
  return createConversation(db, DESKTOP_PROJECT_ID, title);
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
