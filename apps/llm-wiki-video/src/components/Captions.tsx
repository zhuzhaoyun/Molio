import {createTikTokStyleCaptions, type Caption, type TikTokPage} from '@remotion/captions';
import {useMemo} from 'react';
import {AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig} from 'remotion';
import {FONT_FAMILY, PALETTE} from '../theme';

const SWITCH_CAPTIONS_EVERY_MS = 1800;

const CaptionPage = ({page}: {page: TikTokPage}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const absoluteTimeMs = page.startMs + (frame / fps) * 1000;

  return (
    <AbsoluteFill style={{justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 48}}>
      <div
        style={{
          maxWidth: 1320,
          padding: '12px 24px 14px',
          borderRadius: 12,
          backgroundColor: 'rgba(8,10,15,0.78)',
          color: PALETTE.text,
          fontFamily: FONT_FAMILY,
          fontSize: 34,
          lineHeight: 1.45,
          fontWeight: 650,
          textAlign: 'center',
          whiteSpace: 'pre-wrap',
          textShadow: '0 3px 18px rgba(0,0,0,0.7)',
        }}
      >
        {page.tokens.map((token) => {
          const active = token.fromMs <= absoluteTimeMs && token.toMs > absoluteTimeMs;
          return <span key={`${token.fromMs}-${token.text}`} style={{color: active ? '#C4B5FD' : PALETTE.text}}>{token.text}</span>;
        })}
      </div>
    </AbsoluteFill>
  );
};

export const Captions = ({captions}: {captions: readonly Caption[]}) => {
  const {fps} = useVideoConfig();
  const {pages} = useMemo(
    () => createTikTokStyleCaptions({captions: [...captions], combineTokensWithinMilliseconds: SWITCH_CAPTIONS_EVERY_MS}),
    [captions],
  );

  return (
    <AbsoluteFill>
      {pages.map((page, index) => {
        const nextPage = pages[index + 1];
        const startFrame = Math.round((page.startMs / 1000) * fps);
        const finalMs = nextPage?.startMs ?? page.tokens.at(-1)?.toMs ?? page.startMs + SWITCH_CAPTIONS_EVERY_MS;
        const endFrame = Math.round((finalMs / 1000) * fps);
        const durationInFrames = Math.max(1, endFrame - startFrame);
        return (
          <Sequence key={`${page.startMs}-${index}`} from={startFrame} durationInFrames={durationInFrames} premountFor={fps}>
            <CaptionPage page={page} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
