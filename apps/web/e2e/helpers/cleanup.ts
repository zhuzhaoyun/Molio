/**
 * Cleanup helpers — create/delete test data via the daemon API.
 * Use in afterEach / afterAll to prevent state leakage.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const DAEMON = 'http://localhost:3100';

// ── Delete helpers ─────────────────────────────────────────────────────

export async function deleteVault(id: string) {
  await fetch(`${DAEMON}/api/knowledge/vaults/${id}`, { method: 'DELETE' });
}

export async function deleteProject(id: string) {
  await fetch(`${DAEMON}/api/projects/${id}`, { method: 'DELETE' });
}

export async function deleteConversation(id: string) {
  await fetch(`${DAEMON}/api/conversations/${id}`, { method: 'DELETE' });
}

// ── Create helpers ─────────────────────────────────────────────────────

export interface TempVault {
  id: string;
  path: string;
  name: string;
}

/**
 * Create a temporary directory with a test.md file, register it as a vault
 * via the daemon API. Returns { id, path, name } for cleanup.
 *
 * Caller MUST call `cleanupTempVault(vault)` in afterAll/afterEach.
 */
export async function createTempVault(name?: string): Promise<TempVault> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-e2e-'));
  fs.writeFileSync(path.join(dir, 'test.md'), '# Test\nHello world\n');
  const vaultName = name ?? `e2e-${Date.now()}`;
  const res = await fetch(`${DAEMON}/api/knowledge/vaults`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: vaultName, path: dir }),
  });
  const vault = await res.json();
  return { id: vault.id, path: dir, name: vaultName };
}

/**
 * Delete a vault via API AND remove the temp directory from disk.
 */
export async function cleanupTempVault(vault: TempVault) {
  await deleteVault(vault.id);
  try {
    fs.rmSync(vault.path, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

/**
 * Create a project via daemon API. Returns the project object.
 */
export async function createProject(name: string) {
  const res = await fetch(`${DAEMON}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return res.json();
}

/**
 * Create a conversation under a project. Returns the conversation object.
 */
export async function createConversation(projectId: string, title: string) {
  const res = await fetch(`${DAEMON}/api/projects/${projectId}/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  return res.json();
}

/**
 * Add a message to a conversation (used to seed history data).
 */
export async function addMessage(
  projectId: string,
  conversationId: string,
  message: { id: string; role: string; content: string; timestamp: number; agentId?: string },
) {
  await fetch(`${DAEMON}/api/projects/${projectId}/conversations/${conversationId}/messages/${message.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  });
}
