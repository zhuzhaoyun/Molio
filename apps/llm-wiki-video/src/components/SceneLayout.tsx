import type {ReactNode} from 'react';
import {AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {EASE_OUT, FONT_FAMILY, PALETTE} from '../theme';

type SceneLayoutProps = {
  chapter: string;
  index: string;
  title?: string;
  children: ReactNode;
};

export const SceneLayout = ({chapter, index, title, children}: SceneLayoutProps) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const enter = interpolate(frame, [0, 0.8 * fps], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: EASE_OUT,
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: PALETTE.background,
        backgroundImage:
          'radial-gradient(circle at 18% 18%, rgba(139,92,246,0.16), transparent 31%), radial-gradient(circle at 86% 74%, rgba(56,189,248,0.08), transparent 30%)',
        color: PALETTE.text,
        fontFamily: FONT_FAMILY,
        overflow: 'hidden',
        padding: '64px 86px 126px',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          opacity: enter,
          transform: `translateY(${(1 - enter) * -18}px)`,
        }}
      >
        <div style={{display: 'flex', alignItems: 'center', gap: 18}}>
          <span
            style={{
              color: PALETTE.accent,
              fontSize: 21,
              fontWeight: 700,
              letterSpacing: 3.2,
            }}
          >
            LLM WIKI
          </span>
          <span style={{width: 56, height: 1, backgroundColor: PALETTE.edgeStrong}} />
          <span style={{color: PALETTE.muted, fontSize: 20}}>{chapter}</span>
        </div>
        <span style={{color: PALETTE.muted, fontSize: 18, letterSpacing: 2}}>{index} / 06</span>
      </div>
      {title ? (
        <div
          style={{
            marginTop: 28,
            fontSize: 54,
            lineHeight: 1.16,
            fontWeight: 700,
            letterSpacing: -1.5,
            opacity: enter,
            transform: `translateY(${(1 - enter) * 26}px)`,
          }}
        >
          {title}
        </div>
      ) : null}
      <div style={{position: 'relative', flex: 1, minHeight: 0}}>{children}</div>
    </AbsoluteFill>
  );
};
