---
name: rule-sandbox
description: 从当前知识库内容生成可交互的阈值演示——用户拖动参数越过边界，判定与解释实时翻转。适用于任何领域的边界规则（负载与警戒线、时效与期限、资格与条件、温压与安全区间），不绑定学科或考试。Triggers on: 演示, 可视化, 解释给我看, 拖动, 沙盘, 如果…会怎样, 会发生什么, interactive demo, visualize, simulate.
version: 1.0.0
---

# rule-sandbox: 从知识库生成可交互演示

从**当前知识库**生成一个可拖动的阈值演示。用户拖动参数越过边界，判定与解释实时翻转。内容必须来自库，不得凭训练记忆生成。

## 触发

用户说「演示 / 可视化 / 解释给我看 / 拖动 / 沙盘 / 如果…会怎样 / interactive demo / visualize / simulate」，或点名 `/rule-sandbox` 时使用。

与 `quiz-generate` 分工：用户要**做题** → 用 `quiz-generate`；用户要**看懂一个边界怎么变的** → 用本 skill。

## 流程（必须按顺序）

### 1. 先检索

按 `wiki-query` 的路径定位材料：

1. 读 `wiki/hot.md`（存在时）
2. 读根 `wiki/INDEX.md`
3. 按需读相关目录的 `INDEX.md`
4. 读 2–5 个最相关的 wiki 页面
5. wiki 不足时回溯源文件（`raw/`、`notes/`、`docs/` 等）

禁止凭训练记忆生成。材料里没有明确的阈值/边界规则时，不要硬凑。

### 2. 判断是否适合交互

先看材料的**知识形态**，再决定要不要生成：

| 知识形态 | 适合？ | 例子 |
|---|---|---|
| 阈值 / 边界规则 | 适合 | 负载警戒线、诉讼时效、及格线、安全温压区间 |
| 条件组合 | 适合 | 资格条件、构成要件、审批条件 |
| 叙事 / 概念综述 | **不适合** | 人物生平、概念定义、背景介绍 |
| 操作步骤清单 | **不适合** | 部署流程、排查步骤 |

不适合时**退回普通文字讲解**，直接说明「这个主题没有可拖动的边界，我用文字讲」，不要输出围栏。判断依据是材料形态，不是学科。

### 3. 确认参数与刻度

- `params` **恰好 1 个**（P1 是单轴模板：一条轨道 = 一个可拖参数）。其余参照值写成 `fixed` 刻度。
- param 的 `min < max`，`value`（初值）落在区间内。
- `fixed` 的 `value` 也必须落在同一区间内——它是画在轨道上的刻度，越界画不出来。
- `fixed` 用来放阈值/参照值（警戒线、时限线、上限值）。

### 4. 生成判定

每条判定必须满足：

- `when` 恰有 `all` 或 `any` 之一（单层，不嵌套）
- 条件里的 `op` 只能是 `> >= < <= == !=`
- 条件里的 `value`：**数字裸写不加引号**（`"value": 80`），或引用 param/fixed 的 id（`"value": "threshold"`）。
  **绝不能写 `"value": "55"` 这种字符串数字**——协议按严格类型校验，字符串数字既不是数字也不是已知 id，会被直接丢弃。
- `param` 必须引用已存在的 param 或 fixed 的 id
- `tone` 只能是 `ok` / `warn` / `error` / `neutral`
- `title` / `detail` 非空；`detail` 说清「越过边界后会发生什么」
- `sources` 至少 1 条，`path` 是库内相对路径；能找到原文时填 `quote`
- `defaultVerdict` 必填，且**同样要有 `sources`**（出处是硬门槛）
- 同一个参数区间内，最多 3–4 条判定就够；多了用户读不过来
- 多条判定同时命中时，引擎自动取覆盖区间**最窄**（最具体）的一条——**判定的先后顺序无关紧要**，按你自然的思路写即可

找不到依据就不生成这条判定。

### 5. 输出

只输出**一个**引导句 + **一个** `rule-sandbox` 围栏。围栏外不得出现判定结论。

```rule-sandbox
{
  "version": 1,
  "kind": "rule-sandbox",
  "title": "服务器负载预警",
  "template": "threshold-axis",
  "params": [
    { "id": "load", "label": "当前负载", "min": 0, "max": 100, "value": 60, "unit": "%", "step": 5 }
  ],
  "fixed": [
    { "id": "threshold", "label": "警戒线", "value": 80 }
  ],
  "verdicts": [
    {
      "when": { "all": [{ "param": "load", "op": ">", "value": "threshold" }] },
      "tone": "error",
      "title": "负载过高",
      "detail": "超过 80% 警戒线，应先限流再扩容，否则请求会开始超时。",
      "sources": [
        { "path": "wiki/运维手册.md", "quote": "负载持续高于 80% 需人工介入" }
      ]
    }
  ],
  "defaultVerdict": {
    "tone": "ok",
    "title": "负载正常",
    "detail": "低于警戒线，系统可自行消化。",
    "sources": [{ "path": "wiki/运维手册.md" }]
  }
}
```

格式要求：

- 合法 JSON：双引号、无注释、无尾逗号
- 字符串内换行写成 `\n`；**字符串里不得出现 ``` （三个反引号）**——它会提前截断围栏，让整块降级成代码块
- `version` 固定 `1`，`kind` 固定 `rule-sandbox`，`template` 固定 `threshold-axis`
- `title` 简洁，不带学科预设

### 6. 自检

输出前逐项检查：

- [ ] `params` 恰好 1 个，`min < max`，初值在区间内
- [ ] 每个 `fixed` 的值都在 param 的区间内
- [ ] 每条判定的 `op` 在白名单内，没有嵌套的 `all`/`any`
- [ ] 条件里的数字是裸数字，不是 `"55"` 这样的字符串
- [ ] 条件引用的 id 都存在
- [ ] 每条判定和 `defaultVerdict` 都有非空 `sources`
- [ ] 围栏外没有判定结论
- [ ] JSON 能被 `JSON.parse` 解析
