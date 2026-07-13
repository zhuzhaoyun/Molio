import {interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {KnowledgeGraph, type GraphEdge, type GraphNode} from '../components/KnowledgeGraph';
import {EASE_OUT, FONT_FAMILY, PALETTE} from '../theme';

const nodes: readonly GraphNode[] = [
  {id: 'files', label: '资料', x: 170, y: 300}, {id: 'concepts', label: '概念', x: 390, y: 130},
  {id: 'links', label: '关系', x: 430, y: 440}, {id: 'wiki', label: 'Wiki', x: 705, y: 280, size: 82, accent: true},
  {id: 'thinking', label: '认知', x: 900, y: 125}, {id: 'writing', label: '创作', x: 890, y: 440},
];
const edges: readonly GraphEdge[] = [{from: 'files', to: 'concepts'}, {from: 'files', to: 'links'}, {from: 'concepts', to: 'wiki'}, {from: 'links', to: 'wiki'}, {from: 'wiki', to: 'thinking'}, {from: 'wiki', to: 'writing'}];

export const SummaryScene = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const title = interpolate(frame, [5 * fps, 7 * fps], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: EASE_OUT});
  const logo = interpolate(frame, [9 * fps, 10.5 * fps], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: EASE_OUT});
  return (
    <div style={{position: 'absolute', inset: 0, backgroundColor: PALETTE.background, color: PALETTE.text, fontFamily: FONT_FAMILY, overflow: 'hidden'}}>
      <div style={{position: 'absolute', inset: '20px 330px 280px', opacity: 1 - title * 0.72}}><KnowledgeGraph nodes={nodes} edges={edges} delay={5} activeId="wiki" /></div>
      <div style={{position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center'}}>
        <div style={{opacity: title, transform: `translateY(${(1 - title) * 42}px)`}}>
          <div style={{fontSize: 30, color: PALETTE.muted, marginBottom: 22}}>LLM WIKI</div>
          <div style={{fontSize: 76, fontWeight: 850, letterSpacing: -3}}>从保存资料，<span style={{color: PALETTE.accent}}>到维护认知</span></div>
          <div style={{marginTop: 31, color: PALETTE.muted, fontSize: 24}}>让知识形成结构，也让结构持续更新。</div>
          <div style={{marginTop: 54, opacity: logo, fontSize: 28, fontWeight: 800, letterSpacing: 8}}>MOLIO</div>
        </div>
      </div>
    </div>
  );
};
