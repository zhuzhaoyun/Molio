/**
 * Mock SkillHub —— skill-hub-real-install.spec.ts 的配套假商店源。
 *
 * daemon 的 hub 客户端通过 `MOLIO_SKILLHUB_API` 可指向本进程（hub.ts
 * hubApiBase()），于是「安装/刷新」走真实 HTTP 下载链路而不碰真商店。
 * 只实现 install 路径需要的端点：GET /api/v1/download?slug=accept-demo
 * （目录/详情端点 install 不依赖——hub-drift.test.ts 的 fetch mock 只服务
 * download 也装成功，这里是同一事实的全链路版）。
 *
 * 用法（端口被占时按 e2e 惯例整体平移）：
 *   node e2e/fixtures/mock-hub.mjs                  # 默认端口 4310
 *   MOLIO_SKILLHUB_API=http://localhost:<mock-hub 端口> \
 *     pnpm --filter @molio/web exec playwright test e2e/skill-hub-real-install.spec.ts
 */
import http from 'node:http';
import { zipSync, strToU8 } from 'fflate';

const PORT = Number(process.env.MOCK_HUB_PORT ?? 4310);
const SLUG = 'accept-demo';

/** 与 skill-hub-real-install.spec.ts 断言强联动：改正文/版本要同步改断言。 */
const SKILL_MD = [
  '---',
  'name: 验收演示',
  'description: mock hub 全链路验收用技能',
  'version: 1.0.0',
  '---',
  '',
  'V1 官方正文内容。',
  '',
].join('\n');

const zip = zipSync({
  'SKILL.md': strToU8(SKILL_MD),
  '_meta.json': strToU8(JSON.stringify({ slug: SLUG, version: '1.0.0' })),
});

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === '/api/v1/download' && url.searchParams.get('slug') === SLUG) {
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': zip.length });
    res.end(zip);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, () => console.log(`[mock-hub] listening on ${PORT}`));
