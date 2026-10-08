// Grandchild process for kill-tree.test.ts. Writes its own PID to the file
// named by TREE_CHILD_PIDFILE, then stays alive indefinitely so the test can
// assert it gets REAPED by killAgentProcessTree (a plain child.kill() on the
// cmd.exe wrapper would orphan it — the Windows orphan-leak regression).
import { writeFileSync } from 'node:fs';

const pidfile = process.env['TREE_CHILD_PIDFILE'];
if (pidfile) {
  writeFileSync(pidfile, String(process.pid));
}

// Keep the event loop alive until killed.
setInterval(() => {}, 1000);
