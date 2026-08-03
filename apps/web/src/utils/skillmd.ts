/**
 * SKILL.md 前端解析 / 序列化工具。
 *
 * 与 daemon 端 `apps/daemon/src/core/skills/skillmd.ts` 的 `generateSkillMd` /
 * `parseSkillMd` 语义保持一致（格式的 single source of truth 在 daemon，此处为镜像，
 * 不跨包引后端代码，也不引入额外的 frontmatter 依赖）。
 *
 * 用途：技能「新增 / 编辑」改成单一 markdown 编辑器后——
 *   - 编辑 / 复制 时用 `serializeSkillMd` 把技能拼成 SKILL.md 预填到编辑器；
 *   - 保存时用 `parseSkillMd` 解析回 `{ name, description, instructions }`，
 *     再调用既有的 create / update 接口（后端会用它自己的 generateSkillMd 重新落盘）。
 */

export interface ParsedSkillMd {
  name: string;
  description: string;
  instructions: string;
}

/** 折叠换行，保证 name / description 是合法的单行 frontmatter 值。 */
function singleLine(value: string): string {
  return value.replace(/\r?\n/g, ' ').trim();
}

/** 拼出 SKILL.md（frontmatter + 正文），镜像 daemon generateSkillMd（含 version 行）。 */
export function serializeSkillMd(name: string, description: string, instructions: string): string {
  return (
    `---\n` +
    `name: ${singleLine(name)}\n` +
    `description: ${singleLine(description)}\n` +
    `version: 1.0.0\n` +
    `---\n\n` +
    `${instructions.trim()}\n`
  );
}

/** 剥离开头的 `---\n...\n---` frontmatter 块，返回正文。 */
function stripFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (!match) return content;
  return content.slice(match[0].length).replace(/^\r?\n/, '');
}

/** 从 frontmatter 块读取单个 `key: value`（缺失返回 null）。 */
function frontmatterField(content: string, key: string): string | null {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch || !fmMatch[1]) return null;
  const re = new RegExp(`^${key}:\\s*(.*)$`, 'm');
  const m = fmMatch[1].match(re);
  if (!m || m[1] === undefined) return null;
  // 去掉可能存在的首尾引号。
  return m[1].trim().replace(/^["']|["']$/g, '');
}

/**
 * 把 SKILL.md 解析成 `{ name, description, instructions }`。
 * 容忍字段缺失，也容忍完全没有 frontmatter 的内容（整段当作 instructions）。
 */
export function parseSkillMd(content: string): ParsedSkillMd {
  const body = stripFrontmatter(content);
  return {
    name: frontmatterField(content, 'name') ?? '',
    description: frontmatterField(content, 'description') ?? '',
    instructions: body.trim(),
  };
}
