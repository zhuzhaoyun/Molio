import { spawn } from 'node:child_process';

// Test 1: Write prompt then end stdin immediately
const child1 = spawn('codex', ['exec', '--json', '--skip-git-repo-check'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: true,
});

child1.stdout.on('data', (d) => process.stdout.write(d));
child1.stderr.on('data', (d) => process.stderr.write(d));

child1.stdin.write('Hello world');
child1.stdin.end();

// Test 2: Write prompt, keep stdin open for a bit, then end
setTimeout(() => {
  const child2 = spawn('codex', ['exec', '--json', '--skip-git-repo-check'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
  });

  child2.stdout.on('data', (d) => process.stdout.write(d));
  child2.stderr.on('data', (d) => process.stderr.write(d));

  child2.stdin.write('Hello world');
  // Keep stdin open for 5 seconds
  setTimeout(() => {
    child2.stdin.end();
  }, 5000);
}, 10000);
