import { spawn } from 'node:child_process';

const prompt = `你的运行时是哪个？`;
const binary = 'C:\\Users\\xianxh\\AppData\\Roaming\\npm\\codex.cmd';
const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'danger-full-access'];
const env = { ...process.env, MOLIO_RUN_ID: 'test-run-id' };

// Test 1: spawn with full path to .cmd file, shell: true
const child1 = spawn(binary, args, {
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: true,
});

let stdout1 = '';
let stderr1 = '';

child1.stdout.on('data', (d) => { stdout1 += d; });
child1.stderr.on('data', (d) => { stderr1 += d; });

child1.on('close', (code) => {
  console.log('TEST 1 - Full path .cmd, shell:true');
  console.log('EXIT CODE:', code);
  console.log('STDOUT:', stdout1.slice(0, 500));
  console.log('STDERR:', stderr1.slice(0, 500));
  console.log('---');
});

child1.stdin.write(prompt, 'utf8');
child1.stdin.end();

// Test 2: spawn with 'codex', shell: true
setTimeout(() => {
  const child2 = spawn('codex', args, {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
  });

  let stdout2 = '';
  let stderr2 = '';

  child2.stdout.on('data', (d) => { stdout2 += d; });
  child2.stderr.on('data', (d) => { stderr2 += d; });

  child2.on('close', (code) => {
    console.log('TEST 2 - spawn("codex"), shell:true');
    console.log('EXIT CODE:', code);
    console.log('STDOUT:', stdout2.slice(0, 500));
    console.log('STDERR:', stderr2.slice(0, 500));
  });

  child2.stdin.write(prompt, 'utf8');
  child2.stdin.end();
}, 5000);
