'use strict';
/**
 * Entity census — one regex pass per profile pattern over the normalized
 * text, counting surface forms. Replaces the old per-candidate
 * `grep -oF 名字 | wc -l` loop (O(candidates × filesize) process spawns) with
 * O(patterns × filesize) in-process scanning — thousands of candidates cost
 * the same as a handful.
 *
 * Output is a candidate list, not a verdict: the agent curates it against the
 * SKILL's 建页粒度 rules. `excludeTerms` only strips the loudest generic-word
 * false positives (方法/方向/高度/任务/黄金…); long-tail noise is the agent's
 * call, and new excludes can be added to the profile.
 */

/** Surface forms worth counting: 2–8 chars, CJK/letters, at least one CJK. */
function validSurface(surface) {
  if (surface.length < 2 || surface.length > 8) return false;
  if (!/^[一-龥A-Za-z·]+$/.test(surface)) return false;
  return /[一-龥]/.test(surface);
}

/**
 * @param {string} text normalized full text (joined with \n)
 * @param {object} profile with `entityPatterns: [{name, regex}]` (capture group 1 = surface)
 * @param {number} topN keep the N most frequent surfaces
 * @returns {{ rows: Array<{surface:string,count:number,cats:string[]}>, excluded: number,
 *            aliasHints: Array<{a:string,b:string,context:string}> }}
 */
function runCensus(text, profile, topN) {
  // Alias hints first — the collapse pass uses them as a merge signal
  // (a 3-char fragment whose 2-char prefix is a known alias participant is
  // almost certainly that entity + a trailing body char).
  const aliasHints = scanAliasHints(text, profile.aliasPairRegexes, 200);
  const aliasNames = new Set();
  for (const h of aliasHints) {
    aliasNames.add(h.a);
    aliasNames.add(h.b);
  }

  const counts = new Map();

  for (const ep of profile.entityPatterns || []) {
    let re;
    try {
      re = new RegExp(ep.regex, 'g');
    } catch {
      continue; // broken profile regex — skip rather than crash the run
    }
    let m;
    while ((m = re.exec(text)) !== null) {
      const surface = (m[1] ?? m[0]).trim();
      if (!validSurface(surface)) continue;
      const e = counts.get(surface) || { count: 0, cats: new Set() };
      e.count++;
      e.cats.add(ep.name);
      counts.set(surface, e);
      if (m.index === re.lastIndex) re.lastIndex++; // zero-match guard
    }
  }

  collapseFragments(counts, aliasNames);

  const exclude = new Set(profile.excludeTerms || []);
  let excluded = 0;
  const rows = [];
  for (const [surface, e] of counts) {
    if (exclude.has(surface)) { excluded++; continue; }
    rows.push({ surface, count: e.count, cats: [...e.cats] });
  }
  rows.sort((a, b) => b.count - a.count || a.surface.localeCompare(b.surface, 'zh'));
  return { rows: rows.slice(0, topN), excluded, aliasHints };
}

/**
 * Repair greedy-capture fragmentation of 2-char names.
 *
 * The surname pattern captures 姓+1~2 chars; when the real name is 2 chars
 * (林凡), the trailing body char leaks in and shards the frequency across
 * 林凡心/林凡站/林凡看…. Two deterministic signals reverse it:
 *
 *   1. sibling collapse: ≥2 three-char surfaces sharing a 2-char prefix,
 *      with the runner-up at ≥10% of the leader → the trailing char varies,
 *      so the real name is the prefix. Merge counts into the prefix.
 *   2. prefix dominance: a 3-char surface whose exact 2-char prefix already
 *      exists with ≥25% of its count → the 3-char form is the fragment.
 *   3. alias anchor: the prefix participates in an alias pair (e.g. 唐三 ↔
 *      唐三千) → the prefix is a confirmed entity, absorb the fragment
 *      (唐三站 → 唐三) even when the fragment outnumbers the prefix.
 *
 * Single 3-char forms with no prefix (赵无极) are left untouched — that is
 * the signature of a genuine 3-char name.
 */
function collapseFragments(counts, aliasNames = new Set()) {
  // Group 3-char surfaces by their 2-char prefix.
  const groups = new Map();
  for (const [surface] of counts) {
    if (surface.length !== 3) continue;
    const prefix = surface.slice(0, 2);
    const g = groups.get(prefix) || [];
    g.push(surface);
    groups.set(prefix, g);
  }

  for (const [prefix, members] of groups) {
    if (members.length < 2 && !counts.has(prefix)) continue;

    const sorted = members
      .map((s) => ({ s, count: counts.get(s).count }))
      .sort((a, b) => b.count - a.count);

    const leader = sorted[0];
    const runner = sorted[1];
    const sibSignal = members.length >= 2 && runner && runner.count >= leader.count * 0.1;
    const prefixEntry = counts.get(prefix);
    const domSignal = prefixEntry && prefixEntry.count >= leader.count * 0.25;
    const aliasSignal = prefixEntry && aliasNames.has(prefix);
    if (!sibSignal && !domSignal && !aliasSignal) continue;

    // Merge all members into the prefix.
    const target = prefixEntry || { count: 0, cats: new Set() };
    for (const { s, count } of sorted) {
      const e = counts.get(s);
      target.count += count;
      for (const c of e.cats) target.cats.add(c);
      counts.delete(s);
    }
    target.cats.add('collapsed');
    counts.set(prefix, target);
  }
}

/**
 * Scan for alias pairs (X 又名/外号/字/号 Y). Cheap paired-pattern scan only —
 * keyword-dumping whole lines is too noisy; the agent's semantic sampling
 * catches the rest.
 *
 * @param {string} text
 * @param {string[]} pairRegexes each with two capture groups (a, b)
 * @param {number} cap max hints returned
 * @returns {Array<{a:string,b:string,context:string}>}
 */
function scanAliasHints(text, pairRegexes, cap = 200) {
  const hints = [];
  const seen = new Set(); // dedup by (a, b) — keep the first context
  for (const src of pairRegexes || []) {
    let re;
    try {
      re = new RegExp(src, 'g');
    } catch {
      continue;
    }
    let m;
    while ((m = re.exec(text)) !== null && hints.length < cap) {
      // Greedy {2,8} can swallow leading clause fragments ("人称三哥的唐三" before
      // 又名): keep only the name span after the last 的.
      const a = (m[1] || '').trim().split('的').pop();
      const b = (m[2] || '').trim().split('的').pop();
      if (!a || !b || a === b) continue;
      if (!validSurface(a) || !validSurface(b)) continue;
      const key = `${a}|${b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const ctxStart = Math.max(0, m.index - 12);
      hints.push({
        a,
        b,
        context: text.slice(ctxStart, m.index + m[0].length + 12).replace(/\n/g, ' '),
      });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  return hints;
}

export { runCensus, scanAliasHints, validSurface };
