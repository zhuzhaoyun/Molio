import type {Caption} from '@remotion/captions';

export const FPS = 30;
export const TOTAL_FRAMES = 150 * FPS;
export const CAPTION_COMBINE_MS = 50;

export type SceneId =
  | 'problem'
  | 'definition'
  | 'build'
  | 'comparison'
  | 'molio'
  | 'summary';

export type SceneSpec = {
  id: SceneId;
  startFrame: number;
  endFrame: number;
  title: string;
  narration: string;
};

export const voiceoverPath = (sceneId: SceneId) => `audio/voiceover/${sceneId}.mp3`;

export const SCENES: readonly SceneSpec[] = [
  {
    id: 'problem',
    startFrame: 0,
    endFrame: 540,
    title: '知识越存越乱',
    narration:
      '会议记录、网页、PDF、灵感和草稿，我们保存的资料越来越多。可到了真正要写东西的时候，还是不知道答案藏在哪。因为文件只是被收起来，知识之间的关系并没有被组织。',
  },
  {
    id: 'definition',
    startFrame: 540,
    endFrame: 1350,
    title: '什么是 LLM Wiki',
    narration:
      'LLM Wiki 的思路，是让大模型在原始资料之上，维护一层可以阅读的知识结构。它识别概念，整理主题，建立链接，写成页面，同时保留每条结论的来源。你看到的不再是一堆文件，而是一张能追溯、能浏览的知识地图。',
  },
  {
    id: 'build',
    startFrame: 1350,
    endFrame: 2340,
    title: '知识如何持续生长',
    narration:
      '这张地图不是一次生成后就结束。系统先读取源文件，提取关键概念和事实，再判断它们与已有页面的关系，生成或更新对应条目。新资料进入时，只处理新增和修改的部分；来源冲突时，标出差异，等待检查。这样，Wiki 会跟着你的资料一起生长，页面也始终能回到原文。',
  },
  {
    id: 'comparison',
    startFrame: 2340,
    endFrame: 3150,
    title: 'LLM Wiki 和 RAG',
    narration:
      '它和常见的 RAG 有什么区别？RAG 在你提问时检索几个相关片段，帮助模型完成这一次回答。LLM Wiki 更关心长期积累：哪些概念重要，它们怎样连接，哪些页面需要更新。一个擅长即时取回，一个负责维护结构，组合起来，回答会更稳，知识也能反复使用。',
  },
  {
    id: 'molio',
    startFrame: 3150,
    endFrame: 4080,
    title: 'Molio 如何落地',
    narration:
      '在 Molio 里，本地目录仍然是事实来源。你可以看到文件树，选择资料构建 Wiki，也能识别哪些文件尚未摄入、已经更新，或者保持同步。生成的页面和知识图谱用于查询，也能直接进入写作流程。文件、Wiki、问答和创作被放在同一个本地工作区里。',
  },
  {
    id: 'summary',
    startFrame: 4080,
    endFrame: TOTAL_FRAMES,
    title: '从保存资料，到维护认知',
    narration:
      'LLM Wiki 的价值，不是替你收藏更多内容。它让散落的资料形成结构，让结构随着新信息持续更新。你开始维护的，不再只是文件，而是自己的认知。',
  },
] as const;

const splitCaptionText = (text: string): string[] => {
  const phrases = text
    .split(/(?<=[，。？！；：])/u)
    .map((phrase) => phrase.trim())
    .filter(Boolean);

  return phrases.flatMap((phrase) => {
    const characters = Array.from(phrase);
    const chunks: string[] = [];
    for (let index = 0; index < characters.length; index += 20) {
      chunks.push(characters.slice(index, index + 20).join(''));
    }
    return chunks;
  });
};

const captionsForScene = (scene: SceneSpec): Caption[] => {
  const phrases = splitCaptionText(scene.narration);
  const sceneStartMs = (scene.startFrame / FPS) * 1000;
  const sceneEndMs = (scene.endFrame / FPS) * 1000;
  const insetMs = 420;
  const slotMs = (sceneEndMs - sceneStartMs - insetMs * 2) / phrases.length;

  return phrases.map((text, index) => ({
    text: ` ${text}`,
    startMs: Math.round(sceneStartMs + insetMs + index * slotMs),
    endMs: Math.round(sceneStartMs + insetMs + (index + 1) * slotMs - 90),
    timestampMs: null,
    confidence: null,
  }));
};

export const CAPTIONS: readonly Caption[] = SCENES.flatMap(captionsForScene);
