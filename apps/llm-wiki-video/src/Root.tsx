import {Composition} from 'remotion';
import {FPS, TOTAL_FRAMES} from './content';
import {LlmWikiVideo} from './LlmWikiVideo';

export const RemotionRoot = () => {
  return (
    <Composition
      id="LlmWikiExplainer"
      component={LlmWikiVideo}
      durationInFrames={TOTAL_FRAMES}
      fps={FPS}
      width={1920}
      height={1080}
    />
  );
};
