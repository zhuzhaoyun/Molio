import {interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {EASE_OUT, MONO_FAMILY, PALETTE} from '../theme';

type WikiPageProps = {
  title: string;
  items: readonly string[];
  source: string;
  delay?: number;
};

export const WikiPage = ({title, items, source, delay = 0}: WikiPageProps) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const enter = interpolate(frame, [delay, delay + 0.8 * fps], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: EASE_OUT,
  });

  return (
    <div
      style={{
        backgroundColor: 'rgba(245,243,255,0.96)',
        color: '#202231',
        borderRadius: 20,
        padding: '34px 38px',
        boxShadow: '0 36px 100px rgba(0,0,0,0.38)',
        opacity: enter,
        transform: `translateY(${(1 - enter) * 40}px) rotate(${(1 - enter) * 1.6}deg)`,
      }}
    >
      <div style={{fontFamily: MONO_FAMILY, color: PALETTE.accentStrong, fontSize: 16}}>wiki / concept</div>
      <div style={{fontSize: 38, fontWeight: 800, margin: '12px 0 20px'}}>{title}</div>
      <div style={{display: 'grid', gap: 13}}>
        {items.map((item, index) => {
          const itemEnter = interpolate(frame, [delay + 15 + index * 8, delay + 30 + index * 8], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          });
          return (
            <div key={item} style={{display: 'flex', gap: 12, fontSize: 20, opacity: itemEnter}}>
              <span style={{color: PALETTE.accentStrong}}>◆</span>
              <span>{item}</span>
            </div>
          );
        })}
      </div>
      <div
        style={{
          marginTop: 25,
          paddingTop: 17,
          borderTop: '1px solid rgba(32,34,49,0.14)',
          color: '#686B7A',
          fontFamily: MONO_FAMILY,
          fontSize: 15,
        }}
      >
        SOURCE · {source}
      </div>
    </div>
  );
};
