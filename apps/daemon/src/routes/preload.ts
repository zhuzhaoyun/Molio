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
import { getPreloadLocations, skillsNeedingStart } from '../core/preload-manager.js';

export function preloadRoutes(preloadManager: PreloadManager): Hono {
  const app = new Hono();

  // GET /api/preload/status — each skill's status PLUS its real on-disk
  // location (venv vs global vs conda vs …), so the UI/docs can show where a
  // tool actually lives instead of assuming the venv path. This is what makes
  // "兼容旧地址" visible: a global/legacy install reports its true path.
  app.get('/status', (c) => {
    const statuses = preloadManager.getStatuses();
    const loc = getPreloadLocations();
    const enriched: Record<string, unknown> = {};
    for (const [sk, st] of Object.entries(statuses)) {
      enriched[sk] = { ...st, path: sk === 'docling' ? loc.docling : loc.remotion };
    }
    return c.json({ statuses: enriched });
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

    // Partition skills into "already done" vs "needs (re)preloading". 'missing'
    // (fresh), 'paused' (resume) AND 'failed' (retry) all need startPreload —
    // pip / HuggingFace / npm reuse their caches so a paused/failed preload
    // picks up where it left off. Including 'failed' is what makes the error
    // toast's 重试 button actually re-run the download (the 2026-07 retry no-op
    // bug: 'failed' used to fall through to alreadyDone → a fake "already
    // installed" completion → the toast vanished without re-downloading).
    const { needsStart, alreadyDone } = skillsNeedingStart(
      (sk) => preloadManager.getStatus(sk),
      skills,
    );

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

            // Close the stream when all started skills reach a terminal
            // state. paused/stopped count as terminal (the user ended this
            // run) so the client can react and stop awaiting.
            if (event.status === 'completed' || event.status === 'failed'
                || event.status === 'paused' || event.status === 'stopped') {
              const statuses = preloadManager.getStatuses();
              const allDone = needsStart.every((sk) => {
                const s = statuses[sk];
                return s.status === 'downloaded' || s.status === 'failed'
                  || s.status === 'paused' || s.status === 'missing';
              });
              if (allDone && !closed) {
                closed = true;
                try { controller.close(); } catch { /* already closed */ }
              }
            }
          });
        });

        // 4. Start preloading each missing/paused skill (fire-and-forget —
        //    progress events are delivered through the listener above).
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

  // POST /api/preload/pause
  // Abort in-progress preloads but KEEP partial artifacts (venv, downloaded
  // packages, .incomplete models) so resume picks up where it left off.
  // The abort surfaces to the client as a `paused` event on any open stream.
  app.post('/pause', async (c) => {
    const body = await c.req.json<{ skills: string[] }>();
    const skills = body.skills as PreloadableSkill[];

    if (!Array.isArray(skills)) {
      return c.json({ error: 'skills array required' }, 400);
    }

    for (const sk of skills) {
      preloadManager.pausePreload(sk);
    }

    return c.json({ ok: true });
  });

  // POST /api/preload/stop
  // Abort in-progress preloads AND delete partial artifacts so the skill
  // returns to a clean `missing` state. Works on running OR paused skills.
  app.post('/stop', async (c) => {
    const body = await c.req.json<{ skills: string[] }>();
    const skills = body.skills as PreloadableSkill[];

    if (!Array.isArray(skills)) {
      return c.json({ error: 'skills array required' }, 400);
    }

    for (const sk of skills) {
      preloadManager.stopPreload(sk);
    }

    return c.json({ ok: true });
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
