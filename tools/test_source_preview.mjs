import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { packagePreview } from './package_source_preview.mjs';
const original = resolve(import.meta.dirname,'..');
const temp = mkdtempSync(join(tmpdir(),'builder-release-test-'));
try {
  const root = join(temp,'source'); mkdirSync(root);
  const config = JSON.parse(readFileSync(join(original,'release/source-files.json')));
  for (const file of config.files) {
    const output = join(root,file); mkdirSync(resolve(output,'..'),{recursive:true}); cpSync(join(original,file),output);
  }
  const source = packagePreview(root,join(temp,'source-output'),'source');
  assert.equal(source.license,'Apache-2.0'); assert.equal(source.publicRelease,false);
  assert.equal(source.archive.includes(temp),false);
  const runtime = packagePreview(root,join(temp,'runtime-output'),'runtime');
  const pkg = JSON.parse(readFileSync(join(temp,'runtime-output/builder-mode/package.json')));
  assert.equal(pkg.scripts,undefined);
  assert.ok(existsSync(join(temp,'runtime-output/builder-mode/LICENSE')));
  writeFileSync(join(root,'plugins/builder-mode/.env'),'synthetic');
  assert.throws(()=>packagePreview(root,join(temp,'extra-output')),/Unlisted plugin file/);
  rmSync(join(root,'plugins/builder-mode/.env'));
  const readme = join(root,'plugins/builder-mode/README.md');
  const before = readFileSync(readme);
  writeFileSync(readme,'sk-'+'proj-'+'x'.repeat(32));
  assert.throws(()=>packagePreview(root,join(temp,'token-output')),/token/);
  writeFileSync(readme,'sk-'+'y'.repeat(32));
  assert.throws(()=>packagePreview(root,join(temp,'general-token-output')),/token/);
  writeFileSync(readme,before);
  rmSync(readme); symlinkSync(join(root,'LICENSE'),readme);
  assert.throws(()=>packagePreview(root,join(temp,'link-output')),/symlink/);
  console.log(JSON.stringify({status:'passed',cases:['source-license-and-relative-manifest','runtime-no-broken-development-scripts','unexpected-plugin-file','token-pattern','symlink'],sourceFiles:source.files,runtimeFiles:runtime.files}));
} finally { rmSync(temp,{recursive:true,force:true}); }
