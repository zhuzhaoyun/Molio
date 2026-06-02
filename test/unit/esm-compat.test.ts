import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * ESM compatibility test: ensure no __dirname or __filename usage in source.
 * These are CommonJS globals that don't exist in ESM mode ("type": "module").
 * Use import.meta.dirname (Node 20.11+) or fileURLToPath(import.meta.url) instead.
 */
describe('ESM compatibility', () => {
  const srcDir = path.join(import.meta.dirname, '..', 'src');
  const CJS_PATTERNS = [
    /(?<!\/\/.*)\b__dirname\b/g,
    /(?<!\/\/.*)\b__filename\b/g,
  ];

  function walk(dir: string): string[] {
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules') {
        results.push(...walk(full));
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        results.push(full);
      }
    }
    return results;
  }

  it('should not use __dirname in source files', () => {
    const files = walk(srcDir);
    const violations: string[] = [];

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      for (const pattern of CJS_PATTERNS) {
        const matches = content.match(pattern);
        if (matches) {
          violations.push(`${path.relative(srcDir, file)}: found ${matches.length} CJS global(s)`);
        }
      }
    }

    assert.deepEqual(violations, [],
      `CJS globals found in ESM source. Use import.meta.dirname instead.\n${violations.join('\n')}`);
  });
});
