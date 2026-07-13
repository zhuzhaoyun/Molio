import {interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {SceneLayout} from '../components/SceneLayout';
import {EASE_OUT, PALETTE} from '../theme';

const FlowColumn = ({title, subtitle, items, accent, delay}: {title: string; subtitle: string; items: readonly string[]; accent: string; delay: number}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const enter = interpolate(frame, [delay, delay + 0.8 * fps], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: EASE_OUT});
  return (
    <div style={{padding: 30, borderRadius: 22, border: `1px solid ${PALETTE.edge}`, backgroundColor: 'rgba(26,29,42,0.9)', opacity: enter, transform: `translateY(${(1 - enter) * 34}px)`}}>
      <div style={{display: 'flex', alignItems: 'center', gap: 13}}><span style={{width: 12, height: 12, borderRadius: 12, backgroundColor: accent}} /><span style={{fontSize: 32, fontWeight: 800}}>{title}</span></div>
      <div style={{color: PALETTE.muted, marginTop: 9, fontSize: 18}}>{subtitle}</div>
      <div style={{marginTop: 32, display: 'grid', gap: 15}}>
        {items.map((item, index) => (
          <div key={item} style={{display: 'grid', gridTemplateColumns: '50px 1fr', alignItems: 'center', gap: 14}}>
            <div style={{width: 46, height: 46, borderRadius: 24, display: 'grid', placeItems: 'center', backgroundColor: `${accent}24`, border: `1px solid ${accent}`, fontWeight: 800}}>{index + 1}</div>
            <div style={{padding: '14px 17px', borderRadius: 12, backgroundColor: PALETTE.surfaceStrong, fontSize: 20}}>{item}</div>
          </div>
        ))}
      </div>
    </div>
  );
};

export const ComparisonScene = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const combine = interpolate(frame, [18 * fps, 20 * fps], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: EASE_OUT});
  return (
    <SceneLayout chapter="即时取回，与长期结构" index="04" title="LLM Wiki 和普通 RAG，有什么不同？">
      <div style={{position: 'absolute', inset: '52px 0 0', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 36}}>
        <FlowColumn title="RAG" subtitle="在提问发生时，临时取回相关上下文" items={['收到一个问题', '检索几个片段', '完成这次回答']} accent={PALETTE.success} delay={10} />
        <FlowColumn title="LLM Wiki" subtitle="持续维护显式、可阅读的知识结构" items={['整理关键概念', '连接页面与来源', '反复查询与复用']} accent={PALETTE.accent} delay={20} />
        <div style={{position: 'absolute', left: '50%', bottom: 4, transform: `translateX(-50%) scale(${0.8 + combine * 0.2})`, opacity: combine, padding: '15px 28px', borderRadius: 40, backgroundColor: PALETTE.text, color: PALETTE.background, fontSize: 21, fontWeight: 800, boxShadow: '0 16px 50px rgba(0,0,0,0.35)'}}>即时检索 + 长期结构 = 更稳的知识工作流</div>
      </div>
    </SceneLayout>
  );
};
