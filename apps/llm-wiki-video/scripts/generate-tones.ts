import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const sampleRate = 44_100;
const channels = 2;
const bytesPerSample = 2;

const wavBuffer = (seconds: number, sampleAt: (time: number) => number) => {
  const sampleCount = Math.floor(seconds * sampleRate);
  const dataSize = sampleCount * channels * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(bytesPerSample * 8, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let index = 0; index < sampleCount; index++) {
    const sample = Math.max(-1, Math.min(1, sampleAt(index / sampleRate)));
    const value = Math.round(sample * 32767);
    const offset = 44 + index * channels * bytesPerSample;
    buffer.writeInt16LE(value, offset);
    buffer.writeInt16LE(value, offset + bytesPerSample);
  }
  return buffer;
};

const toneSweep = (seconds: number, fromHz: number, toHz: number, gain: number) =>
  wavBuffer(seconds, (time) => {
    const progress = time / seconds;
    const phase = 2 * Math.PI * (fromHz * time + ((toHz - fromHz) * time * time) / (2 * seconds));
    const envelope = Math.sin(Math.PI * progress) ** 2;
    return Math.sin(phase) * envelope * gain;
  });

const outputDirectory = join(process.cwd(), 'public', 'audio');
await mkdir(outputDirectory, {recursive: true});

const music = wavBuffer(150, (time) => {
  const slowPulse = 0.58 + 0.2 * Math.sin(2 * Math.PI * 0.08 * time);
  const shimmer = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.017 * time + 1.4);
  return (
    Math.sin(2 * Math.PI * 110 * time) * 0.025 * slowPulse +
    Math.sin(2 * Math.PI * 220 * time + 0.4) * 0.013 * slowPulse +
    Math.sin(2 * Math.PI * 330 * time + 1.1) * 0.007 * shimmer
  );
});

await Promise.all([
  writeFile(join(outputDirectory, 'music.wav'), music),
  writeFile(join(outputDirectory, 'connect.wav'), toneSweep(0.7, 410, 720, 0.2)),
  writeFile(join(outputDirectory, 'complete.wav'), toneSweep(0.85, 520, 980, 0.18)),
]);

console.log(`Generated deterministic WAV assets in ${outputDirectory}`);
