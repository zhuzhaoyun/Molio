// apps/web/e2e/fixtures/mock-oss.mjs — 接受预签名 PUT/HEAD/GET 的最小 OSS 替身（:3199）
//
// 语义对齐真实 OSS（裁决 2026-08-25）：云端 confirm 转正走服务端 copyObject——
// 带 `x-oss-copy-source` 头、无请求体的 PUT → 按源键复制已存字节，源缺失回 404。
// 不实现该分支时，转正后 live 对象（zip/效果图）为空字节：预览图破裂、下载 0 字节。
//
// 键空间说明：预签名直传 URL 走 endpointOverride（baseUrl 原样），路径不含桶名，
// 直传对象落键 `/{key}`；而 copyObject 的 x-oss-copy-source 值为 `/{bucket}/{key}`，
// 故复制分支精确命中失败时剥掉首段路径（桶名）再查，两种形态都能取到暂存字节。
import http from 'node:http';

const objects = new Map(); // path -> Buffer

http
  .createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const key = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (req.method === 'PUT') {
        const copySrc = req.headers['x-oss-copy-source']; // 服务端 copyObject：无正文，按源键复制字节
        if (copySrc) {
          const s = decodeURIComponent(new URL(String(copySrc), 'http://x').pathname);
          const b = objects.get(s) ?? objects.get(s.replace(/^\/[^/]+/, ''));
          if (!b) {
            res.writeHead(404);
            return res.end();
          }
          objects.set(key, b);
          res.writeHead(200);
          return res.end();
        }
        objects.set(key, Buffer.concat(chunks));
        res.writeHead(200);
        return res.end();
      }
      if (req.method === 'HEAD' || req.method === 'GET') {
        const buf = objects.get(key);
        if (!buf) {
          res.writeHead(404);
          return res.end();
        }
        res.writeHead(200, { 'content-length': String(buf.length) });
        return res.end(req.method === 'GET' ? buf : undefined);
      }
      res.writeHead(200);
      res.end();
    });
  })
  .listen(3199, () => console.log('[mock-oss] :3199'));
