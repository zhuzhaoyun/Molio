#!/usr/bin/env node
import readline from 'node:readline';

if (!process.stdin.isTTY || !process.stderr.isTTY) {
  process.stderr.write('需要在交互式终端中运行，不能通过参数或管道传入密码。\n');
  process.exit(1);
}

let hashPassword;
try {
  ({ hashPassword } = await import('../apps/daemon/dist/src/core/access/password.js'));
} catch {
  process.stderr.write('请先运行 pnpm --filter @molio/contracts build:fresh 和 pnpm --filter @molio/daemon build。\n');
  process.exit(1);
}

readline.emitKeypressEvents(process.stdin);
const previousRaw = process.stdin.isRaw;

function readSecret(prompt) {
  return new Promise((resolve, reject) => {
    let value = '';
    process.stderr.write(prompt);
    const onKey = (character, key) => {
      if (key?.ctrl && (key.name === 'c' || key.name === 'd')) {
        process.stdin.off('keypress', onKey);
        reject(new Error('输入已取消'));
      } else if (key?.name === 'return' || key?.name === 'enter') {
        process.stdin.off('keypress', onKey);
        process.stderr.write('\n');
        resolve(value);
      } else if (key?.name === 'backspace') {
        value = Array.from(value).slice(0, -1).join('');
      } else if (character && !key?.ctrl && !key?.meta && !/[\x00-\x1f\x7f]/.test(character)) {
        value += character;
      }
    };
    process.stdin.on('keypress', onKey);
  });
}

try {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  const password = await readSecret('管理员密码（至少 12 个字符）：');
  const confirmation = await readSecret('再次输入密码：');
  if (Array.from(password).length < 12 || Buffer.byteLength(password, 'utf8') > 1024 || password !== confirmation) {
    throw new Error('密码长度无效或两次输入不一致。');
  }
  process.stdout.write(`${await hashPassword(password)}\n`);
} catch (err) {
  process.stderr.write(`\n${err instanceof Error ? err.message : '无法生成密码哈希'}\n`);
  process.exitCode = 1;
} finally {
  process.stdin.setRawMode(Boolean(previousRaw));
  process.stdin.pause();
}
