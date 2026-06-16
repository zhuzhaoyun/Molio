import { spawn } from 'node:child_process';

const prompt = `<system-hint>You are running as "Codex CLI" (id: codex) inside Molio. When the user asks which AI runtime or agent is active, tell them this.</system-hint>

你的运行时是哪个？`;

// Simulate RunManager spawn exactly
const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'danger-full-access'];
const env = { ...process.env, MOLIO_RUN_ID: 'test-run-id' };

const child = spawn('codex', args, {
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: true,
});

let stdout = '';
let stderr = '';

child.stdout.on('data', (d) => { stdout += d; });
child.stderr.on('data', (d) => { stderr += d; });

child.on('close', (code) => {
  console.log('EXIT CODE:', code);
  console.log('STDOUT:', stdout.slice(0, 2000));
  console.log('STDERR:', stderr.slice(0, 2000));
});

child.stdin.write(prompt, 'utf8');
child.stdin.end();
