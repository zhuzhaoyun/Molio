import {interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {SceneLayout} from '../components/SceneLayout';
import {WikiPage} from '../components/WikiPage';
import {EASE_OUT, PALETTE} from '../theme';

const stages = ['读取', '提取', '关联', '生成', '更新'] as const;

export const BuildScene = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const activeStage = Math.min(stages.length - 1, Math.floor(frame / (4.6 * fps)));
  const pageEnter = interpolate(frame, [20 * fps, 22 * fps], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: EASE_OUT});
  const documentX = interpolate(frame, [1.5 * fps, 22 * fps], [90, 1190], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});

  return (
    <SceneLayout chapter="读取、提取、关联、生成、更新" index="03" title="知识如何持续生长？">
      <div style={{position: 'absolute', top: 74, left: 0, right: 0}}>
        <div style={{position: 'relative', display: 'grid', gridTemplateColumns: `repeat(${stages.length}, 1fr)`, gap: 24}}>
          <div style={{position: 'absolute', left: 92, right: 92, top: 52, height: 2, backgroundColor: PALETTE.edge}} />
          {stages.map((stage, index) => {
            const active = index <= activeStage;
            return (
              <div key={stage} style={{position: 'relative', display: 'grid', placeItems: 'center', gap: 16}}>
                <div style={{width: 104, height: 104, borderRadius: 60, display: 'grid', placeItems: 'center', backgroundColor: active ? 'rgba(139,92,246,0.22)' : PALETTE.surface, border: `2px solid ${active ? PALETTE.accent : PALETTE.edgeStrong}`, fontSize: 24, fontWeight: 700, zIndex: 1}}>{stage}</div>
                <span style={{color: active ? PALETTE.text : PALETTE.muted, fontSize: 17}}>0{index + 1}</span>
              </div>
            );
          })}
          <div style={{position: 'absolute', left: documentX, top: -18, width: 74, height: 92, borderRadius: 10, backgroundColor: '#F5F3FF', boxShadow: '0 12px 40px rgba(0,0,0,0.35)', transform: 'translateX(-50%)'}}>
            <div style={{height: 9, margin: '17px 13px 9px', borderRadius: 8, backgroundColor: PALETTE.accent}} /><div style={{height: 5, margin: '0 13px 7px', backgroundColor: '#C5C6D0'}} /><div style={{height: 5, margin: '0 13px', backgroundColor: '#C5C6D0'}} />
          </div>
        </div>
        <div style={{marginTop: 54, display: 'grid', gridTemplateColumns: '0.9fr 1.1fr', gap: 52, alignItems: 'center'}}>
          <div style={{display: 'grid', gap: 15}}>
            {['只处理新增与修改', '冲突时标出差异', '每个页面都能回到原文'].map((item, index) => (
              <div key={item} style={{padding: '17px 20px', borderRadius: 14, backgroundColor: index <= Math.max(0, activeStage - 2) ? 'rgba(139,92,246,0.13)' : PALETTE.surface, border: `1px solid ${PALETTE.edge}`, fontSize: 20}}><span style={{color: PALETTE.accent, marginRight: 13}}>✓</span>{item}</div>
            ))}
          </div>
          <div style={{opacity: pageEnter}}><WikiPage title="知识构建循环" items={['来源改变时增量更新', '新概念加入已有网络', '冲突保留两侧证据']} source="wiki/log.md · wiki/sources" delay={20 * fps} /></div>
        </div>
      </div>
    </SceneLayout>
  );
};
