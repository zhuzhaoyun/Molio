// apps/web/src/utils/workOutcome.ts

/**
 * 工作块折叠头判定所需的最小消息形状（结构上兼容 ChatMessage）。
 *
 * `tools` 被有意接受但**不参与判定** —— 见 isWorkBlockFailed 的说明。放在签名里是为了
 * 让这个「刻意排除」在类型上可见，并让测试能用一条真实形状的消息把语义钉住。
 */
export interface WorkOutcomeMessage {
  /** run 生命周期错误（ACP 超时 / spawn 失败 / prompt failed …），由 daemon 的 error 事件写入。 */
  error?: string;
  tools?: { isError?: boolean }[];
}

/**
 * 工作块折叠头显示 ✗「执行出错」还是 ✓「已完成」。
 *
 * **卡片头报告的是这次回复（run）的结局，不是单个工具的结局。**
 *
 * 为什么工具级失败不参与判定（2026-10-10「任务后台明明跑完了，卡片却写执行出错」事故）：
 * 工具失败是 agent 正常工作流的一部分 —— hermes `patch` 上下文不匹配 → 重读文件 → 重试成功；
 * `write_file` 撞上已存在文件 → 改用 `patch` 写入。当晚那条 run 的 83 次工具调用里有 3 次
 * failed，agent 每次都自行恢复，最后 `turn_end(end_turn)` 正常收尾、产物全部落盘，卡片却因为
 * 旧判据 `tools.some(t => t.isError)` 翻成「执行出错」。
 *
 * 逐工具的 ✓/✗ 依然可见，信号没有丢：
 *   - 工具行自己渲染状态（ToolCard / ToolGroup 的 ✗ + error 配色）；
 *   - 恢复过的失败自动折叠、未恢复的失败自动展开显示错误（ToolCard.hasRetrySucceeded）。
 *
 * run 真失败时 daemon **必发** error 事件（RunManager.finishRun('failed') 对没发过 error 的
 * run 兜底补发），前端落到 `message.error` —— 这才是卡片头该认的唯一信号。
 *
 * 实测支撑（本机 ~/.molio/runs 全量 1088 条 run）：396 条有工具调用，其中 10 条出现过 failed
 * 工具、6 条同时**没有** run 级 error（= 6 张被误标「执行出错」的卡片）；而「最后一个工具失败」
 * 的 run 是 **0** 条 —— 说明按工具结局升级卡片头只会制造误报，补不回任何真信号。
 */
export function isWorkBlockFailed(message: WorkOutcomeMessage): boolean {
  return !!message.error;
}
