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
 * machinery. The `hub_skill_installs` table remembers (namespace, slug) →
 * skill id so the store can show "installed" and a reinstall refreshes the
 * same skill in place (keeping its master-switch state) instead of
 * duplicating it. Slugs are NOT globally unique on the hub — the namespace
 * is part of the identity, so same-slug skills from different authors
 * coexist as separate installs.
 *
 * The hub API needs no auth for browse/download:
 *   GET <base>/api/skills?page=&pageSize=&keyword=&category=[&sortBy=&order=]  catalog list
 *   GET <base>/api/v1/categories                               category list
 *   GET <base>/api/v1/skills/<slug>[?namespace=]               skill detail (plain JSON)
 *   GET <base>/api/v1/skills/<slug>/file?path=SKILL.md[&namespace=]  raw SKILL.md (302 → COS)
 *   GET <base>/api/v1/download?slug=<slug>[&version=][&namespace=]  zip package
 *
 * List sortBy ∈ {score (default), downloads, updated_at, stars, installs};
 * order ∈ {asc, desc}. The detail endpoint returns the skill page data
 * (stats/owner/securityReports/…) WITHOUT the {code,data} envelope the list
 * uses. Package format == Molio's own: SKILL.md (+ optional _meta.json / siblings).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Unzip, UnzipInflate } from 'fflate';
import type Database from 'better-sqlite3';
import { parseSkillMd, stripFrontmatter } from '@molio/contracts';
import type {
  HubCategory,
  HubSkillDetail,
  HubSkillSummary,
  HubSkillsQuery,
  InstallHubSkillRequest,
  SkillManifestEntry,
} from '@molio/contracts';
import { MAX_IMPORT_FILES, MAX_IMPORT_BYTES, importFromFolder } from './importer.js';
import { mirrorDirIfChanged } from './dirsync.js';
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

/**
 * Sort options accepted by our API → upstream list params. The hub rejects
 * unknown sortBy values with a 400, so anything not in this map (including
 * 'default' and garbage from the query string) silently keeps the hub's own
 * ranking instead of erroring our UI.
 */
const HUB_SORT_MAP: Record<string, { sortBy: string; order: string }> = {
  downloads: { sortBy: 'downloads', order: 'desc' },
  updated: { sortBy: 'updated_at', order: 'desc' },
};

export async function fetchHubSkills(query: HubSkillsQuery): Promise<HubListResult> {
  const page = Math.max(1, Math.floor(query.page ?? 1) || 1);
  const pageSize = Math.min(HUB_PAGE_SIZE_MAX, Math.max(1, Math.floor(query.pageSize ?? 20) || 20));
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (query.keyword?.trim()) params.set('keyword', query.keyword.trim());
  if (query.category?.trim()) params.set('category', query.category.trim());
  const sortCfg = HUB_SORT_MAP[query.sort ?? ''];
  if (sortCfg) {
    params.set('sortBy', sortCfg.sortBy);
    params.set('order', sortCfg.order);
  }

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

// ─── Skill detail (store detail modal) ───

/** Cap on the SKILL.md fetched for the detail view — text-only bomb guard. */
export const MAX_HUB_README_BYTES = 256 * 1024;

function asNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Loose typing of the raw `GET /api/v1/skills/<slug>` response (no envelope). */
interface RawHubSkillDetail {
  slug?: unknown;
  skill?: {
    category?: unknown;
    createdAt?: unknown;
    displayName?: unknown;
    iconUrl?: unknown;
    labels?: { requires_api_key?: unknown } | null;
    slug?: unknown;
    sourceUrl?: unknown;
    stats?: { downloads?: unknown; installs?: unknown; stars?: unknown; versions?: unknown } | null;
    summary?: unknown;
    summary_zh?: unknown;
    updatedAt?: unknown;
    verified?: unknown;
  } | null;
  latestVersion?: { version?: unknown; changelog?: unknown } | null;
  owner?: { handle?: unknown; displayName?: unknown } | null;
  namespace?: { handle?: unknown } | null;
  securityReports?: {
    keen?: { statusText?: unknown } | null;
    sanbu?: { statusText?: unknown } | null;
  } | null;
}

/**
 * Fetch the latest SKILL.md body for `slug`, frontmatter stripped. ANY failure
 * (404, network, oversize) resolves to '' — the readme enriches the detail
 * modal but must never block the detail itself.
 */
async function fetchHubSkillReadme(slug: string, namespace: string | undefined): Promise<string> {
  try {
    const params = new URLSearchParams({ path: 'SKILL.md' });
    if (namespace) params.set('namespace', namespace);
    const res = await hubFetch(
      `${hubApiBase()}/api/v1/skills/${encodeURIComponent(slug)}/file?${params.toString()}`,
      HUB_LIST_TIMEOUT_MS,
    );
    if (!res.ok) return '';
    // The file endpoint 302s to COS (fetch follows it); the CDN usually sends
    // Content-Length, so pre-check before buffering the body.
    const len = Number(res.headers.get('content-length'));
    if (Number.isFinite(len) && len > MAX_HUB_README_BYTES) return '';
    const text = await res.text();
    if (text.length > MAX_HUB_README_BYTES) return '';
    return stripFrontmatter(text).trim();
  } catch {
    return '';
  }
}

/**
 * Aggregate one hub skill's detail page: `GET /api/v1/skills/<slug>` (stats,
 * owner, security verdicts, latest version) + its SKILL.md body. Throws
 * HubError NOT_FOUND for an unknown slug, HUB_UNAVAILABLE on network/parse
 * failures — same contract as the list endpoints.
 */
export async function fetchHubSkillDetail(slug: string, namespace?: string): Promise<HubSkillDetail> {
  const trimmed = slug.trim();
  if (!trimmed) throw new HubError('BAD_REQUEST', 'slug is required');
  const ns = namespace?.trim() || undefined;
  const qs = ns ? `?namespace=${encodeURIComponent(ns)}` : '';
  const body = (await hubFetchJson(
    `${hubApiBase()}/api/v1/skills/${encodeURIComponent(trimmed)}${qs}`,
  )) as unknown as RawHubSkillDetail;

  const skill = body.skill ?? {};
  const finalSlug = asString(skill.slug).trim() || trimmed;
  const nsHandle = asString(body.namespace?.handle).trim() || ns || '';
  const readme = await fetchHubSkillReadme(trimmed, ns);
  // Prefer the Chinese summary — same zh-first rule as the list mapper.
  const description = asString(skill.summary_zh).trim() || asString(skill.summary).trim();
  const changelog = asString(body.latestVersion?.changelog).trim();
  const keen = asString(body.securityReports?.keen?.statusText).trim();
  const sanbu = asString(body.securityReports?.sanbu?.statusText).trim();

  return {
    slug: finalSlug,
    name: asString(skill.displayName).trim() || finalSlug,
    description,
    category: asString(skill.category),
    sourceUrl: asString(skill.sourceUrl),
    iconUrl: asString(skill.iconUrl),
    createdAt: asNumber(skill.createdAt),
    updatedAt: asNumber(skill.updatedAt),
    verified: skill.verified === true,
    requiresApiKey: skill.labels?.requires_api_key === 'true',
    ownerName:
      asString(body.owner?.displayName).trim() || asString(body.owner?.handle).trim() || nsHandle,
    ...(nsHandle ? { namespace: nsHandle } : {}),
    latestVersion: asString(body.latestVersion?.version),
    ...(changelog ? { changelog } : {}),
    stats: {
      downloads: asNumber(skill.stats?.downloads),
      installs: asNumber(skill.stats?.installs),
      stars: asNumber(skill.stats?.stars),
      versions: asNumber(skill.stats?.versions),
    },
    readme,
    ...(keen || sanbu ? { security: { ...(keen ? { keen } : {}), ...(sanbu ? { sanbu } : {}) } } : {}),
  };
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

/** Test/limit-injection knob for extractSkillZip (defaults = import limits). */
export interface ZipExtractLimits {
  maxFiles: number;
  /** Cumulative UNCOMPRESSED bytes across all entries. */
  maxBytes: number;
}

/**
 * Total entry count recorded in the zip's end-of-central-directory record, or
 * null when the record is missing (truncated / not a zip). The streaming
 * decoder below stops silently at some structural corruptions, so this is the
 * integrity check: extracted entry count must match the declared count.
 */
function zipDeclaredEntryCount(zipBytes: Uint8Array): number | null {
  const len = zipBytes.length;
  if (len < 22) return null; // smallest possible EOCD
  // EOCD sits at the very end, except for an optional comment (≤ 65535 bytes).
  const scanFrom = Math.max(0, len - 22 - 65535);
  for (let i = len - 22; i >= scanFrom; i -= 1) {
    if (
      zipBytes[i] === 0x50 && zipBytes[i + 1] === 0x4b &&
      zipBytes[i + 2] === 0x05 && zipBytes[i + 3] === 0x06
    ) {
      return (zipBytes[i + 10] ?? 0) | ((zipBytes[i + 11] ?? 0) << 8);
    }
  }
  return null;
}

/**
 * Extract a skill zip into `destDir` with the two untrusted-archive defenses:
 *  - zip-slip: entry paths are normalized, must stay relative, and their
 *    resolved target must remain inside destDir (rejects `../` and absolute
 *    paths, including Windows drive-letter paths);
 *  - zip bomb: the caps are enforced on the bytes ACTUALLY produced by
 *    decompression, entry by entry, via fflate's streaming Unzip. This
 *    matters because the download cap bounds the COMPRESSED stream only — a
 *    high-ratio archive (e.g. repeated zeros) can expand to many times that,
 *    and a one-shot unzipSync would materialize all of it in memory before
 *    any size check could run. Here a cap violation aborts mid-stream with
 *    memory bounded by the cap itself. Header-declared sizes are NOT trusted
 *    (they can lie); the cumulative count of real decompressed bytes is the
 *    source of truth. `limits` overrides the caps for tests.
 *
 * Synchronous: UnzipInflate is the sync decoder, so every file event fires
 * inside push() and cap errors propagate directly to the caller.
 */
export function extractSkillZip(zipBytes: Uint8Array, destDir: string, limits?: ZipExtractLimits): void {
  const maxFiles = limits?.maxFiles ?? MAX_IMPORT_FILES;
  const maxBytes = limits?.maxBytes ?? MAX_IMPORT_BYTES;

  if (zipBytes.length < 2 || zipBytes[0] !== 0x50 || zipBytes[1] !== 0x4b) {
    throw new HubError('BAD_REQUEST', '下载的内容不是有效的 zip 技能包');
  }
  const declaredEntries = zipDeclaredEntryCount(zipBytes);
  if (declaredEntries === null) {
    throw new HubError('BAD_REQUEST', '下载的内容不是有效的 zip 技能包');
  }

  const destAbs = path.resolve(destDir);
  fs.mkdirSync(destAbs, { recursive: true });
  let seenEntries = 0;
  let files = 0;
  let bytes = 0;
  let fd: number | null = null;

  const unzipper = new Unzip();
  unzipper.register(UnzipInflate);
  unzipper.onfile = (file) => {
    seenEntries += 1;
    const rawName = file.name;
    if (rawName.endsWith('/')) {
      file.terminate(); // directory entry — nothing to write
      return;
    }
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
    if (files > maxFiles) {
      throw new HubError('BAD_REQUEST', `技能包文件数超过上限（最多 ${maxFiles} 个文件）`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fd = fs.openSync(target, 'w');
    file.ondata = (err, chunk, final) => {
      if (err) {
        throw new HubError('BAD_REQUEST', `技能包解压失败：${errMsg(err)}`);
      }
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        throw new HubError(
          'BAD_REQUEST',
          `技能包解压后过大（最大 ${Math.round(maxBytes / 1024 / 1024)} MB）`,
        );
      }
      if (chunk.byteLength > 0 && fd !== null) fs.writeSync(fd, chunk);
      if (final && fd !== null) {
        fs.closeSync(fd);
        fd = null;
      }
    };
    file.start();
  };

  try {
    unzipper.push(zipBytes, true);
  } catch (err) {
    if (err instanceof HubError) throw err;
    throw new HubError('BAD_REQUEST', `技能包解压失败：${errMsg(err)}`);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // best-effort: extraction is aborting anyway
      }
    }
  }

  // 0xffff marks a zip64 archive; those are far beyond the file cap anyway
  // (which would have fired during push), so skip the comparison there.
  if (declaredEntries < 0xffff && seenEntries !== declaredEntries) {
    throw new HubError('BAD_REQUEST', '技能包不完整或已损坏，请重试');
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
//
// Identity is (namespace, slug) — the hub allows the same slug under
// different namespaces. `namespace` is '' for catalog entries without one.

export interface HubInstallRecord {
  slug: string;
  skill_id: string;
  version: string;
  namespace: string;
  installed_at: number;
  updated_at: number;
}

/** Map key shared by the in-memory annotation map and the in-flight guard. */
export function hubInstallKey(slug: string, namespace: string | null | undefined): string {
  return `${(namespace ?? '').trim()}/${slug}`;
}

export function listHubInstalls(db: Database.Database): HubInstallRecord[] {
  return db.prepare('SELECT * FROM hub_skill_installs').all() as HubInstallRecord[];
}

/** `namespace` must already be normalized ('' when the entry has none). */
export function getHubInstall(db: Database.Database, slug: string, namespace: string): HubInstallRecord | null {
  return (
    db
      .prepare('SELECT * FROM hub_skill_installs WHERE namespace = ? AND slug = ?')
      .get(namespace, slug) as HubInstallRecord | undefined
  ) ?? null;
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

/** Hub slugs/namespaces are simple path-safe names; validate before interpolating into URLs/dirs. */
const SAFE_SLUG = /^[\w.-]+$/;

/**
 * In-flight installs keyed by hubInstallKey(namespace, slug). Concurrent
 * requests for the SAME skill share one download+import run instead of
 * racing the check-then-act on the registry (which used to create duplicate
 * skills / interleave rm+copy on one content dir). Requests for DIFFERENT
 * (namespace, slug) pairs still run concurrently.
 */
const inflightInstalls = new Map<string, Promise<InstallHubSkillResult>>();

/**
 * Download + install (or refresh) a hub skill, serialized per
 * (namespace, slug) — see inflightInstalls.
 *
 * Fresh (namespace, slug) → extract → importFromFolder (shared limits/parsing
 *                pipeline) → record (namespace, slug) → skill id.
 * Known (namespace, slug) → atomically swap the existing skill's content dir
 *                and update its name/description metadata. The SKILL.md itself
 *                is NOT regenerated (updateSkill would rewrite the frontmatter
 *                and drop extra fields like allowed-tools), and the skill id /
 *                enabled state are preserved, so "reinstall" behaves like an
 *                update.
 */
export function installHubSkill(
  db: Database.Database,
  req: InstallHubSkillRequest,
  opts?: SkillPathsOpts,
): Promise<InstallHubSkillResult> {
  const slug = (req.slug ?? '').trim();
  if (!slug || !SAFE_SLUG.test(slug) || slug.length > 128) {
    return Promise.reject(new HubError('BAD_REQUEST', '无效的技能标识（slug）'));
  }
  // '' when absent — it is part of the registry key.
  const namespace = (req.namespace ?? '').trim();
  if (namespace && (!SAFE_SLUG.test(namespace) || namespace.length > 128)) {
    return Promise.reject(new HubError('BAD_REQUEST', '无效的技能命名空间（namespace）'));
  }
  const version = req.version?.trim() || undefined;

  const key = hubInstallKey(slug, namespace);
  const running = inflightInstalls.get(key);
  if (running) return running;
  const task = runInstallHubSkill(db, slug, version, namespace, opts).finally(() => {
    inflightInstalls.delete(key);
  });
  inflightInstalls.set(key, task);
  return task;
}

async function runInstallHubSkill(
  db: Database.Database,
  slug: string,
  version: string | undefined,
  namespace: string,
  opts?: SkillPathsOpts,
): Promise<InstallHubSkillResult> {
  const zipPath = path.join(os.tmpdir(), `molio-hub-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-hub-skill-'));
  try {
    await downloadHubZip(slug, version, namespace || undefined, zipPath);
    extractSkillZip(new Uint8Array(fs.readFileSync(zipPath)), extractDir);
    if (!fs.existsSync(path.join(extractDir, 'SKILL.md'))) {
      throw new HubError('BAD_REQUEST', '技能包根目录缺少 SKILL.md');
    }
    const pkgVersion = readPackageVersion(extractDir);
    const now = Date.now();

    const existing = getHubInstall(db, slug, namespace);
    if (existing && getSkill(db, existing.skill_id)) {
      // Refresh in place, keeping row id + enabled state. mirrorDirIfChanged
      // stages into a temp dir and swaps with rename + rollback, so a failure
      // mid-copy can never wipe the previously installed content (the old
      // rm-then-copy left the skill dir gone on any copy/parse error).
      const contentDir = skillContentDir(existing.skill_id, opts);
      mirrorDirIfChanged(extractDir, contentDir);
      const parsed = parseSkillMd(fs.readFileSync(path.join(contentDir, 'SKILL.md'), 'utf8'));
      db.prepare('UPDATE skills SET name = ?, description = ?, updated_at = ? WHERE id = ?').run(
        parsed.name.trim() || existing.skill_id,
        parsed.description,
        now,
        existing.skill_id,
      );
      db.prepare(
        'UPDATE hub_skill_installs SET version = ?, updated_at = ? WHERE namespace = ? AND slug = ?',
      ).run(pkgVersion, now, namespace, slug);
      const skill = getSkill(db, existing.skill_id);
      if (!skill) throw new HubError('HUB_UNAVAILABLE', '技能记录更新失败，请重试');
      return { skill, updated: true, version: pkgVersion };
    }

    // Fresh install through the shared folder-import pipeline (limits + parse).
    const skill = importFromFolder(db, extractDir, opts);
    db.prepare(
      `INSERT OR REPLACE INTO hub_skill_installs (slug, skill_id, version, namespace, installed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(slug, skill.id, pkgVersion, namespace, now, now);
    return { skill, updated: false, version: pkgVersion };
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.rmSync(zipPath, { force: true });
  }
}
