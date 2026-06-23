import type { Command } from './types';

export const BUILTIN_COMMANDS: Command[] = [
  {
    id: 'new-doc',
    icon: '📝',
    label: '新建文档',
    description: '在知识库中创建新的 Markdown 文档',
    action: { type: 'callback', key: 'new-doc' },
  },
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
  },
  {
    id: 'outline',
    icon: '📊',
    label: '生成大纲',
    description: '为当前话题生成结构化大纲',
    action: { type: 'callback', key: 'outline' },
  },
  {
    id: 'search',
    icon: '🔍',
    label: '搜索全部文档',
    description: '在知识库中搜索关键词',
    action: { type: 'navigate', route: '/knowledge' },
  },
  {
    id: 'new-chat',
    icon: '💬',
    label: '新建对话',
    description: '清空当前对话，开始新话题',
    action: { type: 'callback', key: 'new-chat' },
  },
];
