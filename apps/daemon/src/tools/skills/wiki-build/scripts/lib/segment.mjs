'use strict';
/**
 * Segmentation: split normalized lines into structural segments (chapters /
 * headings / volumes) using the profile's line-anchored patterns, then group
 * segments into processing ranges (~rangeChars each) that become the L1
 * subagent batches and the progress checklist rows.
 *
 * Everything here is deterministic and profile-driven — no domain knowledge
 * lives in this module; the patterns come from profiles/*.json.
 */

/**
 * Find structural segments in normalized lines.
 *
 * A trimmed line matching any `segmentPatterns[].regex` opens a new segment,
 * except when the current segment is still below `minSegmentChars` — then the
 * marker line is treated as body text (filters fake markers inside prose,
 * e.g. a sentence that merely mentions 第三章).
 *
 * @param {string[]} lines normalized lines
 * @param {object} profile
 * @returns {{ segments: Array<{i:number,title:string,startLine:number,endLine:number,chars:number}>, segmented: boolean }}
 *   Line numbers are 1-based into the transcode file. `segmented` is false when
 *   fewer than 2 segments were found (caller falls back to fixed chunks).
 */
function segmentLines(lines, profile) {
  const patterns = (profile.segmentPatterns || []).map((p) => ({
    name: p.name,
    re: new RegExp(p.regex),
  }));
  const minChars = profile.minSegmentChars ?? 0;

  const segments = [];
  let cur = null;

  const close = () => {
    if (cur && cur.chars > 0) segments.push(cur);
    cur = null;
  };
  const open = (title, lineNo) => {
    cur = { i: segments.length + 1, title, startLine: lineNo, endLine: lineNo, chars: 0 };
  };
  const feed = (line, lineNo) => {
    if (!cur) return;
    cur.chars += line.length;
    cur.endLine = lineNo;
  };

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    const trimmed = line.trim();
    let hit = null;
    if (trimmed) {
      for (const p of patterns) {
        if (p.re.test(trimmed)) { hit = p; break; }
      }
    }

    if (hit) {
      const title = trimmed.slice(0, 40);
      if (cur && cur.chars >= minChars) {
        close();
        open(title, lineNo);
      } else if (!cur) {
        open(title, lineNo);
      }
      // Marker under minChars with an open small segment → body text.
    }
    feed(line, lineNo);
  });
  close();

  return { segments, segmented: segments.length >= 2 };
}

/**
 * Fallback when no structural segments are found: fixed-size chunks split at
 * line boundaries.
 *
 * @param {string[]} lines
 * @param {number} chunkChars target chars per chunk
 */
function fixedChunks(lines, chunkChars) {
  const segments = [];
  let cur = null;
  const total = Math.max(1, Math.ceil(lines.reduce((n, l) => n + l.length, 0) / chunkChars));

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    if (!cur || (cur.chars >= chunkChars && line.trim() !== '')) {
      if (cur) segments.push(cur);
      cur = {
        i: segments.length + 1,
        title: `分段 ${segments.length + 1}/${total}`,
        startLine: lineNo,
        endLine: lineNo,
        chars: 0,
      };
    }
    cur.chars += line.length;
    cur.endLine = lineNo;
  });
  if (cur && cur.chars > 0) segments.push(cur);
  return segments;
}

/**
 * Group segments into processing ranges of roughly `rangeChars` each.
 * A single segment larger than rangeChars becomes its own range (ranges never
 * split a segment — subagents get coherent structural units).
 *
 * @returns {Array<{i:number,label:string,startLine:number,endLine:number,chars:number,segs:number[]}>}
 */
function groupRanges(segments, rangeChars) {
  const ranges = [];
  let acc = null;

  const close = () => {
    if (!acc) return;
    const first = segments[acc.idxs[0]];
    const last = segments[acc.idxs[acc.idxs.length - 1]];
    acc.label = first === last ? first.title : `${first.title} ~ ${last.title}`;
    delete acc.idxs;
    ranges.push(acc);
    acc = null;
  };

  segments.forEach((seg, idx) => {
    if (!acc) {
      acc = { i: ranges.length + 1, label: '', startLine: seg.startLine, endLine: seg.endLine, chars: 0, segs: [], idxs: [] };
    }
    acc.segs.push(seg.i);
    acc.idxs.push(idx);
    acc.chars += seg.chars;
    acc.endLine = seg.endLine;
    if (acc.chars >= rangeChars) close();
  });
  close();
  return ranges;
}

export { segmentLines, fixedChunks, groupRanges };
