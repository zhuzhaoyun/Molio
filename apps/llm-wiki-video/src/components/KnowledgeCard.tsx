import {interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {EASE_OUT, PALETTE} from '../theme';

type KnowledgeCardProps = {
  label: string;
  detail: string;
  accent?: string;
  delay?: number;
  width?: number;
};

export const KnowledgeCard = ({
  label,
  detail,
  accent = PALETTE.accent,
  delay = 0,
  width = 270,
}: KnowledgeCardProps) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const enter = interpolate(frame, [delay, delay + 0.65 * fps], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: EASE_OUT,
  });

  return (
    <div
      style={{
        width,
        padding: '22px 24px',
        borderRadius: 18,
        border: `1px solid ${PALETTE.edge}`,
        backgroundColor: 'rgba(26,29,42,0.92)',
        boxShadow: '0 22px 60px rgba(0,0,0,0.26)',
        opacity: enter,
        transform: `translateY(${(1 - enter) * 42}px) scale(${0.94 + enter * 0.06})`,
      }}
    >
      <div style={{height: 4, width: 44, borderRadius: 9, backgroundColor: accent, marginBottom: 17}} />
      <div style={{fontSize: 27, fontWeight: 700, marginBottom: 8}}>{label}</div>
      <div style={{fontSize: 18, lineHeight: 1.55, color: PALETTE.muted}}>{detail}</div>
    </div>
  );
};
