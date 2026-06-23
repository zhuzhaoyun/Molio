import type { Command } from './types';

export const BUILTIN_COMMANDS: Command[] = [
  {
    id: 'browse-kb',
    icon: '📂',
    label: '浏览知识库',
    description: '打开知识库页面浏览文件',
    action: { type: 'navigate', route: '/knowledge' },
  },
  {
    id: 'polish',
    icon: '🧹',
    label: '优化文字',
    description: '润色和改进当前文本表达',
    action: { type: 'callback', key: 'polish' },
    completeText: '请帮我优化以下文字的表达，使其更清晰流畅：',
  },
  {
    id: 'outline',
    icon: '📊',
    label: '生成大纲',
    description: '为当前话题生成结构化大纲',
    action: { type: 'callback', key: 'outline' },
    completeText: '请为以下内容生成一个结构化大纲：',
  },
  {
    id: 'new-chat',
    icon: '💬',
    label: '新建对话',
    description: '清空当前对话，开始新话题',
    action: { type: 'callback', key: 'new-chat' },
  },
];
