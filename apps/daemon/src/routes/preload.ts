/**
 * Preload API routes — status check, start download, dismiss.
 *
 * GET  /api/preload/status   → current skill statuses
 * POST /api/preload/start    → starts background preload, returns SSE stream
 * POST /api/preload/dismiss  → mark a skill as dismissed
 * POST /api/preload/undismiss → re-enable prompting for a dismissed skill
 */

import { Hono } from 'hono';
import type { PreloadManager, PreloadableSkill, PreloadProgressEvent } from '../core/preload-manager.js';

export function preloadRoutes(preloadManager: PreloadManager): Hono {
  const app = new Hono();

  // GET /api/preload/status
  app.get('/status', (c) => {
    const statuses = preloadManager.getStatuses();
    return c.json({ statuses });
  });

  // POST /api/preload/start
  // Returns a ReadableStream of SSE progress events (same pattern as agent install).
  app.post('/start', async (c) => {
    const body = await c.req.json<{ skills: string[] }>();
    const skills = body.skills as PreloadableSkill[];

    if (!Array.isArray(skills) || skills.length === 0) {
      return c.json({ error: 'skills array required' }, 400);
    }

    // Validate all skills
    const validSkills: PreloadableSkill[] = ['docling', 'remotion'];
    for (const sk of skills) {
      if (!validSkills.includes(sk as PreloadableSkill)) {
        return c.json({ error: `Unknown skill: ${sk}` }, 400);
      }
    }

    // Partition skills into "already done" vs "needs preloading"
    const needsStart: PreloadableSkill[] = [];
    const alreadyDone: PreloadableSkill[] = [];

    for (const sk of skills) {
      const s = preloadManager.getStatus(sk);
      if (s.status === 'missing') {
        needsStart.push(sk);
      } else {
        alreadyDone.push(sk);
      }
    }

    // Create a stream that fires progress events for ACTIVE preloads only
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        let closed = false;

        // 1. Emit immediate "done" for already-installed/downloaded skills
        for (const sk of alreadyDone) {
          const frame = `data: ${JSON.stringify({ skill: sk, status: 'completed', progress: 100, message: 'already installed' })}\n\n`;
          try { controller.enqueue(encoder.encode(frame)); } catch { /* */ }
        }

        // 2. If nothing to start, close immediately
        if (needsStart.length === 0) {
          closed = true;
          try { controller.close(); } catch { /* */ }
          return;
        }

        // 3. Subscribe to progress events for skills being started
        const unsubs = needsStart.map((skill) => {
          return preloadManager.onProgress((event: PreloadProgressEvent) => {
            if (closed) return;
            if (event.skill !== skill) return;

            const frame = `data: ${JSON.stringify(event)}\n\n`;
            try {
              controller.enqueue(encoder.encode(frame));
            } catch {
              closed = true;
              return;
            }

            // Close the stream when all started skills are done
            if (event.status === 'completed' || event.status === 'failed') {
              const statuses = preloadManager.getStatuses();
              const allDone = needsStart.every((sk) => {
                const s = statuses[sk];
                return s.status === 'downloaded' || s.status === 'failed';
              });
              if (allDone && !closed) {
                closed = true;
                try { controller.close(); } catch { /* already closed */ }
              }
            }
          });
        });

        // 4. Start preloading each missing skill (fire-and-forget — progress
        //    events are delivered through the listener above).
        for (const skill of needsStart) {
          preloadManager.startPreload(skill).catch(() => {});
        }
      },
    });

    return c.newResponse(stream, 200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
  });

  // POST /api/preload/dismiss
  app.post('/dismiss', async (c) => {
    const body = await c.req.json<{ skills: string[] }>();
    const skills = body.skills as PreloadableSkill[];

    if (!Array.isArray(skills)) {
      return c.json({ error: 'skills array required' }, 400);
    }

    for (const sk of skills) {
      preloadManager.dismissSkill(sk);
    }

    return c.json({ ok: true });
  });

  // POST /api/preload/undismiss
  app.post('/undismiss', async (c) => {
    const body = await c.req.json<{ skills: string[] }>();
    const skills = body.skills as PreloadableSkill[];

    if (!Array.isArray(skills)) {
      return c.json({ error: 'skills array required' }, 400);
    }

    for (const sk of skills) {
      preloadManager.undismissSkill(sk);
    }

    return c.json({ ok: true });
  });

  return app;
}
