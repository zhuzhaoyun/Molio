/**
 * Media proxy routes — bypasses Referer-based anti-hotlinking.
 *
 * Handles images (mmbiz.qpic.cn) and videos (mpvideo.qpic.cn) that
 * require no Referer header, which Node.js fetch() provides by default.
 */
import { Hono } from 'hono';

export function proxyRoutes(): Hono {
  const app = new Hono();

  app.get('/image', async (c) => {
    const imageUrl = c.req.query('url');
    if (!imageUrl) return c.json({ error: 'Missing url param' }, 400);

    let parsed: URL;
    try { parsed = new URL(imageUrl); } catch {
      return c.json({ error: 'Invalid URL' }, 400);
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return c.json({ error: 'Invalid protocol' }, 400);
    }

    try {
      const resp = await fetch(imageUrl, {
        headers: { 'User-Agent': 'Molio/1.0' },
      });
      if (!resp.ok) { c.status(resp.status as 200); return c.body(null); }

      const contentType = resp.headers.get('content-type') || 'application/octet-stream';
      const buffer = Buffer.from(await resp.arrayBuffer());

      return c.body(buffer, 200, {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400',
      });
    } catch {
      c.status(502); return c.body(null);
    }
  });

  return app;
}
