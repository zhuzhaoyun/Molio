import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('../', import.meta.url));
const toolsPackage = '@deepseek-ai/dsh-tools';
const wrapper = `import type { Context } from '@deepseek-ai/cordis'
export const inject = ['tools']
export async function apply(ctx: Context): Promise<void> {
  const tools = await import(new URL('../src/molio-tools-runtime.mjs', import.meta.url).href)
  tools.apply(ctx)
}
`;

async function replace(file, anchor, replacement) {
  const value = (await readFile(file, 'utf8')).replaceAll('\r\n', '\n');
  if (value.includes(replacement)) return;
  if (value.split(anchor).length !== 2) throw new Error(`Upstream integration point changed: ${file}`);
  await writeFile(file, value.replace(anchor, () => replacement));
}

/** Add the read tools to the host's existing desktop profile and package. */
export async function applyTools(hostRoot) {
  const bundle = join(hostRoot, 'packages/bundle/web-app');
  const manifestFile = join(bundle, 'package.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  manifest.exports['./molio-kb'] = { types: './lib/types/molio-kb.d.ts', default: './lib/molio-kb.js' };
  if (!manifest.files.includes('lib/molio-kb.js')) manifest.files.push('lib/molio-kb.js');
  manifest.dependencies[toolsPackage] = 'workspace:*';
  delete manifest.devDependencies[toolsPackage];
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');

  const lockFile = join(hostRoot, 'pnpm-lock.yaml');
  const lock = (await readFile(lockFile, 'utf8')).replaceAll('\r\n', '\n');
  const importer = lock.match(/^  packages\/bundle\/web-app:\n[\s\S]*?(?=\n  \S)/m)?.[0];
  const dependency = "      '@deepseek-ai/dsh-tools':\n        specifier: workspace:*\n        version: link:../../core/tools\n";
  if (!importer?.includes(dependency)) throw new Error('Missing web-app tools dependency in host lockfile');
  const updated = importer.replace(dependency, '').replace('    dependencies:\n', '    dependencies:\n' + dependency);
  if (updated !== importer) await writeFile(lockFile, lock.replace(importer, () => updated));

  const anchor = '    - id: desktop-product-telemetry';
  await replace(join(bundle, 'cordis.patch.yml'), anchor, [
    '    - id: molio-kb',
    "      name: '@deepseek-ai/dsh-web-app/molio-kb'",
    '      disabled: !!js "ctx.get(\'profileContext\')?.name !== \'desktop\'"',
    '', anchor,
  ].join('\n'));
  await writeFile(join(bundle, 'src/molio-kb.ts'), wrapper);
  const { build } = createRequire(join(root, 'apps/desktop/package.json'))('esbuild');
  // Typert reads src/molio-kb.ts; the host's default tsdown pass emits only index and startup.
  await build({ entryPoints: [join(bundle, 'src/molio-kb.ts')], platform: 'node', format: 'esm',
    outfile: join(bundle, 'lib/molio-kb.js') });
  await build({ entryPoints: [join(root, 'packages/dsh-plugin-molio/src/index.ts')], bundle: true,
    platform: 'node', format: 'esm', external: ['@deepseek-ai/*'], outfile: join(bundle, 'src/molio-tools-runtime.mjs') });
}
