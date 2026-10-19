import { fileURLToPath } from 'node:url';

// Package-relative paths remain correct for local, Git and tarball installs.
// No model, credentials, permissions or existing profile rows are replaced.
export const name = 'builder-mode-paths';
export function apply(ctx) {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 24) throw new Error('Builder Mode needs Node.js 24 or newer. Keep the existing project; select a supported runtime.');
  if (process.platform !== 'darwin') throw new Error('This Builder Mode DSH preview is verified on macOS only.');
  ctx.provide('builderModePaths', Object.freeze({
    node: process.execPath,
    root: fileURLToPath(new URL('.', import.meta.url)),
    server: fileURLToPath(new URL('./server.mjs', import.meta.url)),
    skills: fileURLToPath(new URL('../builder-mode/skills/', import.meta.url)),
  }));
}
