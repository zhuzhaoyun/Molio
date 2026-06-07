#!/usr/bin/env node
/**
 * Cross-platform packaging script.
 * Detects the current OS and runs the appropriate electron-builder command.
 *
 * Usage: pnpm package
 * Or specify a platform: pnpm package:win | pnpm package:mac | pnpm package:linux
 */

import { execSync } from 'node:child_process';

const platform = process.platform;

let target;
switch (platform) {
  case 'win32':
    target = '--win';
    console.log('🪟 Packaging for Windows...');
    break;
  case 'darwin':
    target = '--mac';
    console.log('🍎 Packaging for macOS...');
    break;
  case 'linux':
    target = '--linux';
    console.log('🐧 Packaging for Linux...');
    break;
  default:
    console.error(`❌ Unsupported platform: ${platform}`);
    process.exit(1);
}

try {
  execSync(`electron-builder ${target}`, {
    stdio: 'inherit',
    cwd: process.cwd(),
  });
  console.log('✅ Packaging complete!');
} catch (err) {
  console.error('❌ Packaging failed:', err.message);
  process.exit(1);
}
