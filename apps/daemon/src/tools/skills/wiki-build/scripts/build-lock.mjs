// build-lock.mjs — 双会话构建互斥锁（防同一 vault 并行构建互相覆盖）
// 用法:
//   node build-lock.mjs acquire <label> [--vault <dir>]  构建开始前调用
//   node build-lock.mjs release <label> [--vault <dir>]  构建结束/失败后调用
//   node build-lock.mjs status  [--vault <dir>]          只读查看锁
//
// 所有权模型：label 声明式，不用 PID。
//   CLI 调用每次都是短命进程，写成文件的 PID 在进程退出后立即"死亡"，
//   若靠 PID 判定 stale 会误放行并发会话（第二个 acquire 把第一个的锁当垃圾接管）。
//   因此锁文件只认 label：
//     acquire <label>：LOCK 存同 label → 重入，直接续持（exit 0）
//                       LOCK 存异 label → 拒绝（exit 1，报谁在锁）
//                       无 LOCK          → 立锁（exit 0）
//     release <label>：LOCK 存同 label → 删除（exit 0）
//                       LOCK 存异 label → 拒绝（exit 1）
//                       无 LOCK          → no-op（exit 0）
//   崩溃遗留的异 label 锁：人工或主 agent 确认后 `--force` 强制接管；保守不自动覆盖。
// 零 LLM，确定性。
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, resolveVault, buildDir } from './lib/cli.mjs';

const opts = parseArgs(process.argv.slice(2));
const [cmd, label] = opts._;
if (!cmd || !['acquire', 'release', 'status'].includes(cmd)) {
  console.error('用法: node build-lock.mjs acquire|release <label> | status [--vault <dir>]');
  process.exit(1);
}

const vault = resolveVault(opts);
const wd = buildDir(vault);
const lockFile = path.join(wd, 'LOCK');
fs.mkdirSync(wd, { recursive: true });

function readLock() {
  try {
    return JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  } catch {
    return null;
  }
}

if (cmd === 'status') {
  console.log(JSON.stringify(readLock(), null, 2));
  process.exit(0);
}

if (cmd === 'acquire') {
  if (!label) { console.error('acquire 需要 <label>（会话标识，如 build 红楼梦全本-0815）'); process.exit(1); }
  const existing = readLock();
  if (existing && existing.label !== label && !opts.force) {
    console.error(`构建被占用：label="${existing.label}" 于 ${existing.started} 开始。
另一会话正在此库构建。确认其已结束/崩溃后，可用同一 label release 或用 --force 强制接管（覆盖）：`);
    process.exit(1);
  }
  const me = { label, started: new Date().toISOString() };
  fs.writeFileSync(lockFile, JSON.stringify(me, null, 2));
  console.log(JSON.stringify({ acquired: true, lock: me, replacedStale: !!existing && existing.label !== label }));
  process.exit(0);
}

// release
if (!label) { console.error('release 需要 <label>（与你 acquire 时相同的会话标识）'); process.exit(1); }
const existing = readLock();
if (!existing) { console.log(JSON.stringify({ released: false, reason: 'no-lock' })); process.exit(0); }
if (existing.label !== label) {
  console.error(`LOCK 属于 label="${existing.label}"；当前 release 传 label="${label}"，不同会话无权代删。`);
  process.exit(1);
}
fs.rmSync(lockFile, { force: true });
console.log(JSON.stringify({ released: true, label }));
process.exit(0);