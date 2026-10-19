import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(pluginRoot, '..', '..');
const runtimeRoot = path.join(pluginRoot, 'runtime');
const suiteRoot = path.join(runtimeRoot, 'suites');

mkdirSync(suiteRoot, { recursive: true });
for (const [source, destination] of [
  ['packages/builder-core/state/index.js', 'state.cjs'],
  ['packages/builder-core/policy/index.js', 'policy.cjs'],
  ['packages/builder-core/recovery/backup.js', 'backup.cjs'],
  ['control/policy.defaults.json', 'policy.defaults.json'],
  ['packages/builder-core/verification/index.js', 'verification.cjs'],
  ['packages/builder-core/verification/suites/registration-basic.js', 'suites/registration-basic.cjs'],
  ['packages/builder-core/verification/suites/registration.js', 'suites/registration-waitlist.cjs'],
  ['packages/builder-core/verification/suites/registration-persistent.js', 'suites/registration-persistent.cjs'],
  ['packages/builder-core/verification/suites/research-note.js', 'suites/research-note.cjs'],
  ['packages/builder-core/verification/suites/content-brief.js', 'suites/content-brief.cjs'],
  ['packages/builder-core/verification/suites/artifact-data.js', 'suites/artifact-data.cjs'],
  ['packages/builder-core/verification/suites/candidate-server-harness.js', 'suites/candidate-server-harness.js'],
]) {
  copyFileSync(path.join(repositoryRoot, source), path.join(runtimeRoot, destination));
}
writeFileSync(path.join(runtimeRoot, 'package.json'), '{"type":"commonjs"}\n');

const manifest = JSON.parse(readFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
const packagePath = path.join(pluginRoot, 'package.json');
const packageManifest = JSON.parse(readFileSync(packagePath, 'utf8'));
packageManifest.version = manifest.version;
writeFileSync(packagePath, `${JSON.stringify(packageManifest, null, 2)}\n`);

process.stdout.write(`Synced Builder core into ${runtimeRoot}\n`);
