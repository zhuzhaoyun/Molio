import assert from 'node:assert/strict';
import test from 'node:test';
import { isOriginAllowed } from '../src/cors.js';
import { get, post, setup } from './helpers.js';

// ─── isOriginAllowed 白名单判定 ─────────────────────────────

test('cors: prod 仅放行官网域名 + 附加来源，不放行 localhost', () => {
  const { config } = setup({ env: 'prod', corsExtraOrigins: ['https://preview.molio.cn'] });
  assert.ok(isOriginAllowed(config, 'https://molio.cn'));
  assert.ok(isOriginAllowed(config, 'https://www.molio.cn'));
  assert.ok(isOriginAllowed(config, 'https://preview.molio.cn'));
  assert.ok(!isOriginAllowed(config, 'http://localhost:5173'));
  assert.ok(!isOriginAllowed(config, 'https://evil.com'));
  // 协议降级也不行：官网是 https，http 来源一律拒绝
  assert.ok(!isOriginAllowed(config, 'http://molio.cn'));
});

test('cors: daily/local 放行 localhost 任意端口（联调），仍拒绝任意外站', () => {
  const { config } = setup({ env: 'daily' });
  assert.ok(isOriginAllowed(config, 'http://localhost:5173'));
  assert.ok(isOriginAllowed(config, 'http://127.0.0.1:8080'));
  assert.ok(isOriginAllowed(config, 'https://molio.cn')); // 官网域名全环境放行
  assert.ok(!isOriginAllowed(config, 'https://evil.com'));
  assert.ok(!isOriginAllowed(config, 'not-a-url'));
});

// ─── 中间件行为（经 createApp 全链路） ───────────────────────

test('cors: 白名单 origin 的预检 → 204 + 头齐全，且无 Allow-Credentials', async () => {
  const { app } = setup({ env: 'prod' });
  const res = await app.request('/auth/send-code', {
    method: 'OPTIONS',
    headers: { origin: 'https://molio.cn', 'access-control-request-method': 'POST' },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://molio.cn');
  assert.equal(res.headers.get('access-control-allow-methods'), 'GET, POST, PATCH, DELETE, OPTIONS');
  assert.ok((res.headers.get('access-control-allow-headers') ?? '').includes('authorization'));
  assert.equal(res.headers.get('access-control-max-age'), '600');
  assert.equal(res.headers.get('access-control-allow-credentials'), null, '无 cookie 语义，永不带 credentials');
  assert.ok((res.headers.get('vary') ?? '').includes('Origin'));
});

test('cors: 非白名单 origin 预检 → 204 但不下发任何 CORS 头', async () => {
  const { app } = setup({ env: 'prod' });
  const res = await app.request('/auth/send-code', {
    method: 'OPTIONS',
    headers: { origin: 'https://evil.com' },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  assert.ok((res.headers.get('vary') ?? '').includes('Origin'));
});

test('cors: 白名单 GET 响应回显 origin（不用 *），非白名单无 ACAO 头但业务照常', async () => {
  const { app } = setup({ env: 'prod' });
  const ok = await get(app, '/health', { origin: 'https://www.molio.cn' });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://www.molio.cn');

  const bad = await get(app, '/health', { origin: 'https://evil.com' });
  assert.equal(bad.status, 200, '服务端不因 CORS 拒绝——拦截在浏览器侧');
  assert.equal(bad.headers.get('access-control-allow-origin'), null);

  const noOrigin = await get(app, '/health');
  assert.equal(noOrigin.status, 200, '无 Origin 的非浏览器客户端（daemon）不受影响');
  assert.equal(noOrigin.headers.get('access-control-allow-origin'), null);
});

test('cors: 白名单 POST 业务链路不受影响（send-code 全链路）', async () => {
  const { app, sent } = setup({ env: 'daily' });
  const res = await post(app, '/auth/send-code', { email: 'a@b.com' }, { origin: 'http://localhost:4321' });
  assert.equal(res.status, 202);
  assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:4321');
  assert.equal(sent.length, 1);
});
