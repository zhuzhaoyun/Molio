import type { SkillQuarantineEvent } from '@molio/contracts';

/**
 * Split unacked quarantine events for the settings banner (2026-11-19 cold-start
 * ruling): `vault-cold-start` events can fire for EVERY skill on the first sync
 * after an upgrade, so they render as ONE aggregated entry (count + backup path
 * hint), never one row each. Every other source (drift / hub / retired /
 * orphan-sweep) is a specific, user-actionable occurrence → individual rows.
 */
export function groupQuarantineEvents(events: SkillQuarantineEvent[]): {
  coldStart: SkillQuarantineEvent[];
  individual: SkillQuarantineEvent[];
} {
  const coldStart: SkillQuarantineEvent[] = [];
  const individual: SkillQuarantineEvent[] = [];
  for (const ev of events) {
    if (ev.source === 'vault-cold-start') coldStart.push(ev);
    else individual.push(ev);
  }
  return { coldStart, individual };
}
