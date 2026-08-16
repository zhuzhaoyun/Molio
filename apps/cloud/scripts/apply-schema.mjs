#!/usr/bin/env node
/**
 * 将 apps/cloud/schema.sql 导入 DATABASE_URL 指向的 PostgreSQL（RDS / PolarDB 均可）。
 *
 * 用法（仓库根目录，Git Bash）：
 *   DATABASE_URL="postgres://用户:密码@连接地址:5432/库名" node apps/cloud/scripts/apply-schema.mjs
 *
 * DDL 全部 IF NOT EXISTS，幂等，可重复执行。
 * 若实例强制 SSL，连接串末尾加 ?sslmode=require。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error(
    '用法: DATABASE_URL="postgres://用户:密码@连接地址:5432/库名" node apps/cloud/scripts/apply-schema.mjs',
  );
  process.exit(1);
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(path.join(dir, '..', 'schema.sql'), 'utf8');

const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15_000 });
try {
  await client.connect();
  const ver = await client.query('select version()');
  console.log('[apply-schema] 已连接:', String(ver.rows[0].version).split(',')[0]);

  await client.query(sql);
  console.log('[apply-schema] schema.sql 执行完成');

  const tables = await client.query(
    "select table_name from information_schema.tables where table_schema='public' order by 1",
  );
  console.log('[apply-schema] 现有表:', tables.rows.map((r) => r.table_name).join(', '));

  const indexes = await client.query(
    "select indexname from pg_indexes where schemaname='public' order by 1",
  );
  console.log('[apply-schema] 现有索引:', indexes.rows.map((r) => r.indexname).join(', '));
  console.log('[apply-schema] 导入成功 ✔');
} catch (err) {
  // 整个 schema.sql 作为单条多语句查询执行，pg 报错不含失败语句原文；
  // 打完整错误对象（含 position/detail/hint）+ 堆栈，方便定位是哪条 DDL 失败
  console.error('[apply-schema] 失败:', err);
  if (err && err.stack) console.error('[apply-schema] 堆栈:', err.stack);
  if (/timeout/i.test(String(err && err.message))) {
    console.error('提示: 连接超时通常是 RDS 白名单没放行本机 IP（控制台 → 数据安全性 → 白名单设置）');
  }
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
