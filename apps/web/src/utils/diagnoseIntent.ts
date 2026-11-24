// apps/web/src/utils/diagnoseIntent.ts
//
// 隐式诊断入口的意图判定：用户在 KB 问答里抱怨 Molio 自身出问题时（「知识图谱
// 打不开」），把首条消息包上体检指令（见 kbChatPrompts 的 DIAGNOSE_DIRECTIVE），
// 让 agent 跑只读体检而不是凭通用知识瞎猜。
//
// 口径是「精度优先于召回」：漏掉一次抱怨，用户会换个说法再抱怨，损失很小；误判
// 一次则把无关对话劫持成体检流程——#369 的无条件「不要凭训练记忆作答」触发语就
// 这么把通用问题也包成了检索指令，用户直接报障。所以：
//   1. 创作动词（写/总结/改写…）一票否决——「帮我写一篇关于系统报错的文章」
//      里的「报错」是题材不是故障；
//   2. 「界面失灵词」（白屏/没反应/加载不出来…）单独成立：非技术用户描述 Molio
//      故障时常常说不出功能名，只有症状；
//   3. 其余故障词必须搭配一个 Molio 功能词（知识图谱/wiki/发布/剪藏…），把
//      「Python 报错怎么改」「考试失败」这类与 Molio 无关的失败排除在外。
const SURFACE = /molio|知识图谱|图谱|知识库|wiki|排版|发布到|技能|skills?|对话|问答|运行时|agent|智能体|更新|剪藏|扩展|登录|资源库|题卡|出题|体检/i;
const UI_TROUBLE = /加载(不出来|失败|不出)|白屏|一片空白|没反应|用不了|没法用|不能用了|打不开/i;
const FAILURE = /报错|出错了|出错|崩了|闪退|卡死|卡住|乱码|连不上|连不到|失败|(更新|加载|构建|同步|安装|登录|发布|打开|启动|连接|使用)不了|Failed to fetch|os error\b|\bE(ACCES|NOENT|BADF|ADDRINUSE|PERM)\b|\b(404|500|502|503)\b|无法(加载|打开|使用|登录|发布|启动|连接)|不显示|不见了|丢了|消失了|没生效|不工作|出了问题|有问题/i;
const CREATION = /(写|撰写)(一|个|篇|段|份|条|封)|润色|改写|扩写|续写|翻译成|翻译一下|总结一下|总结这|起个标题|拟标题|起标题/;

export function isDiagnoseRequest(text: string): boolean {
  if (!text.trim() || CREATION.test(text)) return false;
  if (UI_TROUBLE.test(text)) return true;
  return FAILURE.test(text) && SURFACE.test(text);
}
