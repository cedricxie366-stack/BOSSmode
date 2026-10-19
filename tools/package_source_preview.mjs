import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, existsSync, realpathSync } from 'node:fs';
import { resolve, join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const patterns = [
  ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['token', /(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{20,}/],
  ['home_path', /\/(?:Users|home)\/[^\s/'"\\]+\//],
  ['temporary_path', /\/(?:private\/)?var\/folders\/[a-zA-Z0-9_/-]+/],
];
function safeRelative(name) {
  if (typeof name !== 'string' || isAbsolute(name) || name.includes('\\') || name.split('/').some(p => !p || p === '..' || p === '.')) throw new Error('Invalid release path');
  if (/(^|\/)(?:\.env(?:\.|$)|\.git(?:\/|$)|\.builder-mode(?:\/|$))|\.(?:sqlite|db|log|pem)$/i.test(name)) throw new Error('Runtime/credential file forbidden: ' + name);
}
function regular(root, name) {
  safeRelative(name);
  let cursor = root;
  for (const part of name.split('/')) { cursor = join(cursor, part); if (lstatSync(cursor).isSymbolicLink()) throw new Error('Release symlink rejected: ' + name); }
  if (!lstatSync(cursor).isFile() || lstatSync(cursor).size > 5 * 1024 * 1024) throw new Error('Release file type/size invalid: ' + name);
  return cursor;
}
function walk(root, prefix) {
  const result = [];
  for (const name of readdirSync(join(root,prefix))) {
    const rel = `${prefix}/${name}`;
    const stat = lstatSync(join(root,rel));
    if (stat.isSymbolicLink()) throw new Error('Release symlink rejected: ' + rel);
    if (stat.isDirectory()) result.push(...walk(root,rel)); else result.push(rel);
  }
  return result;
}
export function packagePreview(sourceRoot, destination, kind = 'source') {
  sourceRoot = realpathSync(sourceRoot); destination = resolve(destination);
  if (!['source','runtime'].includes(kind)) throw new Error('Invalid package kind');
  if (existsSync(destination)) throw new Error('Choose a new destination; previous releases remain intact');
  const config = JSON.parse(readFileSync(join(sourceRoot,'release/source-files.json')));
  const allowed = new Set(config.files);
  if (allowed.size !== config.files.length) throw new Error('Duplicate release input');
  for (const file of walk(sourceRoot,'plugins/builder-mode')) if (!allowed.has(file)) throw new Error('Unlisted plugin file: ' + file);
  const plugin = JSON.parse(readFileSync(regular(sourceRoot,'plugins/builder-mode/.codex-plugin/plugin.json')));
  const selected = config.files.filter(file => kind === 'source' || (file.startsWith('plugins/builder-mode/')
    && !file.startsWith('plugins/builder-mode/test/') && !file.startsWith('plugins/builder-mode/scripts/')));
  const entries = selected.map(file => {
    let bytes = readFileSync(regular(sourceRoot,file));
    if (kind === 'runtime' && file === 'plugins/builder-mode/package.json') {
      const pkg = JSON.parse(bytes); delete pkg.scripts; bytes = Buffer.from(JSON.stringify(pkg,null,2)+'\n');
    }
    for (const [category, pattern] of patterns) if (pattern.test(bytes.toString('utf8'))) throw new Error(`Release scan rejected ${category} in ${file}; value suppressed`);
    return { input: file, path: kind === 'source' || file === 'LICENSE' ? file : file.slice('plugins/builder-mode/'.length), bytes };
  });
  if (kind === 'source') for (const [input, output] of Object.entries(config.rootDocuments)) {
    safeRelative(output);
    const original = entries.find(e => e.input === input);
    if (!original) throw new Error('Root document not allowlisted');
    entries.push({ ...original, path: output });
  }
  const folder = kind === 'source' ? 'builder-mode-source' : 'builder-mode';
  const bundle = join(destination,folder); mkdirSync(bundle,{recursive:true});
  const files = [];
  for (const entry of entries) {
    const output = join(bundle,entry.path); mkdirSync(dirname(output),{recursive:true});
    writeFileSync(output,entry.bytes,{flag:'wx',mode:0o644}); files.push({path:entry.path,bytes:entry.bytes.length,sha256:hash(entry.bytes)});
  }
  files.sort((a,b)=>a.path.localeCompare(b.path));
  const manifest = { version:plugin.version,kind,files,publicRelease:false,license:'Apache-2.0',
    privacy:{method:'explicit-file-allowlist-and-pattern-scan',categories:patterns.map(p=>p[0]),userStateIncluded:false,
      limitation:'Not a guarantee of absence of every secret or proof of copyright ownership'},
    validationStatus:'candidate-requires-clean-extraction-test' };
  writeFileSync(join(bundle,'release-files.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  const archive = kind === 'source' ? 'builder-mode-source-preview.tar.gz' : 'builder-mode-local-preview.tar.gz';
  execFileSync('tar',['-czf',join(destination,archive),'-C',destination,folder]);
  const summary = { version:plugin.version,kind,archive,sha256:hash(readFileSync(join(destination,archive))),
    files:files.length,publicRelease:false,license:manifest.license };
  writeFileSync(join(destination,'release.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx'});
  return summary;
}
if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(packagePreview(resolve(import.meta.dirname,'..'),process.argv[2],process.argv[3] ?? 'source')));
}
