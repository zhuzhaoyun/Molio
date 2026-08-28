// apps/cloud/test/market-signer.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { OssSigner } from '../src/market/signer.js';

const opt = { bucket: 'molio-pay', region: 'cn-guangzhou', accessKeyId: 'AKID-test', accessKeySecret: 'SK-test' };

test('signPut：签名可被独立重算验证', () => {
  const signer = new OssSigner(opt, { now: () => 1_700_000_000_000 });
  const t = signer.signPut('next/x-vault.zip', 'application/zip', 3600);
  const expires = Math.floor(1_700_000_000_000 / 1000) + 3600;
  const sts = `PUT\n\napplication/zip\n${expires}\n/molio-pay/next/x-vault.zip`;
  const sig = createHmac('sha1', 'SK-test').update(sts).digest('base64');
  const u = new URL(t.url);
  assert.equal(u.origin, 'https://molio-pay.oss-cn-guangzhou.aliyuncs.com');
  assert.equal(u.pathname, '/next/x-vault.zip');
  assert.equal(u.searchParams.get('OSSAccessKeyId'), 'AKID-test');
  assert.equal(u.searchParams.get('Expires'), String(expires));
  assert.equal(u.searchParams.get('Signature'), sig);
  assert.equal(t.expiresAt, expires * 1000);
});

test('signGet：response-content-disposition 进签名与 URL', () => {
  const signer = new OssSigner(opt, { now: () => 1_700_000_000_000 });
  const cd = "attachment; filename*=UTF-8''%E6%B5%8B-vault.zip";
  const t = signer.signGet('resources/x-vault.zip', 3600, cd);
  const u = new URL(t.url);
  assert.equal(u.searchParams.get('response-content-disposition'), cd);
});

test('headObject：200 → 取 Content-Length，带 V1 鉴权头', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status: 200, headers: { 'content-length': '12345' } });
  }) as unknown as typeof fetch;
  const signer = new OssSigner(opt, { fetchImpl });
  const got = await signer.headObject('resources/x-vault.zip');
  assert.equal(got?.size, 12345);
  assert.match(String(calls[0]!.url), /^https:\/\/molio-pay\.oss-cn-guangzhou\.aliyuncs\.com\/resources\/x-vault\.zip$/);
  const h = calls[0]!.init.headers as Record<string, string>;
  assert.equal(h['Authorization']!.startsWith('OSS AKID-test:'), true);
});

test('copyObject：带 copy-source 与 object-acl 头', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  const signer = new OssSigner(opt, { fetchImpl });
  await signer.copyObject('next/x-p1.png', 'resources/x-p1.png', 'public-read');
  const h = calls[0]!.init.headers as Record<string, string>;
  assert.equal(h['x-oss-copy-source'], '/molio-pay/next/x-p1.png');
  assert.equal(h['x-oss-object-acl'], 'public-read');
});
