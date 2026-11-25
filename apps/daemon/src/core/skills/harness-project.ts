import fs from 'node:fs';
import path from 'node:path';
import { BUILTIN_SKILLS, resolveSkillsSourceDir } from '../skill-installer.js';
import { copyDirSync } from './dirsync.js';

/** Provision complete, editable skill bundles in DSH's project-agents discovery root. */
export function installHarnessProjectSkills(vault: string): void {
  if (!fs.statSync(vault, { throwIfNoEntry: false })?.isDirectory()) return;
  let root = path.resolve(vault);
  for (const segment of ['.agents', 'skills']) {
    root = path.join(root, segment);
    fs.mkdirSync(root, { recursive: true });
    if (!fs.lstatSync(root).isDirectory()) throw new Error('Expected a project directory: ' + root);
  }

  const source = resolveSkillsSourceDir();
  for (const name of BUILTIN_SKILLS) {
    const dest = path.join(root, name);
    // DSH also supports flat <name>.md skills. Preserve both forms of user overrides.
    if ([dest, dest + '.md'].some(p => fs.lstatSync(p, { throwIfNoEntry: false }))) continue;
    const stage = fs.mkdtempSync(path.join(path.dirname(root), '.molio-skill-'));
    try {
      copyDirSync(path.join(source, name), stage);
      fs.renameSync(stage, dest);
    } catch (err) {
      if (!fs.existsSync(dest)) throw err;
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  }
  const marker = path.join(path.dirname(root), '.molio-vault');
  try {
    fs.writeFileSync(marker, '', { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}
