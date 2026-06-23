#!/usr/bin/env node
/**
 * Scan src/ directories and compare against area-map to find uncovered areas.
 *
 * Usage:
 *   node check-coverage.mjs [--out <file>]
 *
 * Output: JSON report of source directories not matched by any area path.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..', '..', '..');
const AREA_MAP_PATH = resolve(__dirname, '..', 'area-map.json');

function walkDir(dir, extensions, acc = []) {
  if (!statSync(dir).isDirectory()) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(full, extensions, acc);
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      acc.push(relative(ROOT, full).replace(/\\/g, '/'));
    }
  }
  return acc;
}

function globMatch(pattern, path) {
  let re = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  re = re.replace(/\{([^}]+)\}/g, (_, g) => `(${g.split(',').join('|')})`);
  re = re.replace(/\*\*/g, ' ');
  re = re.replace(/\*/g, '[^/]*');
  re = re.replace(/ /g, '.*');
  return new RegExp(`^${re}$`).test(path);
}

const areaMap = JSON.parse(readFileSync(AREA_MAP_PATH, 'utf8'));

// Collect all source files
const sourceFiles = [
  ...walkDir(join(ROOT, 'apps', 'web', 'src'), ['.ts', '.tsx']),
  ...walkDir(join(ROOT, 'apps', 'daemon', 'src'), ['.ts']),
];

// Collect all patterns from area-map
const allPatterns = [];
for (const area of Object.values(areaMap.areas)) {
  allPatterns.push(...area.paths);
}

// Find files not matched by any area
const uncovered = [];
for (const file of sourceFiles) {
  const matched = allPatterns.some((pattern) => globMatch(pattern, file));
  if (!matched) {
    uncovered.push(file);
  }
}

const report = {
  total_source_files: sourceFiles.length,
  uncovered_files: uncovered.length,
  coverage_pct: sourceFiles.length === 0
    ? 0
    : (((sourceFiles.length - uncovered.length) / sourceFiles.length) * 100).toFixed(1),
  uncovered_sample: uncovered.slice(0, 30),
};

const output = JSON.stringify(report, null, 2);
if (process.argv.includes('--out')) {
  const idx = process.argv.indexOf('--out');
  writeFileSync(process.argv[idx + 1], output);
} else {
  process.stdout.write(output + '\n');
}
process.stderr.write(`[check-coverage] ${report.coverage_pct}% covered (${report.uncovered_files}/${report.total_source_files} uncovered)\n`);
