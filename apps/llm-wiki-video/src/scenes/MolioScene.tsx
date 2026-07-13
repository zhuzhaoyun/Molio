import {useCurrentFrame, useVideoConfig} from 'remotion';
import {MolioShell} from '../components/MolioShell';
import {SceneLayout} from '../components/SceneLayout';

export const MolioScene = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const focus = frame < 7 * fps ? 'files' : frame < 14 * fps ? 'status' : frame < 22 * fps ? 'graph' : 'write';
  return (
    <SceneLayout chapter="本地文件，是事实来源" index="05" title="Molio，把这条链路放进一个工作区">
      <div style={{position: 'absolute', left: 0, right: 0, top: 34}}><MolioShell focus={focus} /></div>
    </SceneLayout>
  );
};
