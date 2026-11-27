import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Runtime KB fixture for E2E tests that need a real vault + markdown file.
 *
 * Resolves against the running daemon (no hardcoded vault IDs / file paths):
 *   1. GET /api/knowledge/vaults — use the first vault whose tree scans OK
 *   2. GET /api/knowledge/vaults/:id/tree — pick any existing .md file
 *   3. No .md file → create a fixture file via POST .../files/*
 *   4. No usable vault at all → create a fixture vault in the OS temp dir
 *
 * The fixture vault/file are reused across runs (never deleted), so repeat
 * runs on the same machine are read-only after the first one.
 */

export interface ClipFixture {
  vaultId: string;
  vaultName: string;
  /** Vault-relative file path, e.g. "Clippings/e2e-protocol-cold-start.md" */
  filePath: string;
}

interface VaultEntry {
  id: string;
  name: string;
  path: string;
}

interface TreeNodeEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: TreeNodeEntry[];
}

const FIXTURE_VAULT_NAME = 'E2E Fixture Vault';
const FIXTURE_FILE_PATH = 'Clippings/e2e-protocol-cold-start.md';
const FIXTURE_FILE_CONTENT = [
  '# E2E Protocol Cold-Start Fixture',
  '',
  'Created by apps/desktop/e2e/helpers/kb-fixture.ts.',
  'Safe to delete — the test recreates it when a vault has no markdown files.',
  '',
].join('\n');

function apiBase(port: number): string {
  return `http://localhost:${port}/api/knowledge`;
}

/** Depth-first search for the first markdown file, skipping hidden dirs. */
function findFirstMarkdown(nodes: TreeNodeEntry[]): string | null {
  for (const node of nodes) {
    if (node.name.startsWith('.')) continue;
    if (node.type === 'file' && /\.md$/i.test(node.name)) {
      return node.path;
    }
    if (node.type === 'directory' && node.children) {
      const found = findFirstMarkdown(node.children);
      if (found) return found;
    }
  }
  return null;
}

async function listVaults(port: number): Promise<VaultEntry[]> {
  const res = await fetch(`${apiBase(port)}/vaults`);
  if (!res.ok) throw new Error(`[e2e] GET /vaults failed: ${res.status}`);
  const body = (await res.json()) as { vaults: VaultEntry[] };
  return body.vaults ?? [];
}

async function scanVaultTree(port: number, vaultId: string): Promise<TreeNodeEntry[] | null> {
  const res = await fetch(`${apiBase(port)}/vaults/${vaultId}/tree`);
  if (!res.ok) return null; // e.g. vault path deleted out of band — skip it
  const body = (await res.json()) as { tree: TreeNodeEntry[] };
  return body.tree ?? [];
}

async function createVault(port: number): Promise<VaultEntry> {
  const path = join(tmpdir(), 'molio-e2e-fixture-vault');
  const res = await fetch(`${apiBase(port)}/vaults`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FIXTURE_VAULT_NAME, path }),
  });
  if (!res.ok) throw new Error(`[e2e] POST /vaults failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as VaultEntry;
}

async function createFixtureFile(port: number, vaultId: string): Promise<string> {
  const encoded = FIXTURE_FILE_PATH.split('/').map(encodeURIComponent).join('/');
  const res = await fetch(`${apiBase(port)}/vaults/${vaultId}/files/${encoded}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: FIXTURE_FILE_CONTENT }),
  });
  if (!res.ok) {
    throw new Error(`[e2e] POST files/${FIXTURE_FILE_PATH} failed: ${res.status} ${await res.text()}`);
  }
  return FIXTURE_FILE_PATH;
}

/**
 * Resolve a vault + markdown file from the running daemon, creating fixture
 * data only when the machine has none.
 */
export async function resolveClipFixture(port = 3100): Promise<ClipFixture> {
  const vaults = await listVaults(port);

  // First vault that scans — its path may be stale on a borrowed machine.
  let vault: VaultEntry | null = null;
  let tree: TreeNodeEntry[] | null = null;
  for (const candidate of vaults) {
    const candidateTree = await scanVaultTree(port, candidate.id);
    if (candidateTree) {
      vault = candidate;
      tree = candidateTree;
      break;
    }
  }

  if (!vault || !tree) {
    console.log('[e2e] No usable vault found — creating fixture vault in temp dir');
    vault = await createVault(port);
    tree = await scanVaultTree(port, vault.id);
  }

  const existing = findFirstMarkdown(tree ?? []);
  const filePath = existing ?? (await createFixtureFile(port, vault.id));
  if (!existing) {
    console.log(`[e2e] Vault "${vault.name}" has no markdown file — created ${filePath}`);
  }

  return { vaultId: vault.id, vaultName: vault.name, filePath };
}
