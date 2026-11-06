import { join, extname } from 'node:path';
import { existsSync, statSync, readFileSync } from 'node:fs';
import type { MiddlewareHandler } from 'hono';

/**
 * Production/desktop static file serving for the built web dist.
 *
 * Extracted from server.ts so the header semantics are unit-testable
 * (test/routes/static-files.test.ts drives this factory directly via app.request).
 *
 * Cache policy (2026-10-26 stale-chunk incident): the packaged web dist is
 * replaced wholesale on every app update, so a cached index.html would keep
 * referencing old hashed chunks that no longer exist on disk — the renderer
 * then dies on "Failed to fetch dynamically imported module". index.html is
 * therefore always served with `Cache-Control: no-cache` (revalidate each
 * load); hashed assets stay as-is.
 */

// MIME type mapping
const mimeTypes: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.webp': 'image/webp',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain',
  '.xml': 'text/xml',
  '.pdf': 'application/pdf',
};

export function createStaticFileMiddleware(staticDir: string): MiddlewareHandler {
  return async (c, next) => {
    const url = new URL(c.req.url);
    let pathname = decodeURIComponent(url.pathname);

    // Security: prevent directory traversal
    if (pathname.includes('..')) {
      return c.notFound();
    }

    // Default to index.html for root
    if (pathname === '/') {
      pathname = '/index.html';
    }

    const filePath = join(staticDir, pathname);

    // Check if file exists
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      const ext = extname(filePath).toLowerCase();
      const mimeType = mimeTypes[ext] || 'application/octet-stream';
      const content = readFileSync(filePath);
      const headers: Record<string, string> = { 'Content-Type': mimeType };
      if (pathname === '/index.html') headers['Cache-Control'] = 'no-cache';
      return c.body(content, 200, headers);
    }

    // SPA fallback: serve index.html for non-API, non-asset routes
    if (!pathname.startsWith('/api/') && !extname(pathname)) {
      const indexPath = join(staticDir, 'index.html');
      if (existsSync(indexPath)) {
        const content = readFileSync(indexPath);
        return c.body(content, 200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
      }
    }

    await next();
  };
}
