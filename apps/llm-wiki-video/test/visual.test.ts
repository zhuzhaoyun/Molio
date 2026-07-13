import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const requiredModules = [
  '../src/Root.tsx',
  '../src/LlmWikiVideo.tsx',
  '../src/theme.ts',
  '../src/components/SceneLayout.tsx',
  '../src/components/KnowledgeCard.tsx',
  '../src/components/KnowledgeGraph.tsx',
  '../src/components/WikiPage.tsx',
  '../src/components/MolioShell.tsx',
  '../src/components/Captions.tsx',
  '../src/scenes/ProblemScene.tsx',
  '../src/scenes/DefinitionScene.tsx',
  '../src/scenes/BuildScene.tsx',
  '../src/scenes/ComparisonScene.tsx',
  '../src/scenes/MolioScene.tsx',
  '../src/scenes/SummaryScene.tsx',
];

test('visual system contains every planned module', () => {
  const missing = requiredModules.filter(
    (modulePath) => !existsSync(fileURLToPath(new URL(modulePath, import.meta.url))),
  );
  assert.deepEqual(missing, []);
});
