import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import * as content from '../src/content';

test('content module exists', () => {
  const contentPath = fileURLToPath(new URL('../src/content.ts', import.meta.url));
  assert.equal(existsSync(contentPath), true);
});

test('video runs for 150 seconds at 30 fps', () => {
  assert.equal(content.FPS, 30);
  assert.equal(content.TOTAL_FRAMES, 4500);
});

test('six scenes cover the timeline without gaps', () => {
  assert.ok(Array.isArray(content.SCENES));
  assert.deepEqual(
    content.SCENES.map((scene) => scene.id),
    ['problem', 'definition', 'build', 'comparison', 'molio', 'summary'],
  );
  assert.equal(content.SCENES[0]?.startFrame, 0);
  assert.equal(content.SCENES.at(-1)?.endFrame, content.TOTAL_FRAMES);
  assert.ok(
    content.SCENES.every(
      (scene, index) => index === 0 || scene.startFrame === content.SCENES[index - 1]?.endFrame,
    ),
  );
});

test('captions are ordered, non-overlapping, and concise', () => {
  assert.ok(Array.isArray(content.CAPTIONS));
  assert.ok(content.CAPTIONS.length > 20);
  assert.ok(
    content.CAPTIONS.every(
      (caption, index) =>
        caption.startMs < caption.endMs &&
        (index === 0 || caption.startMs >= content.CAPTIONS[index - 1]!.endMs),
    ),
  );
  assert.ok(content.CAPTIONS.every((caption) => caption.text.replace(/\s/g, '').length <= 24));
  assert.ok(content.CAPTIONS.at(-1)!.endMs <= 150_000);
});
