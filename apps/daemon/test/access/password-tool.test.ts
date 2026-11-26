import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { isValidPasswordHash, verifyPassword } from '../../src/core/access/password.js';

const script = resolve(process.cwd(), '../../scripts/create-admin-password.mjs');
const secret = 'test password only 123';

test('password tool refuses input from a pipe', () => {
  const run = spawnSync(process.execPath, [script], { input: secret, encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.equal(run.stdout.includes(secret), false);
  assert.equal(run.stderr.includes(secret), false);
});

test('password tool hides TTY input and emits a hash the server can verify', {
  skip: process.platform === 'win32' || spawnSync('python3', ['--version']).status !== 0,
}, async () => {
  const python = String.raw`
import os, pty, re, select, sys, time
node, script, password = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.execv(node, [node, script])
buf = b''
stage = 0
deadline = time.monotonic() + 15
while time.monotonic() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.2)
    if ready:
        try: chunk = os.read(fd, 4096)
        except OSError: break
        if not chunk: break
        buf += chunk
        if stage == 0 and '管理员密码'.encode() in buf:
            os.write(fd, password.encode() + b'\r'); stage = 1
        if stage == 1 and '再次输入密码'.encode() in buf:
            os.write(fd, password.encode() + b'\r'); stage = 2
    if stage == 2 and re.search(rb'scrypt\$32768\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}', buf): break
else:
    os.kill(pid, 9); raise RuntimeError('password tool timed out')
_, status = os.waitpid(pid, 0)
if os.waitstatus_to_exitcode(status) != 0: raise RuntimeError('password tool failed')
if password.encode() in buf: raise RuntimeError('password was echoed')
m = re.search(rb'scrypt\$32768\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}', buf)
if not m: raise RuntimeError('hash missing')
print(m.group().decode())
`;
  const encoded = execFileSync('python3', ['-c', python, process.execPath, script, secret], { encoding: 'utf8', timeout: 20000 }).trim();
  assert.equal(isValidPasswordHash(encoded), true);
  assert.equal(await verifyPassword(secret, encoded), true);
});
