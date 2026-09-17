// IndexNow key 文件校验（node:test）。
// 协议要求：key 文件放在站点根目录，文件名 = key，文件内容 = key；提交后用 GET /<key>.txt 反查校验。
// 文件名与内容不一致是这里唯一会静默失败的点（线上表现为提交被拒，但看不出原因），所以用测试钉住。
// 运行：node --test apps/landing-page/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const LANDING_PAGE = path.join(here, '..');

test('indexnow: 根目录有 key 文件，且内容与文件名一致', () => {
  const files = readdirSync(LANDING_PAGE).filter((f) => /^[0-9a-f]{32}\.txt$/.test(f));
  assert.equal(files.length, 1, `期望恰好 1 个 <32位hex>.txt，实际 ${files.length}：${files.join(', ')}`);
  const content = readFileSync(path.join(LANDING_PAGE, files[0]), 'utf8').trim();
  assert.equal(content, files[0].replace(/\.txt$/, ''), 'key 文件内容必须等于文件名');
});
