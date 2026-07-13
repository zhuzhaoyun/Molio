import {interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {KnowledgeGraph, type GraphEdge, type GraphNode} from '../components/KnowledgeGraph';
import {SceneLayout} from '../components/SceneLayout';
import {WikiPage} from '../components/WikiPage';
import {EASE_OUT, PALETTE} from '../theme';

const nodes: readonly GraphNode[] = [
  {id: 'files', label: '源文件', x: 120, y: 280},
  {id: 'concept', label: '概念', x: 360, y: 115},
  {id: 'relation', label: '关系', x: 405, y: 435},
  {id: 'source', label: '来源', x: 675, y: 92},
  {id: 'page', label: 'Wiki', x: 755, y: 300, size: 76, accent: true},
  {id: 'query', label: '写作', x: 650, y: 480},
];

const edges: readonly GraphEdge[] = [
  {from: 'files', to: 'concept'}, {from: 'files', to: 'relation'}, {from: 'concept', to: 'source'},
  {from: 'concept', to: 'page'}, {from: 'relation', to: 'page'}, {from: 'source', to: 'page'}, {from: 'page', to: 'query'},
];

export const DefinitionScene = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const pageEnter = interpolate(frame, [15 * fps, 17 * fps], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: EASE_OUT});

  return (
    <SceneLayout chapter="一层可读、可链接、可维护的知识结构" index="02" title="LLM Wiki，把文件组织成知识地图">
      <div style={{position: 'absolute', inset: '12px 0 0', display: 'grid', gridTemplateColumns: '1.22fr 0.78fr', gap: 52, alignItems: 'center'}}>
        <div style={{height: 540}}><KnowledgeGraph nodes={nodes} edges={edges} delay={15} activeId="page" /></div>
        <div style={{opacity: pageEnter, transform: `translateX(${(1 - pageEnter) * 80}px)`}}>
          <WikiPage title="LLM Wiki" items={['概念被提取并写成页面', '页面之间建立显式链接', '每条结论保留来源']} source="研究笔记.md · 产品访谈.pdf" delay={15 * fps} />
        </div>
      </div>
      <div style={{position: 'absolute', left: 0, bottom: 24, fontSize: 20, color: PALETTE.muted}}>FILES → CONCEPTS → LINKS → PAGES</div>
    </SceneLayout>
  );
};
