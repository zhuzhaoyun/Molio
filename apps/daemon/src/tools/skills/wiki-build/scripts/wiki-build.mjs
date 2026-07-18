#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { scanVault } from './lib/inventory.mjs';
import { assertPathWithinVault, readJson, resolveBuildPaths, withMutationLock } from './lib/workspace.mjs';

export function parseArgs(argv) {
  const options = {
    command: undefined, json: false, vault: undefined, include: [], contentHash: false,
    maxDirEntries: undefined, maxTotal: undefined, sampleBytes: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') options.json = true;
    else if (argument === '--content-hash') options.contentHash = true;
    else if (argument === '--vault' || argument === '--include' || argument === '--max-dir-entries'
      || argument === '--max-total' || argument === '--sample-bytes') {
      const value = argv[index + 1];
      if (!value) throw new Error(`Missing value for ${argument}`);
      if (argument === '--include') options.include.push(value);
      else if (argument === '--max-dir-entries' || argument === '--max-total' || argument === '--sample-bytes') {
        const numericValue = Number(value);
        if (!Number.isInteger(numericValue) || numericValue < 1) throw new Error(`${argument} must be a positive integer`);
        options[argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = numericValue;
      } else options[argument.slice(2)] = value;
      index += 1;
    } else if (!argument.startsWith('--') && !options.command) options.command = argument;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.command) throw new Error('A command is required');
  if (!options.vault) throw new Error('--vault is required');
  return options;
}

function assertIncludesInsideVault(vault, includes) {
  for (const include of includes) assertPathWithinVault(vault, resolve(vault, include));
}

function status(paths) {
  if (existsSync(paths.state)) return readJson(paths.state);
  if (existsSync(paths.plan)) {
    readJson(paths.plan);
    return { phase: 'draft' };
  }
  if (existsSync(paths.inventory)) {
    readFileSync(paths.inventory, 'utf8');
    return { phase: 'scanned' };
  }
  return { phase: 'not_started' };
}

function emit(envelope, json) {
  process.stdout.write(json ? `${JSON.stringify(envelope)}\n` : `${JSON.stringify(envelope)}\n`);
}

function main() {
  let command;
  let json = false;
  try {
    const options = parseArgs(process.argv.slice(2));
    command = options.command;
    json = options.json;
    const vault = realpathSync(options.vault);
    const paths = resolveBuildPaths(vault);
    assertIncludesInsideVault(vault, options.include);
    if (command === 'status') {
      emit({ ok: true, command, data: status(paths) }, json);
      return;
    }
    if (command === 'scan') {
      const result = withMutationLock(paths, () => scanVault({
        vaultPath: vault,
        includePaths: options.include.length ? options.include : undefined,
        contentHash: options.contentHash,
        maxDirEntries: options.maxDirEntries,
        maxTotal: options.maxTotal,
        sampleBytes: options.sampleBytes,
      }));
      emit({ ok: true, command, data: result }, json);
      return;
    }
    const error = new Error(`Unknown command: ${command}`);
    error.code = 'UNKNOWN_COMMAND';
    throw error;
  } catch (error) {
    emit({
      ok: false,
      command: command ?? null,
      error: {
        code: error.code ?? 'INVALID_ARGUMENT',
        message: error.message,
      },
    }, json);
    process.exitCode = 2;
  }
}

main();
