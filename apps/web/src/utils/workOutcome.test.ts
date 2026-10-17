import { describe, it } from 'node:test';
import assert from 'node:assert';
import { isWorkBlockFailed } from './workOutcome.ts';

/**
 * 工作块折叠头（✓已完成 / ✗执行出错）判据。
 *
 * 回归背景（2026-10-10 用户报障「卡片显示执行出错，但任务是后台执行完了的」）：
 * 旧判据 `!!message.error || tools.some(t => t.isError)` 把**任意一次工具失败**升级成整卡失败。
 * 而 agent 的工具失败是正常工作流：hermes `patch` 上下文不匹配 → 重读文件 → 重试成功；
 * `write_file` 撞上已存在文件 → 改用 `patch` 写入。当晚那条 run（e1da7ffa）83 次工具调用里
 * 3 次 failed，全部被 agent 自行恢复，`turn_end(end_turn)` 正常收尾、产物落盘，卡片却写着「执行出错」。
 *
 * 本机 ~/.molio/runs 全量统计佐证：396 条有工具的 run 中，10 条出现过 failed 工具、其中 6 条
 * 没有 run 级 error（= 6 张误标卡片）；「最后一个工具失败」的 run 为 0 条 —— 按工具结局升级
 * 卡片头只产生误报，补不回任何真信号。
 */

/** 复刻 e1da7ffa 那条 run 的失败/恢复形状（工具名省略，判据只看 isError）。 */
const recoveredToolFailures = {
  tools: [
    { isError: false }, // read_file INDEX.md
    { isError: true },  // patch INDEX.md —— 上下文不匹配，失败
    { isError: false }, // read_file INDEX.md —— agent 重读文件
    { isError: false }, // patch INDEX.md —— 重试成功
    { isError: true },  // write_file hot.md —— 文件已存在，失败
    { isError: true },  // write_file hot.md —— 再试仍失败
    { isError: false }, // patch hot.md —— 改用 patch，成功
  ],
};

describe('isWorkBlockFailed', () => {
  it('工具失败被 agent 恢复、run 正常收尾 → 不算失败（✗ 只留在工具行上）', () => {
    assert.equal(isWorkBlockFailed(recoveredToolFailures), false);
  });

  it('全部工具都失败但 run 没有 error 事件 → 仍不算卡片级失败', () => {
    assert.equal(isWorkBlockFailed({ tools: [{ isError: true }, { isError: true }] }), false);
  });

  it('没有任何工具（纯问答）→ 不算失败', () => {
    assert.equal(isWorkBlockFailed({}), false);
    assert.equal(isWorkBlockFailed({ tools: [] }), false);
  });

  it('run 级 error（daemon 对 failed run 必发 error 事件）→ 执行出错', () => {
    assert.equal(isWorkBlockFailed({ error: 'prompt failed: llm-deepseek: no API key' }), true);
    assert.equal(isWorkBlockFailed({ error: 'ACP idle timeout: session/new', tools: [] }), true);
  });

  it('error 与恢复过的工具失败同时存在 → error 优先，仍判执行出错', () => {
    assert.equal(isWorkBlockFailed({ ...recoveredToolFailures, error: 'ACP idle timeout' }), true);
  });

  it('空字符串 error 不算失败（历史消息里 error 可能被写成空串）', () => {
    assert.equal(isWorkBlockFailed({ error: '' }), false);
  });
});
