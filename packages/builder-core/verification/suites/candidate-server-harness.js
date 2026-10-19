'use strict';

const { spawn } = require('node:child_process');
const { realpathSync } = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const SEATBELT = '/usr/bin/sandbox-exec';
function profileFor(candidateRoot, protectedReadRoots = [], writableRoots = []) {
  const forms = [
    '(version 1)',
    '(allow default)',
    '(deny process-fork)',
    '(deny file-write*)',
    '(allow file-write* (literal "/dev/null"))',
    '(deny network*)',
    '(allow network-inbound (local ip "localhost:*"))',
    '(allow network-outbound (remote ip "localhost:*"))',
  ];
  if (protectedReadRoots.length > 0) {
    forms.push(`(deny file-read* ${protectedReadRoots.map((root) => `(subpath ${JSON.stringify(root)})`).join(' ')})`);
    forms.push('(allow file-read-metadata)');
    forms.push(`(allow file-read* (subpath ${JSON.stringify(candidateRoot)}))`);
  }
  if (writableRoots.length > 0) {
    forms.push(`(allow file-write* ${writableRoots.map((root) => `(subpath ${JSON.stringify(root)})`).join(' ')})`);
  }
  return forms.join(' ');
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

function capture(stream) {
  let output = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    output = `${output}${chunk}`.slice(-4096);
  });
  return () => output;
}

async function waitUntilReady(baseUrl, child, stderr) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`candidate server exited before readiness (code=${child.exitCode}, signal=${child.signalCode}): ${stderr()}`);
    }
    try {
      const response = await fetch(baseUrl);
      if (response.status < 500) return;
    } catch {
      // The child may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`candidate server did not become ready: ${stderr()}`);
}

async function startCandidateServer(candidateRoot = process.cwd(), {
  protectedReadRoots = null,
  writableRoots = [],
  env = {},
} = {}) {
  if (process.platform !== 'darwin') {
    throw new Error('C1 Host verification requires the verified macOS Seatbelt runner.');
  }
  candidateRoot = realpathSync(path.resolve(candidateRoot));
  if (protectedReadRoots === null) {
    const marker = `${path.sep}.builder-mode${path.sep}verification${path.sep}snapshots${path.sep}`;
    const markerIndex = candidateRoot.indexOf(marker);
    const workspaceRoot = markerIndex >= 0 ? candidateRoot.slice(0, markerIndex) : null;
    protectedReadRoots = [workspaceRoot, __dirname].filter(Boolean);
  } else if (!Array.isArray(protectedReadRoots)) {
    throw new TypeError('protectedReadRoots must be an array or null');
  }
  protectedReadRoots = protectedReadRoots.map((root) => realpathSync(path.resolve(root)));
  if (!Array.isArray(writableRoots)) throw new TypeError('writableRoots must be an array');
  writableRoots = writableRoots.map((root) => realpathSync(path.resolve(root)));
  const entry = path.join(candidateRoot, 'server.js');
  const port = await reservePort();
  const child = spawn(SEATBELT, [
    '-p', profileFor(candidateRoot, protectedReadRoots, writableRoots), '--', process.execPath, entry,
  ], {
    cwd: candidateRoot,
    detached: true,
    env: {
      LANG: 'C',
      LC_ALL: 'C',
      PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      PORT: String(port),
      TZ: 'UTC',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = capture(child.stdout);
  const stderr = capture(child.stderr);
  const watchdog = setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already stopped */ }
  }, 50_000);
  watchdog.unref();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitUntilReady(baseUrl, child, stderr);
  } catch (error) {
    clearTimeout(watchdog);
    await stopProcessGroup(child);
    throw error;
  }
  return {
    baseUrl,
    stdout,
    stderr,
    async stop() {
      clearTimeout(watchdog);
      await stopProcessGroup(child);
    },
  };
}

async function stopProcessGroup(child) {
  const ended = () => child.exitCode !== null || child.signalCode !== null;
  if (ended()) return;
  const waitForExit = (timeoutMs) => Promise.race([
    ended()
      ? Promise.resolve()
      : new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already stopped */ }
  await waitForExit(500);
  if (!ended()) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already stopped */ }
    await waitForExit(500);
  }
  if (!ended()) throw new Error('Candidate process stop was not confirmed');
}

module.exports = { profileFor, startCandidateServer };
