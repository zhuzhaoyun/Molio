import { isAbsolute, join } from 'node:path'

export interface ContextRequest {
  mode: 'ask' | 'build' | 'lint' | 'ingest'
  vaultId: string
  vaultPath: string
  filePath?: string
  selectedText?: string
  isDirectory?: boolean
}

const modes = {
  ask: '根据当前知识库的资料回答我的问题，请注明依据的文件。',
  build: '扫描当前知识库的源文件，构建结构化 Wiki。',
  lint: '检查 Wiki 的孤立页、断链、元数据缺失和内容矛盾，生成检查报告。',
  ingest: '将下列来源摄取到当前知识库 Wiki。',
}

export function knowledgeDraft(input: ContextRequest, skillsDirectory: string) {
  if (!input || !Object.hasOwn(modes, input.mode) || typeof input.vaultId !== 'string'
    || !input.vaultId || typeof input.vaultPath !== 'string') throw new Error('无效的知识库会话请求')
  const { filePath, selectedText } = input
  if (filePath !== undefined && (typeof filePath !== 'string' || isAbsolute(filePath)
    || filePath.split(/[\\/]/).includes('..'))) throw new Error('文件路径必须位于知识库内')
  if (selectedText !== undefined && typeof selectedText !== 'string') throw new Error('无效的选区')
  if (input.mode === 'ingest' && !filePath) throw new Error('请选择要摄取的来源')
  const skill = 'wiki-' + (input.mode === 'ask' ? 'query' : input.mode)
  return [
    modes[input.mode], '请先读取并遵循 ' + join(skillsDirectory, skill, 'SKILL.md'),
    filePath && (input.isDirectory ? '目录：' : '文件：') + filePath,
    selectedText && '选中文字：\n' + selectedText,
  ].filter(Boolean).join('\n\n')
}
