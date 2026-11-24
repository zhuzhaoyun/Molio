import type { DiagnosticItem, DiagnosticLevel } from '@molio/contracts';

/**
 * 诊断文案的纯格式化层：数字/时间 → 面向非技术用户的中文表达。
 * 只做格式化与排序，不判断健康、不做任何 I/O。
 * 规矩：英文报错原文、退出码只进 detail 字段（给支持人员看，界面不渲染）。
 */

const GB = 1024 ** 3;

// 展示顺序：问题重的排前面，让用户先看到要处理的事
const LEVEL_ORDER: DiagnosticLevel[] = ['error', 'warn', 'ok', 'skip'];

export function humanizeUpdateError(msg: string): string {
  if (msg.includes('ERR_NAME_NOT_RESOLVED')) {
    return '网络无法解析更新服务器（断网、代理或 DNS 问题）';
  }
  if (
    msg.includes('ERR_CONNECTION_TIMED_OUT') ||
    msg.includes('ERR_CONNECTION_REFUSED') ||
    msg.includes('ERR_INTERNET_DISCONNECTED') ||
    msg.includes('ERR_NETWORK_CHANGED')
  ) {
    return '连接不上更新服务器';
  }
  return '更新服务器返回错误';
}

export function formatDuration(sec: number): string {
  // 面向人读的粗粒度：有更大的单位就丢掉秒（3725 → '1 小时 2 分'，不出现 '5 秒'）
  if (sec >= 3600) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return m > 0 ? `${h} 小时 ${m} 分` : `${h} 小时`;
  }
  if (sec >= 60) return `${Math.floor(sec / 60)} 分`;
  return `${Math.floor(sec)} 秒`;
}

export function formatGB(bytes: number): string {
  return `${(bytes / GB).toFixed(1)} GB`;
}

export function formatClock(ms: number, now: number = Date.now()): string {
  const d = new Date(ms);
  const n = new Date(now);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const sameDay =
    d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  if (sameDay) return `${hh}:${mm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}

export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  const p = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function sortByLevel(items: DiagnosticItem[]): DiagnosticItem[] {
  // Array#sort 在 Node 里是稳定排序，比较器只比级别即可保持同级别原顺序；返回副本不改入参
  const rank = (l: DiagnosticLevel) => LEVEL_ORDER.indexOf(l);
  return [...items].sort((a, b) => rank(a.level) - rank(b.level));
}
