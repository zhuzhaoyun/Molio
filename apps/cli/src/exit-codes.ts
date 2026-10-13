/**
 * CLI 语义化退出码 — 外部 agent（WorkBuddy / 千问 / shell 脚本）靠退出码决策，
 * 不需要解析错误文本。改动前先读 apps/cli/CLAUDE.md 的约定表。
 */
export const EXIT_OK = 0;
/** daemon 不可达（未启动 / 端口不对 / 中途断连且 run 状态未知）。 */
export const EXIT_DAEMON_UNREACHABLE = 1;
/** vault 未找到、名称歧义、或无 active vault 且未传 --vault。 */
export const EXIT_VAULT_NOT_FOUND = 2;
/** 文件不存在（daemon 404）。 */
export const EXIT_FILE_NOT_FOUND = 3;
/** 文件过大（daemon 413 refuse，或 200 + tooLarge:true 空内容）。 */
export const EXIT_FILE_TOO_LARGE = 4;
/** 用法错误：参数缺失 / 非法、无可用 agent runtime。 */
export const EXIT_USAGE = 5;
/** run 终态为 failed/canceled，或 run 丢失（daemon 重启、TTL 过期）。 */
export const EXIT_RUN_FAILED = 6;
/** --timeout 到期 run 仍未终止。 */
export const EXIT_TIMEOUT = 7;
