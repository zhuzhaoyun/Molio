/**
 * Skill hub client — browse/search the skillhub.cn catalog and install hub
 * skills into the local library (the "v1.5 marketplace" the importer deferred).
 *
 * The daemon acts as the proxy/installer: the web UI never talks to the hub
 * directly (no CORS, one code path for desktop + Docker). Installing a hub
 * skill downloads its zip package and feeds the extracted directory through
 * the SAME pipeline as a local folder import (importer.importFromFolder →
 * createSkill with sourceDir), so an installed hub skill is just a library
 * skill — toggle / edit / delete / per-vault sync all reuse the existing
 * machinery. The `hub_skill_installs` table remembers slug → skill id so the
 * store can show "installed" and a reinstall refreshes the same skill in place
 * (keeping its master-switch state) instead of duplicating it.
 *
 * The hub API needs no auth for browse/download:
 *   GET <base>/api/skills?page=&pageSize=&keyword=&category=   catalog list
 *   GET <base>/api/v1/categories                               category list
 *   GET <base>/api/v1/download?slug=<slug>[&version=][&namespace=]  zip package
 *
 * Package format == Molio's own: SKILL.md (+ optional _meta.json / siblings).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import type Database from 'better-sqlite3';
import { parseSkillMd } from '@molio/contracts';
import type {
  HubCategory,
  HubSkillSummary,
  HubSkillsQuery,
  InstallHubSkillRequest,
  SkillManifestEntry,
} from '@molio/contracts';
import { MAX_IMPORT_FILES, MAX_IMPORT_BYTES, importFromFolder } from './importer.js';
import { copyDirSync } from './dirsync.js';
import { skillContentDir, type SkillPathsOpts } from './paths.js';
import { getSkill } from './store.js';

export class HubError extends Error {
  code: 'HUB_UNAVAILABLE' | 'NOT_FOUND' | 'BAD_REQUEST';
  constructor(code: 'HUB_UNAVAILABLE' | 'NOT_FOUND' | 'BAD_REQUEST', message: string) {
    super(message);
    this.name = 'HubError';
    this.code = code;
  }
}

/** Default hub API host; override with MOLIO_SKILLHUB_API (tests / mirrors). */
export const DEFAULT_HUB_API_BASE = 'https://api.skillhub.cn';

export function hubApiBase(): string {
  const override = process.env['MOLIO_SKILLHUB_API'];
  return (override && override.trim() ? override.trim() : DEFAULT_HUB_API_BASE).replace(/\/+$/, '');
}

// ─── fetch injection (tests) ───

type FetchLike = typeof globalThis.fetch;
let fetchImpl: FetchLike = globalThis.fetch;

/** Test hook: swap the fetch implementation; pass nothing to restore. */
export function _setHubFetchForTests(fn?: FetchLike): void {
  fetchImpl = fn ?? globalThis.fetch;
}

const HUB_LIST_TIMEOUT_MS = 15_000;
const HUB_DOWNLOAD_TIMEOUT_MS = 60_000;
/** Cap on a downloaded package — skills are text-heavy; this is a bomb guard. */
export const MAX_HUB_DOWNLOAD_BYTES = MAX_IMPORT_BYTES;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** GET a hub URL; network failures / timeouts become HUB_UNAVAILABLE. */
async function hubFetch(url: string, timeoutMs: number): Promise<Response> {
  try {
    return await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': 'Molio', Accept: 'application/json, application/zip' },
    });
  } catch (err) {
    throw new HubError('HUB_UNAVAILABLE', `无法连接 SkillHub，请检查网络后重试（${errMsg(err)}）`);
  }
}

/** GET + parse a JSON envelope; non-2xx / malformed bodies become hub errors. */
async function hubFetchJson(url: string): Promise<Record<string, unknown>> {
  const res = await hubFetch(url, HUB_LIST_TIMEOUT_MS);
  if (!res.ok) {
    throw new HubError(
      res.status === 404 ? 'NOT_FOUND' : 'HUB_UNAVAILABLE',
      `SkillHub 请求失败（HTTP ${res.status}）`,
    );
  }
  try {
    const data = (await res.json()) as unknown;
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('unexpected JSON shape');
    }
    return data as Record<string, unknown>;
  } catch (err) {
    if (err instanceof HubError) throw err;
    throw new HubError('HUB_UNAVAILABLE', `SkillHub 返回了无法解析的数据（${errMsg(err)}）`);
  }
}

// ─── Catalog browse/search ───

/** Loose typing for a raw catalog record — only the fields we map are listed. */
interface RawHubSkill {
  slug?: unknown;
  name?: unknown;
  description?: unknown;
  description_zh?: unknown;
  version?: unknown;
  downloads?: unknown;
  ownerName?: unknown;
  verified?: unknown;
  category?: unknown;
  updated_at?: unknown;
  labels?: { requires_api_key?: unknown } | null;
  namespace?: { handle?: unknown } | null;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function mapHubSkill(raw: RawHubSkill): HubSkillSummary | null {
  const slug = asString(raw.slug).trim();
  if (!slug) return null;
  const namespace = asString(raw.namespace?.handle).trim();
  return {
    slug,
    name: asString(raw.name).trim() || slug,
    // Prefer the Chinese description; the hub keeps the original in description.
    description: asString(raw.description_zh).trim() || asString(raw.description).trim(),
    version: asString(raw.version),
    downloads: typeof raw.downloads === 'number' ? raw.downloads : 0,
    ownerName: asString(raw.ownerName).trim() || namespace,
    ...(namespace ? { namespace } : {}),
    category: asString(raw.category),
    verified: raw.verified === true,
    requiresApiKey: raw.labels?.requires_api_key === 'true',
    updatedAt: typeof raw.updated_at === 'number' ? raw.updated_at : 0,
  };
}

export interface HubListResult {
  skills: HubSkillSummary[];
  total: number;
  page: number;
  pageSize: number;
}

const HUB_PAGE_SIZE_MAX = 50;

export async function fetchHubSkills(query: HubSkillsQuery): Promise<HubListResult> {
  const page = Math.max(1, Math.floor(query.page ?? 1) || 1);
  const pageSize = Math.min(HUB_PAGE_SIZE_MAX, Math.max(1, Math.floor(query.pageSize ?? 20) || 20));
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (query.keyword?.trim()) params.set('keyword', query.keyword.trim());
  if (query.category?.trim()) params.set('category', query.category.trim());

  const body = await hubFetchJson(`${hubApiBase()}/api/skills?${params.toString()}`);
  // Envelope: { code: 0, data: { skills: [...], total }, message }
  if (body['code'] !== 0) {
    throw new HubError('HUB_UNAVAILABLE', `SkillHub 返回错误：${asString(body['message']) || '未知错误'}`);
  }
  const data = (body['data'] ?? {}) as { skills?: unknown; total?: unknown };
  const rawList = Array.isArray(data.skills) ? (data.skills as RawHubSkill[]) : [];
  const skills = rawList.map(mapHubSkill).filter((s): s is HubSkillSummary => s !== null);
  return {
    skills,
    total: typeof data.total === 'number' ? data.total : skills.length,
    page,
    pageSize,
  };
}

interface RawHubCategory {
  key?: unknown;
  name?: unknown;
  active?: unknown;
  sortOrder?: unknown;
}

export async function fetchHubCategories(): Promise<HubCategory[]> {
  const body = await hubFetchJson(`${hubApiBase()}/api/v1/categories`);
  const items = Array.isArray(body['items']) ? (body['items'] as RawHubCategory[]) : [];
  return items
    .filter((c) => c.active !== false && asString(c.key) && asString(c.name))
    .sort(
      (a, b) =>
        (typeof a.sortOrder === 'number' ? a.sortOrder : 0) -
        (typeof b.sortOrder === 'number' ? b.sortOrder : 0),
    )
    .map((c) => ({ key: asString(c.key), name: asString(c.name) }));
}

// ─── Package download + extraction ───

/**
 * Stream the hub's zip package for `slug` into `tmpFile`, aborting once the
 * byte cap is exceeded. Streams (rather than buffering) so an oversized/malicious
 * response can't balloon memory before the cap check.
 */
async function downloadHubZip(
  slug: string,
  version: string | undefined,
  namespace: string | undefined,
  tmpFile: string,
): Promise<void> {
  const params = new URLSearchParams({ slug });
  if (version) params.set('version', version);
  if (namespace) params.set('namespace', namespace);
  const res = await hubFetch(`${hubApiBase()}/api/v1/download?${params.toString()}`, HUB_DOWNLOAD_TIMEOUT_MS);
  if (res.status === 404) {
    throw new HubError('NOT_FOUND', `SkillHub 上未找到该技能：${slug}`);
  }
  if (!res.ok) {
    throw new HubError('HUB_UNAVAILABLE', `SkillHub 下载失败（HTTP ${res.status}）`);
  }
  if (!res.body) {
    throw new HubError('HUB_UNAVAILABLE', 'SkillHub 返回了空的下载内容');
  }

  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(tmpFile);
    let bytes = 0;
    out.on('finish', resolve);
    out.on('error', reject);
    void (async () => {
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          bytes += chunk.byteLength;
          if (bytes > MAX_HUB_DOWNLOAD_BYTES) {
            throw new HubError('BAD_REQUEST', '技能包过大，已中止下载');
          }
          if (!out.write(chunk)) {
            await new Promise<void>((r) => out.once('drain', r));
          }
        }
        out.end();
      } catch (err) {
        out.destroy();
        reject(err instanceof HubError ? err : new HubError('HUB_UNAVAILABLE', `SkillHub 下载中断（${errMsg(err)}）`));
      }
    })();
  });
}

/**
 * Extract a skill zip into `destDir` with the two untrusted-archive defenses:
 *  - zip-slip: entry paths are normalized, must stay relative, and their
 *    resolved target must remain inside destDir (rejects `../` and absolute
 *    paths, including Windows drive-letter paths);
 *  - zip bomb: cumulative file count / uncompressed bytes are bounded by the
 *    same limits folder imports enforce (MAX_IMPORT_FILES / MAX_IMPORT_BYTES).
 */
export function extractSkillZip(zipBytes: Uint8Array, destDir: string): void {
  if (zipBytes.length < 2 || zipBytes[0] !== 0x50 || zipBytes[1] !== 0x4b) {
    throw new HubError('BAD_REQUEST', '下载的内容不是有效的 zip 技能包');
  }
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zipBytes);
  } catch (err) {
    throw new HubError('BAD_REQUEST', `技能包解压失败：${errMsg(err)}`);
  }

  const destAbs = path.resolve(destDir);
  fs.mkdirSync(destAbs, { recursive: true });
  let files = 0;
  let bytes = 0;
  for (const [rawName, data] of Object.entries(entries)) {
    if (rawName.endsWith('/')) continue; // directory entry
    const rel = rawName.replace(/\\/g, '/').replace(/^\/+/, '');
    const segments = rel.split('/');
    if (!rel || segments.some((seg) => seg === '' || seg === '.' || seg === '..')) {
      throw new HubError('BAD_REQUEST', `技能包包含不安全的文件路径：${rawName}`);
    }
    const target = path.resolve(destAbs, rel);
    if (target !== destAbs && !target.startsWith(destAbs + path.sep)) {
      throw new HubError('BAD_REQUEST', `技能包包含不安全的文件路径：${rawName}`);
    }
    files += 1;
    bytes += data.byteLength;
    if (files > MAX_IMPORT_FILES) {
      throw new HubError('BAD_REQUEST', `技能包文件数超过上限（最多 ${MAX_IMPORT_FILES} 个文件）`);
    }
    if (bytes > MAX_IMPORT_BYTES) {
      throw new HubError('BAD_REQUEST', `技能包解压后过大（最大 ${Math.round(MAX_IMPORT_BYTES / 1024 / 1024)} MB）`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }
  if (files === 0) {
    throw new HubError('BAD_REQUEST', '技能包是空的');
  }
}

/** Installed version recorded from the package itself (meta first, frontmatter fallback). */
function readPackageVersion(dir: string): string {
  try {
    const metaPath = path.join(dir, '_meta.json');
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as { version?: unknown };
      if (typeof meta.version === 'string' && meta.version.trim()) return meta.version.trim();
    }
  } catch {
    // fall through to the frontmatter fallback
  }
  try {
    const md = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    const m = md.match(/^version\s*:\s*(.+)$/m);
    if (m?.[1]?.trim()) return m[1].trim();
  } catch {
    // no version available
  }
  return '';
}

// ─── Install registry (hub_skill_installs) ───

export interface HubInstallRecord {
  slug: string;
  skill_id: string;
  version: string;
  namespace: string;
  installed_at: number;
  updated_at: number;
}

export function listHubInstalls(db: Database.Database): HubInstallRecord[] {
  return db.prepare('SELECT * FROM hub_skill_installs').all() as HubInstallRecord[];
}

export function getHubInstall(db: Database.Database, slug: string): HubInstallRecord | null {
  return (db.prepare('SELECT * FROM hub_skill_installs WHERE slug = ?').get(slug) as HubInstallRecord | undefined) ?? null;
}

/** Remove the hub mapping when the underlying skill row is deleted (routes/skills.ts). */
export function removeHubInstallBySkillId(db: Database.Database, skillId: string): void {
  db.prepare('DELETE FROM hub_skill_installs WHERE skill_id = ?').run(skillId);
}

// ─── Install ───

export interface InstallHubSkillResult {
  skill: SkillManifestEntry;
  /** True when the slug was already installed and its content was refreshed. */
  updated: boolean;
  /** Version read from the downloaded package ('' when the package has none). */
  version: string;
}

/** Hub slugs are simple path-safe names; validate before interpolating into URLs/dirs. */
const SAFE_SLUG = /^[\w.-]+$/;

/**
 * Download + install (or refresh) a hub skill.
 *
 * Fresh slug   → extract → importFromFolder (shared limits/parsing pipeline)
 *                → record slug → skill id in hub_skill_installs.
 * Known slug   → overwrite the existing skill's content dir in place and update
 *                its name/description metadata. The SKILL.md itself is NOT
 *                regenerated (updateSkill would rewrite the frontmatter and drop
 *                extra fields like allowed-tools), and the skill id / enabled
 *                state are preserved, so "reinstall" behaves like an update.
 */
export async function installHubSkill(
  db: Database.Database,
  req: InstallHubSkillRequest,
  opts?: SkillPathsOpts,
): Promise<InstallHubSkillResult> {
  const slug = (req.slug ?? '').trim();
  if (!slug || !SAFE_SLUG.test(slug) || slug.length > 128) {
    throw new HubError('BAD_REQUEST', '无效的技能标识（slug）');
  }
  const version = req.version?.trim() || undefined;
  const namespace = req.namespace?.trim() || undefined;

  const zipPath = path.join(os.tmpdir(), `molio-hub-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-hub-skill-'));
  try {
    await downloadHubZip(slug, version, namespace, zipPath);
    extractSkillZip(new Uint8Array(fs.readFileSync(zipPath)), extractDir);
    if (!fs.existsSync(path.join(extractDir, 'SKILL.md'))) {
      throw new HubError('BAD_REQUEST', '技能包根目录缺少 SKILL.md');
    }
    const pkgVersion = readPackageVersion(extractDir);
    const now = Date.now();

    const existing = getHubInstall(db, slug);
    if (existing && getSkill(db, existing.skill_id)) {
      // Refresh in place: wipe + re-copy content, keep row id + enabled state.
      const contentDir = skillContentDir(existing.skill_id, opts);
      fs.rmSync(contentDir, { recursive: true, force: true });
      copyDirSync(extractDir, contentDir);
      const parsed = parseSkillMd(fs.readFileSync(path.join(contentDir, 'SKILL.md'), 'utf8'));
      db.prepare('UPDATE skills SET name = ?, description = ?, updated_at = ? WHERE id = ?').run(
        parsed.name.trim() || existing.skill_id,
        parsed.description,
        now,
        existing.skill_id,
      );
      db.prepare('UPDATE hub_skill_installs SET version = ?, namespace = ?, updated_at = ? WHERE slug = ?').run(
        pkgVersion,
        namespace ?? '',
        now,
        slug,
      );
      const skill = getSkill(db, existing.skill_id);
      if (!skill) throw new HubError('HUB_UNAVAILABLE', '技能记录更新失败，请重试');
      return { skill, updated: true, version: pkgVersion };
    }

    // Fresh install through the shared folder-import pipeline (limits + parse).
    const skill = importFromFolder(db, extractDir, opts);
    db.prepare(
      `INSERT OR REPLACE INTO hub_skill_installs (slug, skill_id, version, namespace, installed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(slug, skill.id, pkgVersion, namespace ?? '', now, now);
    return { skill, updated: false, version: pkgVersion };
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.rmSync(zipPath, { force: true });
  }
}
