import { spawn } from 'child_process';

const bin = 'C:\\Users\\xianxh\\AppData\\Roaming\\npm\\qwen.cmd';
const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json'];

const child = spawn(bin, args, {
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: true,
});

child.stdout.on('data', (d) => process.stdout.write(d));
child.stderr.on('data', (d) => process.stderr.write(d));
child.on('close', (code) => {
  console.log('\nEXIT CODE:', code);
  process.exit(0);
});

const msg = JSON.stringify({ type: 'user', message: { role: 'user', content: 'say hello' } });
child.stdin.write(msg + '\n');
