import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { validateBinary } from '../../src/core/runtimes/launch.js';

function writeTmpBin(header: Buffer, size = 2 * 1024 * 1024): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-validate-'));
  const file = path.join(dir, 'bin');
  // Pad to requested size so MIN_BINARY_SIZE check passes.
  const padding = Buffer.alloc(Math.max(0, size - header.length), 0);
  fs.writeFileSync(file, Buffer.concat([header, padding]));
  return file;
}

describe('validateBinary — Mach-O byte order', () => {
  // Regression: macOS binaries are little-endian, so the on-disk header bytes
  // are reversed. A 64-bit Mach-O on Apple Silicon / Intel starts with
  // `CF FA ED FE`, which the old check rejected as "Invalid ELF/Mach-O header".
  it('accepts little-endian 64-bit Mach-O (CF FA ED FE) on non-Windows', () => {
    const file = writeTmpBin(Buffer.from([0xCF, 0xFA, 0xED, 0xFE]));
    assert.equal(validateBinary(file, 'darwin'), null);
  });

  it('accepts little-endian 32-bit Mach-O (CE FA ED FE) on non-Windows', () => {
    const file = writeTmpBin(Buffer.from([0xCE, 0xFA, 0xED, 0xFE]));
    assert.equal(validateBinary(file, 'darwin'), null);
  });

  it('accepts big-endian 64-bit Mach-O (FE ED FA CF) on non-Windows', () => {
    const file = writeTmpBin(Buffer.from([0xFE, 0xED, 0xFA, 0xCF]));
    assert.equal(validateBinary(file, 'darwin'), null);
  });

  it('accepts big-endian 32-bit Mach-O (FE ED FA CE) on non-Windows', () => {
    const file = writeTmpBin(Buffer.from([0xFE, 0xED, 0xFA, 0xCE]));
    assert.equal(validateBinary(file, 'darwin'), null);
  });

  it('accepts ELF header (7F 45 4C 46) on non-Windows', () => {
    const file = writeTmpBin(Buffer.from([0x7F, 0x45, 0x4C, 0x46]));
    assert.equal(validateBinary(file, 'linux'), null);
  });

  it('rejects garbage header on non-Windows', () => {
    const file = writeTmpBin(Buffer.from([0x00, 0x00, 0x00, 0x00]));
    const err = validateBinary(file, 'darwin');
    assert.ok(err, 'should return an error for garbage header');
    assert.match(err!, /Invalid ELF\/Mach-O header/);
  });
});

describe('validateBinary — Windows PE', () => {
  it('accepts PE header (MZ) on Windows', () => {
    const file = writeTmpBin(Buffer.from([0x4D, 0x5A]));
    assert.equal(validateBinary(file, 'win32'), null);
  });

  it('rejects non-PE header on Windows', () => {
    const file = writeTmpBin(Buffer.from([0xCF, 0xFA, 0xED, 0xFE]));
    const err = validateBinary(file, 'win32');
    assert.ok(err, 'should return an error for non-PE header on Windows');
    assert.match(err!, /Invalid PE header/);
  });
});

describe('validateBinary — size check', () => {
  it('rejects files smaller than 1 MB', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-validate-'));
    const file = path.join(dir, 'tiny');
    fs.writeFileSync(file, Buffer.from([0xCF, 0xFA, 0xED, 0xFE]));
    const err = validateBinary(file, 'darwin');
    assert.ok(err, 'should return an error for tiny file');
    assert.match(err!, /File too small/);
  });
});
