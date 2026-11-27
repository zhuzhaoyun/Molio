// apps/web/src/utils/diagnoseIntent.test.ts
// 隐式诊断触发的判定口径。精度优先于召回：误判一次会把无关对话劫持成体检流程
// （#369 的无条件触发语曾把通用问题也包成检索指令，用户直接报障）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDiagnoseRequest } from './diagnoseIntent.ts';

test('Molio 功能出问题的说法要识别', () => {
  for (const s of ['知识图谱打不开', 'wiki 构建失败了', '发布到公众号失败', 'Molio 更新不了', '目录加载失败：Failed to fetch', '题卡报错了']) {
    assert.equal(isDiagnoseRequest(s), true, s);
  }
});

test('界面失灵的说法即使没提功能名也要识别', () => {
  for (const s of ['文件加载不出来', 'AI 没反应', '白屏了', '用不了了']) assert.equal(isDiagnoseRequest(s), true, s);
});

test('写作请求即使含故障词也不识别', () => {
  for (const s of ['帮我写一篇关于系统报错的文章', '帮我写个知识库管理方案', '总结一下这段失败案例', '把这个报错提示改写得更友好']) {
    assert.equal(isDiagnoseRequest(s), false, s);
  }
});

test('与 Molio 无关的失败、普通提问、空串不识别', () => {
  for (const s of ['这个 Python 报错怎么改', '考试失败了怎么办', '今天天气怎么样', '']) assert.equal(isDiagnoseRequest(s), false, s);
});
