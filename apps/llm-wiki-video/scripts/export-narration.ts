import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {SCENES} from '../src/content';

const outputDirectory = join(process.cwd(), 'public', 'audio', 'narration');
await mkdir(outputDirectory, {recursive: true});

await Promise.all(
  SCENES.map((scene) => writeFile(join(outputDirectory, `${scene.id}.txt`), scene.narration, 'utf8')),
);

console.log(`Exported ${SCENES.length} narration files to ${outputDirectory}`);
