#!/usr/bin/env node
/**
 * Analyze diff for changed symbols and find their usage across the codebase.
 *
 * Usage:
 *   node codegraph-impact.mjs --diff <file> --out <file>
 *
 * Output JSON:
 *   {
 *     "changed_symbols": [
 *       { "name": "RunManager", "kind": "class", "file": "apps/daemon/src/core/RunManager.ts", "callers": 12 }
 *     ],
 *     "changed_files": ["apps/daemon/src/core/RunManager.ts"],
 *     "summary": "5 symbols changed, 12 call sites across codebase"
 *   }
 *
 * Approach: regex-based symbol extraction + grep for usage. No external deps.
 * This is a lightweight alternative to a full AST-based codegraph — good enough
 * for PR impact analysis where we just need to flag high-ripple changes.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

function parseArgs(argv) {
  const args = { diff: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--diff' && argv[i + 1]) args.diff = argv[++i];
    else if (argv[i] === '--out' && argv[i + 1]) args.out = argv[++i];
  }
  return args;
}

/** Extract changed symbols (functions, classes, exported consts) from a unified diff. */
function extractChangedSymbols(diffContent) {
  const symbols = new Map(); // name → { kind, file, lines }
  const currentFile = { path: null };

  const lines = diffContent.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track current file
    const plusMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (plusMatch) {
      currentFile.path = plusMatch[1];
      continue;
    }

    // Only look at added/removed lines (the actual changes)
    if (!line.startsWith('+') && !line.startsWith('-')) continue;
    if (line.startsWith('+++') || line.startsWith('---')) continue;

    const content = line.slice(1).trim();

    // Match common symbol declarations
    // export function foo / async function foo / function foo
    const funcMatch = content.match(
      /(?:export\s+(?:default\s+|async\s+)?)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
    );
    if (funcMatch) {
      addSymbol(symbols, funcMatch[1], 'function', currentFile.path);
      continue;
    }

    // export class Foo / class Foo
    const classMatch = content.match(
      /(?:export\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
    );
    if (classMatch) {
      addSymbol(symbols, classMatch[1], 'class', currentFile.path);
      continue;
    }

    // export const Foo = / const Foo =
    const constMatch = content.match(
      /(?:export\s+)?(?:const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/,
    );
    if (constMatch) {
      // Skip trivial locals (lowercase first letter + short = likely local var)
      const name = constMatch[1];
      if (name.length >= 3 && /^[A-Z]/.test(name)) {
        addSymbol(symbols, name, 'const', currentFile.path);
      }
      continue;
    }

    // Method definitions: foo() { or async foo() {
    const methodMatch = content.match(
      /^\s*(?:async\s+|static\s+|public\s+|private\s+|protected\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/,
    );
    if (methodMatch) {
      const name = methodMatch[1];
      // Skip keywords and trivial names
      if (!['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'class', 'new', 'test', 'describe', 'it'].includes(name) && name.length >= 3 && /^[a-z]/.test(name)) {
        addSymbol(symbols, name, 'method', currentFile.path);
      }
    }
  }

  return [...symbols.values()];
}

function addSymbol(map, name, kind, file) {
  if (!map.has(name)) {
    map.set(name, { name, kind, file, callers: 0 });
  }
}

/** Count occurrences of `symbolName` across TS/JS files (excluding the changed file itself). */
function countCallers(symbolName, changedFile) {
  try {
    // Use git grep for speed; fall back to ripgrep
    const cmd = `git grep -l "\\b${escapeRegex(symbolName)}\\b" -- '*.ts' '*.tsx' '*.js' '*.mjs' 2>/dev/null || true`;
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    const files = out.split('\n').filter(Boolean);
    // Exclude the changed file itself + test files for the symbol
    const callerFiles = files.filter((f) => f !== changedFile && !f.includes('/test/') && !f.includes('/e2e/'));
    return callerFiles.length;
  } catch {
    return 0;
  }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Extract changed file paths from diff. */
function extractChangedFiles(diffContent) {
  const files = new Set();
  for (const line of diffContent.split('\n')) {
    const m = line.match(/^\+\+\+ b\/(.+)$/);
    if (m) files.add(m[1]);
  }
  return [...files];
}

const args = parseArgs(process.argv.slice(2));
if (!args.diff) {
  process.stderr.write('Usage: codegraph-impact.mjs --diff <file> --out <file>\n');
  process.exit(1);
}

const diffContent = readFileSync(args.diff, 'utf8');
const changedFiles = extractChangedFiles(diffContent);
const symbols = extractChangedSymbols(diffContent);

// Cap at 20 symbols to bound LLM prompt size
const cappedSymbols = symbols.slice(0, 20);
for (const sym of cappedSymbols) {
  sym.callers = countCallers(sym.name, sym.file);
}

// Sort by caller count descending
cappedSymbols.sort((a, b) => b.callers - a.callers);

const result = {
  changed_files: changedFiles,
  changed_symbols: cappedSymbols,
  summary: `${cappedSymbols.length} symbols changed, ${cappedSymbols.reduce((s, x) => s + x.callers, 0)} caller files across codebase`,
};

const output = JSON.stringify(result, null, 2);
if (args.out) {
  writeFileSync(args.out, output);
} else {
  process.stdout.write(output + '\n');
}
process.stderr.write(`[codegraph-impact] ${result.summary}\n`);
