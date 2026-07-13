import {interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {KnowledgeCard} from '../components/KnowledgeCard';
import {SceneLayout} from '../components/SceneLayout';
import {EASE_OUT, MONO_FAMILY, PALETTE} from '../theme';

const sourceCards = [
  ['会议记录', '三次访谈，七个问题'],
  ['网页收藏', '稍后阅读，后来忘记'],
  ['PDF 报告', '一百二十页行业资料'],
  ['灵感', '一句还没展开的想法'],
  ['研究笔记', '散落的概念与引用'],
  ['草稿', '写到一半的文章'],
] as const;

export const ProblemScene = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const query = '上次关于 LLM Wiki 的结论在哪？';
  const typed = query.slice(0, Math.floor(interpolate(frame, [5 * fps, 7.8 * fps], [0, query.length], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})));
  const searchEnter = interpolate(frame, [4.2 * fps, 5.1 * fps], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: EASE_OUT});
  const resultEnter = interpolate(frame, [8.5 * fps, 9.4 * fps], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});

  return (
    <SceneLayout chapter="文件被保存，知识没有被组织" index="01" title="知识，为什么越存越乱？">
      <div style={{position: 'absolute', inset: '18px 0 0'}}>
        {sourceCards.map(([label, detail], index) => {
          const positions = [[0, 25], [320, 5], [650, 35], [120, 235], [460, 245], [800, 220]];
          const [x, y] = positions[index]!;
          return <div key={label} style={{position: 'absolute', left: x, top: y, transform: `rotate(${[-4, 2, -2, 3, -1, 4][index]}deg)`}}><KnowledgeCard label={label} detail={detail} delay={index * 5} width={260} /></div>;
        })}
        <div style={{position: 'absolute', right: 0, top: 52, width: 560, opacity: searchEnter, transform: `translateX(${(1 - searchEnter) * 70}px)`}}>
          <div style={{padding: '20px 24px', borderRadius: 16, border: `1px solid ${PALETTE.edgeStrong}`, backgroundColor: PALETTE.surface, fontFamily: MONO_FAMILY, fontSize: 21}}>
            <span style={{color: PALETTE.accent}}>⌕</span> {typed}<span style={{opacity: frame % 24 < 12 ? 1 : 0}}>▍</span>
          </div>
          <div style={{marginTop: 14, padding: '20px 24px', borderRadius: 16, border: `1px solid ${PALETTE.edge}`, color: PALETTE.muted, backgroundColor: 'rgba(26,29,42,0.8)', opacity: resultEnter}}>
            找到 47 个文件。没有一份直接回答这个问题。
          </div>
        </div>
      </div>
    </SceneLayout>
  );
};
