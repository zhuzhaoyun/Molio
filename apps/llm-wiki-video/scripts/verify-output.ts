import assert from 'node:assert/strict';
import {readFile, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {ALL_FORMATS, BufferSource, Input} from 'mediabunny';

const outputPath = join(process.cwd(), 'out', 'llm-wiki-explainer.mp4');
const bytes = await readFile(outputPath);
const input = new Input({formats: ALL_FORMATS, source: new BufferSource(bytes)});

const [duration, videoTracks, audioTracks, fileInfo] = await Promise.all([
  input.computeDuration(),
  input.getVideoTracks(),
  input.getAudioTracks(),
  stat(outputPath),
]);

assert.equal(videoTracks.length, 1, 'expected one video track');
assert.ok(audioTracks.length >= 1, 'expected at least one audio track');

const video = videoTracks[0]!;
const [width, height, codec, packetStats] = await Promise.all([
  video.getDisplayWidth(),
  video.getDisplayHeight(),
  video.getCodec(),
  video.computePacketStats(240),
]);

assert.equal(width, 1920);
assert.equal(height, 1080);
assert.equal(codec, 'avc');
assert.ok(Math.abs(duration - 150) < 0.1, `expected 150 seconds, got ${duration}`);
assert.ok(Math.abs(packetStats.averagePacketRate - 30) < 0.1, `expected 30 fps, got ${packetStats.averagePacketRate}`);

console.log(JSON.stringify({
  path: outputPath,
  bytes: fileInfo.size,
  duration,
  width,
  height,
  frameRate: packetStats.averagePacketRate,
  videoCodec: codec,
  videoTracks: videoTracks.length,
  audioTracks: audioTracks.length,
}, null, 2));
