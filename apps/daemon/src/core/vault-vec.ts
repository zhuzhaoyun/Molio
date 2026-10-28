/**
 * Vault 文件语义向量层（检索 P0 层 2）——嵌入器 + 向量表 + 暴力余弦扫。
 * 设计：docs/2026-10-10-retrieval-p0.md §4.2；成本实测：
 * docs/2026-10-27-embedding-phase3-feasibility.md §四（bge-small-zh-v1.5 q8：
 * 包体 +54MB(mac)/+37MB(win)、内存净增 120–150MB、吞吐 ~170 块/s）。
 *
 * 形态与层 1（vault-search.ts）同构：整库 walk 分片让位（registerBuild 单行道、
 * 'vec' 令牌与字面构建互不阻塞）、mtime/size 判变（向量行回显 + model 列，换
 * 模型即全量重算）、搜索侧自动建库 + 空库 seeded 标记。区别只有两处：
 *  - 指纹不可增量修补：文件变了就整份重嵌（块均值池化，L2 归一后存一行）；
 *  - 降级即隐形：模型没下载/加载失败 → available:false，调用方退回纯字面，
 *    用户无感知（红线：层 2 永远不能让层 1 变慢或变坏）。
 *
 * 嵌入器可注入（Embedder 接口）：测试用确定性 stub，不拉真模型；真模型只在
 * TransformersEmbedder 里按需动态 import——@huggingface/transformers 拖着
 * onnxruntime-node 原生依赖（安装体积大头），除打包白名单（打包切片处理）外
 * 必须保持「不用不加载」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { getVault, type SqliteDb } from './db.js';
import { isIndexableExt, registerBuild, getInflight, MAX_INDEX_FILE_BYTES } from './vault-search.js';
import { isPrunedDirName, MAX_DIR_ENTRIES, MAX_TOTAL } from './vault-prune.js';

export const EMBED_MODEL_ID = 'Xenova/bge-small-zh-v1.5';

/** 单块上限（字符）。bge 的 512 token ≈ 300–500 汉字，留余量给 tokenizer 差异。 */
export const CHUNK_CHARS = 400;
/**
 * 单文件最多嵌的块数。指纹取各块均值——8 块 ≈ 3200 字，覆盖绝大多数笔记的
 * 有效语义；超出部分截断（指纹允许不完美，索引成本必须有上界：2MB 文本不设限
 * 就是 5000+ 块 × 6ms，一个文件拖垮整库重建预算）。
 */
export const MAX_VEC_CHUNKS = 8;

/** 嵌入器接口——真实实现与测试 stub 的共同形状。向量必须已 L2 归一。 */
export interface Embedder {
  readonly modelId: string;
  /** 永久降级标记：置位后调用方直接走纯字面，不再尝试嵌入（TransformersEmbedder 加载失败时置位）。 */
  failed?: boolean;
  embed(texts: string[]): Promise<Float32Array[]>;
  dispose(): Promise<void>;
}

/**
 * 分块：段落优先打包，超长段落硬切。纯函数（单测钉行为）。
 * 空白内容返回 []（不产生向量行——没有可比较的语义）。
 */
export function chunkText(content: string, maxChars = CHUNK_CHARS, maxChunks = MAX_VEC_CHUNKS): string[] {
  const chunks: string[] = [];
  let cur = '';
  const push = (): void => {
    if (cur.trim()) chunks.push(cur);
    cur = '';
  };
  for (const para of content.split(/\n+/)) {
    if (para.length > maxChars) {
      push(); // 超长段落前先收尾当前块
      for (let i = 0; i < para.length && chunks.length < maxChunks; i += maxChars) {
        chunks.push(para.slice(i, i + maxChars));
      }
      if (chunks.length >= maxChunks) return chunks;
      continue;
    }
    if (cur.length + para.length + 1 > maxChars) push();
    if (chunks.length >= maxChunks) return chunks;
    cur = cur ? `${cur}\n${para}` : para;
  }
  push();
  return chunks;
}

/** 各块嵌入的均值池化 + L2 归一。空输入返回 undefined（调用方跳过该文件）。 */
export function meanPool(vectors: Float32Array[]): Float32Array | undefined {
  if (vectors.length === 0) return undefined;
  const out = new Float32Array(vectors[0]!.length);
  for (const v of vectors) {
    for (let i = 0; i < out.length; i++) out[i]! += v[i]!;
  }
  let norm = 0;
  for (let i = 0; i < out.length; i++) {
    out[i]! /= vectors.length;
    norm += out[i]! * out[i]!;
  }
  norm = Math.sqrt(norm);
  if (norm === 0) return undefined;
  for (let i = 0; i < out.length; i++) out[i]! /= norm;
  return out;
}

/**
 * 真实嵌入器：transformers.js（onnxruntime-node 后端）+ q8 量化。
 * 中国网络默认走 hf-mirror（正式镜像链 ModelScope→hf-mirror→OSS 在下载切片接，
 * 届时替换 remoteHost 决策点）；模型文件缓存后冷加载 0.1s（Task 0 实测）。
 * 闲置 10 分钟卸载：净增 120–150MB RSS 不能常驻——daemon 还有图谱/索引/会话。
 */
const IDLE_UNLOAD_MS = 10 * 60_000;

export class TransformersEmbedder implements Embedder {
  readonly modelId = EMBED_MODEL_ID;
  /** 加载失败后置位：调用方据此走降级，不再反复尝试（重试时机=进程重启或显式 reset）。 */
  failed = false;
  private extractor?: (
    texts: string | string[],
    opts: { pooling: string; normalize: boolean },
  ) => Promise<{ data: Float32Array }>;
  private loadPromise?: Promise<void>;
  private idleTimer?: ReturnType<typeof setTimeout>;

  private async ensureLoaded(): Promise<void> {
    if (this.extractor) return;
    this.loadPromise ??= (async () => {
      const tf = await import('@huggingface/transformers');
      tf.env.remoteHost = process.env.MOLIO_HF_REMOTE_HOST ?? 'https://hf-mirror.com';
      tf.env.allowLocalModels = false;
      const pipe = await tf.pipeline('feature-extraction', EMBED_MODEL_ID, { dtype: 'q8' });
      this.extractor = (texts, opts) =>
        pipe(texts, { pooling: opts.pooling as 'cls', normalize: opts.normalize }) as Promise<{ data: Float32Array }>;
    })();
    try {
      await this.loadPromise;
    } catch (err) {
      this.loadPromise = undefined;
      this.failed = true;
      throw err;
    }
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (this.failed) throw new Error('embedder previously failed (degraded)');
    await this.ensureLoaded();
    // 每次使用重置闲置计时；卸载后下次 embed 走重新加载（缓存命中 ~0.1s）
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.dispose(), IDLE_UNLOAD_MS);
    this.idleTimer.unref?.();
    const out: Float32Array[] = [];
    for (const text of texts) {
      const tensor = await this.extractor!(text, { pooling: 'cls', normalize: true });
      // 拷贝出 tensor 缓冲：底层 may be reused/freed by runtime after dispose
      out.push(new Float32Array(tensor.data));
    }
    return out;
  }

  async dispose(): Promise<void> {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.extractor = undefined;
    this.loadPromise = undefined;
    // transformers.js v3 无显式释放 API；丢引用交 onnxruntime GC（Task 0 实测
    // 卸载路径=丢 pipeline 引用后 RSS 回落）。
  }
}

/** daemon 运行时共享的单例（接线切片使用；测试各造各的 stub，不经这里）。 */
let shared: TransformersEmbedder | undefined;
export function getSharedEmbedder(): TransformersEmbedder {
  shared ??= new TransformersEmbedder();
  return shared;
}

/** 向量重建参数——与层 1 ReindexOpts 同款分片语义。 */
export interface VecBuildOpts {
  maxTotal?: number;
  yieldEvery?: number;
  shouldStop?: () => boolean;
}

/**
 * 整库重建一个 vault 的向量表。与 reindexVault 同款剪枝与分片；未变文件
 * （mtime/size/model 三者与向量行一致）只 stat 不读不嵌。空内容文件不产生
 * 向量行（无语义可比），每次重建会重读一次——量级可忽略。
 */
export async function vecBuildVault(
  db: SqliteDb, vaultId: string, vaultPath: string, embedder: Embedder, opts: VecBuildOpts = {},
): Promise<{ indexed: number; removed: number }> {
  const maxTotal = opts.maxTotal ?? MAX_TOTAL;
  const yieldEvery = opts.yieldEvery ?? 50;
  const shouldStop = opts.shouldStop ?? (() => false);
  const seen = new Set<string>();
  let indexed = 0;
  let processed = 0;

  const upsert = db.prepare(
    `INSERT INTO vault_files_vec(vault_id, file_path, model, mtime, size, chunks, vector)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(vault_id, file_path) DO UPDATE SET
       model = excluded.model, mtime = excluded.mtime, size = excluded.size,
       chunks = excluded.chunks, vector = excluded.vector`,
  );
  const delRow = db.prepare('DELETE FROM vault_files_vec WHERE vault_id = ? AND file_path = ?');
  const walk = async (absDir: string, relBase: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.length > MAX_DIR_ENTRIES) return;
    for (const entry of entries) {
      if (shouldStop()) return;
      if (seen.size >= maxTotal) return;
      if (isPrunedDirName(entry.name)) continue;
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.isFile() && isIndexableExt(rel)) {
        seen.add(rel);
        const stat = await fs.promises.stat(abs).catch(() => undefined);
        // 消失/过大：与层 1 同款即时清行（过大留着旧向量是语义 stale）
        if (!stat?.isFile() || stat.size > MAX_INDEX_FILE_BYTES) {
          delRow.run(vaultId, rel);
          processed++;
          if (yieldEvery > 0 && processed % yieldEvery === 0) {
            await new Promise((resolve) => setImmediate(resolve));
          }
          continue;
        }
        const row = db.prepare(
          'SELECT 1 FROM vault_files_vec WHERE vault_id = ? AND file_path = ? AND model = ? AND mtime = ? AND size = ?',
        ).get(vaultId, rel, embedder.modelId, Math.floor(stat.mtimeMs), stat.size);
        if (!row) {
          const content = await fs.promises.readFile(abs, 'utf-8').catch(() => undefined);
          if (content !== undefined) {
            const chunks = chunkText(content);
            const vec = meanPool(chunks.length ? await embedder.embed(chunks) : []);
            if (vec) {
              upsert.run(
                vaultId, rel, embedder.modelId, Math.floor(stat.mtimeMs), stat.size,
                chunks.length, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength),
              );
              indexed++;
            }
          }
        }
        processed++;
        if (yieldEvery > 0 && processed % yieldEvery === 0) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
    }
  };
  await walk(vaultPath, '');

  // 收尾清除磁盘上已消失的路径（含换模型后的旧行——seen 按 rel 记，模型切换的
  // 行还在 seen 里，由「三要素不一致→重算」处理，不在此误删）
  const known = db.prepare('SELECT file_path FROM vault_files_vec WHERE vault_id = ?')
    .all(vaultId) as Array<{ file_path: string }>;
  const stale = known.map((r) => r.file_path).filter((p) => !seen.has(p));
  const removed = stale.length;
  if (removed > 0) {
    const del = db.prepare('DELETE FROM vault_files_vec WHERE vault_id = ? AND file_path = ?');
    const batch = db.transaction((paths: string[]) => {
      for (const p of paths) del.run(vaultId, p);
    });
    const chunk = yieldEvery > 0 ? yieldEvery : removed;
    for (let i = 0; i < removed; i += chunk) {
      if (i > 0) await new Promise((resolve) => setImmediate(resolve));
      batch(stale.slice(i, i + chunk));
    }
  }
  return { indexed, removed };
}

/** 等（没有则触发）一次向量构建；并发调用共享同一次构建（与字面构建互不阻塞）。 */
export function ensureVecIndexed(
  db: SqliteDb, vaultId: string, vaultPath: string, embedder: Embedder, opts: VecBuildOpts = {},
): Promise<void> {
  return registerBuild(db, vaultId, 'vec', () => vecBuildVault(db, vaultId, vaultPath, embedder, opts));
}

export interface VecSearchResult {
  /** false = 模型不可用（未下载/加载失败），调用方退回纯字面，results 恒空 */
  available: boolean;
  results: Array<{ filePath: string; score: number }>;
}

/** 空库 seeded 标记（语义同 vault-search.ts 的 seededVaults，向量层单独记账）。 */
const vecSeeded = new WeakMap<SqliteDb, Set<string>>();

/**
 * 语义搜索：查询文本嵌入 → 该 vault 全向量暴力余弦（行内向量已归一，点积即
 * 余弦）→ 降序取 top。万文件 × 512 维 ≈ 5M 次乘加，毫秒到几十毫秒（§4.2 判定）。
 * 任何嵌入侧失败（未下载/加载失败/推理抛错）都降级为 available:false——
 * 这条路径上不许抛错，否则层 2 一次抽风就拖死整个搜索接口。
 */
export async function vecSearch(
  db: SqliteDb, vaultId: string, vaultPath: string, query: string,
  embedder: Embedder, limit = 10,
): Promise<VecSearchResult> {
  const trimmed = query.replace(/\s+/g, ' ').trim().slice(0, CHUNK_CHARS);
  if (!trimmed) return { available: true, results: [] };
  if (embedder.failed) return { available: false, results: [] };

  // 有 in-flight 向量构建先等它（避免读到半成品）；空表且没建过才触发一次。
  // 并发首次搜索会在 ensureVecIndexed 的登记口合并成同一次构建，不重复 walk。
  const building = getInflight(db, vaultId, 'vec');
  if (building) {
    try {
      await building;
    } catch {
      // 在途构建失败（多为模型侧）：等待方同样降级，不外抛——与下方直接触发
      // 建库的 catch 同口径，这条路径上不许抛错（本文件头红线）。
      return { available: false, results: [] };
    }
  } else if (!db.prepare('SELECT 1 FROM vault_files_vec WHERE vault_id = ? LIMIT 1').get(vaultId)) {
    if (!vecSeeded.get(db)?.has(vaultId)) {
      const vault = getVault(db, vaultId);
      if (!vault) return { available: true, results: [] };
      try {
        await ensureVecIndexed(db, vaultId, vaultPath, embedder);
      } catch {
        return { available: false, results: [] }; // 建库失败（多为模型侧）→ 降级
      }
      let seeded = vecSeeded.get(db);
      if (!seeded) {
        seeded = new Set<string>();
        vecSeeded.set(db, seeded);
      }
      seeded.add(vaultId);
    }
  }

  let queryVec: Float32Array;
  try {
    queryVec = (await embedder.embed([trimmed]))[0]!;
  } catch {
    return { available: false, results: [] };
  }

  const rows = db.prepare('SELECT file_path, vector FROM vault_files_vec WHERE vault_id = ?')
    .all(vaultId) as Array<{ file_path: string; vector: Buffer }>;
  const scored: Array<{ filePath: string; score: number }> = [];
  for (const row of rows) {
    const v = new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4);
    let dot = 0;
    for (let i = 0; i < queryVec.length && i < v.length; i++) dot += queryVec[i]! * v[i]!;
    scored.push({ filePath: row.file_path, score: dot });
  }
  scored.sort((x, y) => y.score - x.score);
  return { available: true, results: scored.slice(0, limit) };
}
