/**
 * Publish API routes — COSE extension check + bridge server.
 *
 * Flow:
 * 1. POST /check-cose — check if COSE Chrome extension is installed
 * 2. POST /start — start a local HTTP bridge server and return its URL
 *    The bridge page detects COSE's window.$cose and handles platform selection + publishing
 */

import { Hono } from 'hono';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { generateBridgePage } from '../publish-bridge/bridge-page.js';

const COSE_EXTENSION_ID = 'ilhikcdphhpjofhlnbojifbihhfmmhfk';

/** Bridge server cleanup timeout (30 minutes) */
const BRIDGE_TIMEOUT_MS = 30 * 60 * 1000;

/** Track active bridge servers for cleanup */
const activeBridges = new Map<string, { server: Server; timer: ReturnType<typeof setTimeout> }>();

/**
 * Find Chrome extension directory on Windows.
 * Checks the standard Chrome user data location.
 */
function findCoseExtensionDir(): string | null {
  const localAppData = process.env['LOCALAPPDATA'];
  if (!localAppData) return null;

  // Standard Chrome extension path on Windows
  const chromeExtDir = path.join(
    localAppData,
    'Google', 'Chrome', 'User Data', 'Default', 'Extensions',
    COSE_EXTENSION_ID,
  );

  if (fs.existsSync(chromeExtDir)) {
    return chromeExtDir;
  }

  // Also check Chrome profiles (Profile 1, Profile 2, etc.)
  const userDataDir = path.join(localAppData, 'Google', 'Chrome', 'User Data');
  if (fs.existsSync(userDataDir)) {
    try {
      const profiles = fs.readdirSync(userDataDir);
      for (const profile of profiles) {
        if (profile.startsWith('Profile')) {
          const profileExtDir = path.join(userDataDir, profile, 'Extensions', COSE_EXTENSION_ID);
          if (fs.existsSync(profileExtDir)) {
            return profileExtDir;
          }
        }
      }
    } catch {
      // Ignore read errors
    }
  }

  return null;
}

/**
 * Find an available port for the bridge server.
 */
function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Failed to get port')));
      }
    });
    server.on('error', reject);
  });
}

/**
 * Start a bridge HTTP server that serves the publish page.
 */
async function startBridgeServer(data: { title: string; markdown: string; html: string; css: string }): Promise<string> {
  const bridgeHtml = generateBridgePage(data);
  const port = await getAvailablePort();

  const server = createServer((req, res) => {
    // Serve the bridge page for any GET request
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.end(bridgeHtml);
  });

  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => {
      const bridgeUrl = `http://localhost:${port}`;

      // Auto-cleanup after timeout
      const timer = setTimeout(() => {
        cleanupBridge(bridgeUrl);
      }, BRIDGE_TIMEOUT_MS);

      activeBridges.set(bridgeUrl, { server, timer });

      resolve(bridgeUrl);
    });

    server.on('error', reject);
  });
}

/**
 * Clean up a bridge server.
 */
function cleanupBridge(url: string): void {
  const bridge = activeBridges.get(url);
  if (!bridge) return;

  clearTimeout(bridge.timer);
  bridge.server.close();
  activeBridges.delete(url);
}

/**
 * Clean up all bridge servers (called on daemon shutdown).
 */
export function cleanupAllBridges(): void {
  for (const [url] of activeBridges) {
    cleanupBridge(url);
  }
}

// ─── Route factory ───

export function publishRoutes(): Hono {
  const app = new Hono();

  // POST /check-cose — check if COSE extension is installed
  app.post('/check-cose', (c) => {
    const extDir = findCoseExtensionDir();
    return c.json({ installed: extDir !== null });
  });

  // POST /start — start bridge server and return URL
  app.post('/start', async (c) => {
    try {
      const body = await c.req.json<{
        title: string;
        markdown: string;
        html: string;
        css: string;
      }>();

      if (!body.html && !body.markdown) {
        return c.json({ error: { code: 'INVALID_REQUEST', message: 'Missing article content' } }, 400);
      }

      const bridgeUrl = await startBridgeServer({
        title: body.title || '',
        markdown: body.markdown || '',
        html: body.html || '',
        css: body.css || '',
      });

      return c.json({ bridgeUrl });
    } catch (err) {
      return c.json({
        error: {
          code: 'BRIDGE_START_FAILED',
          message: err instanceof Error ? err.message : 'Failed to start bridge server',
        },
      }, 500);
    }
  });

  // DELETE /bridge — clean up a bridge server
  app.delete('/bridge', async (c) => {
    const url = c.req.query('url');
    if (url) {
      cleanupBridge(url);
    }
    return c.json({ ok: true });
  });

  return app;
}
