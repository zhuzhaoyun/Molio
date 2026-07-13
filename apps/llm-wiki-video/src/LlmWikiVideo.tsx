import {Audio} from '@remotion/media';
import {AbsoluteFill, interpolate, Sequence, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {Captions} from './components/Captions';
import {CAPTIONS, FPS, SCENES, TOTAL_FRAMES} from './content';
import {BuildScene} from './scenes/BuildScene';
import {ComparisonScene} from './scenes/ComparisonScene';
import {DefinitionScene} from './scenes/DefinitionScene';
import {MolioScene} from './scenes/MolioScene';
import {ProblemScene} from './scenes/ProblemScene';
import {SummaryScene} from './scenes/SummaryScene';
import {EASE_OUT, PALETTE} from './theme';

const sceneComponents = {
  problem: ProblemScene,
  definition: DefinitionScene,
  build: BuildScene,
  comparison: ComparisonScene,
  molio: MolioScene,
  summary: SummaryScene,
} as const;

const LineWipe = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const progress = interpolate(frame, [0, 0.55 * fps], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: EASE_OUT,
  });
  return (
    <AbsoluteFill style={{pointerEvents: 'none'}}>
      <div style={{position: 'absolute', top: 0, bottom: 0, left: `${progress * 118 - 18}%`, width: '18%', background: `linear-gradient(90deg, transparent, ${PALETTE.accent}, transparent)`, opacity: 0.28}} />
    </AbsoluteFill>
  );
};

export const LlmWikiVideo = () => {
  return (
    <AbsoluteFill style={{backgroundColor: PALETTE.background}}>
      {SCENES.map((scene) => {
        const Scene = sceneComponents[scene.id];
        return (
          <Sequence
            key={scene.id}
            from={scene.startFrame}
            durationInFrames={scene.endFrame - scene.startFrame}
            premountFor={FPS}
          >
            <Scene />
          </Sequence>
        );
      })}
      {SCENES.slice(1).map((scene) => (
        <Sequence key={`wipe-${scene.id}`} from={scene.startFrame} durationInFrames={18} premountFor={FPS}>
          <LineWipe />
        </Sequence>
      ))}
      <Audio src={staticFile('audio/voiceover.mp3')} volume={1} />
      <Audio
        src={staticFile('audio/music.wav')}
        volume={(frame) =>
          interpolate(frame, [0, FPS, TOTAL_FRAMES - FPS, TOTAL_FRAMES], [0, 0.11, 0.11, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          })
        }
      />
      <Sequence from={1050} durationInFrames={45} premountFor={FPS}>
        <Audio src={staticFile('audio/connect.wav')} volume={0.2} />
      </Sequence>
      <Sequence from={2230} durationInFrames={45} premountFor={FPS}>
        <Audio src={staticFile('audio/complete.wav')} volume={0.18} />
      </Sequence>
      <Sequence from={3150} durationInFrames={45} premountFor={FPS}>
        <Audio src={staticFile('audio/connect.wav')} volume={0.16} />
      </Sequence>
      <Captions captions={CAPTIONS} />
    </AbsoluteFill>
  );
};
