'use strict';

const { createHash, randomUUID } = require('node:crypto');
const {
  chmodSync,
  closeSync,
  constants: fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} = require('node:fs');
const { platform, arch } = require('node:os');
const {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} = require('node:path');
const { spawnSync } = require('node:child_process');

const REPORT_SCHEMA_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;

class VerificationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'VerificationError';
    this.code = code;
    Object.assign(this, details);
  }
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function isWithin(parent, child) {
  const fromParent = relative(parent, child);
  return fromParent === ''
    || (fromParent !== '..' && !fromParent.startsWith(`..${sep}`) && !isAbsolute(fromParent));
}

function pathsOverlap(left, right) {
  return isWithin(left, right) || isWithin(right, left);
}

function canonicalDirectory(pathname, name, { create = false } = {}) {
  requiredString(pathname, name);
  const absolute = resolve(pathname);
  if (create) mkdirSync(absolute, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(absolute);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new VerificationError('HOST_ROOT_INVALID', `${name} must be a real directory`);
  }
  return realpathSync(absolute);
}

function normalizeManifestPath(value, name) {
  requiredString(value, name);
  if (isAbsolute(value) || value.split(/[\\/]+/u).includes('..')) {
    throw new VerificationError(
      'CANDIDATE_PATH_INVALID',
      `${name} must be a relative path without parent traversal`,
    );
  }
  const normalized = value.split(/[\\/]+/u).filter((part) => part && part !== '.').join('/');
  if (!normalized) {
    throw new VerificationError('CANDIDATE_PATH_INVALID', `${name} must identify a file`);
  }
  return normalized;
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function manifestDigest(files) {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.path);
    hash.update('\0');
    hash.update(file.sha256);
    hash.update('\0');
    hash.update(String(file.bytes));
    hash.update('\n');
  }
  return `sha256:${hash.digest('hex')}`;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertRegularUnlinked(metadata, code, pathname) {
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new VerificationError(code, `expected a regular non-symlink file: ${pathname}`, {
      path: pathname,
    });
  }
}

function readDescriptor(descriptor, onChunk) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let bytes = 0;
  for (;;) {
    const count = readSync(descriptor, buffer, 0, buffer.length, null);
    if (count === 0) break;
    const chunk = buffer.subarray(0, count);
    hash.update(chunk);
    bytes += count;
    if (onChunk) onChunk(chunk);
  }
  return { sha256: hash.digest('hex'), bytes };
}

function writeAll(descriptor, chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    offset += writeSync(descriptor, chunk, offset, chunk.length - offset);
  }
}

function hashFileNoFollow(pathname, boundary, errorCode) {
  const before = lstatSync(pathname, { bigint: true });
  assertRegularUnlinked(before, errorCode, pathname);
  const canonical = realpathSync(pathname);
  if (!isWithin(boundary, canonical)) {
    throw new VerificationError(errorCode, `file resolves outside its Host boundary: ${pathname}`);
  }

  let descriptor;
  try {
    descriptor = openSync(pathname, fsConstants.O_RDONLY | NO_FOLLOW);
    const opened = fstatSync(descriptor, { bigint: true });
    assertRegularUnlinked(opened, errorCode, pathname);
    if (!sameIdentity(before, opened)) {
      throw new VerificationError(errorCode, `file changed before it could be opened: ${pathname}`);
    }
    const result = readDescriptor(descriptor);
    const afterRead = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(opened, afterRead)
      || opened.size !== afterRead.size
      || opened.mtimeNs !== afterRead.mtimeNs
      || opened.ctimeNs !== afterRead.ctimeNs) {
      throw new VerificationError(errorCode, `file changed while it was being read: ${pathname}`);
    }
    const afterPath = lstatSync(pathname, { bigint: true });
    if (!sameIdentity(opened, afterPath) || !isWithin(boundary, realpathSync(pathname))) {
      throw new VerificationError(errorCode, `file path changed while it was being read: ${pathname}`);
    }
    return result;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertManifestPathUnlinked(workspacePath, relativePath) {
  let cursor = workspacePath;
  const parts = relativePath.split('/');
  for (let index = 0; index < parts.length; index += 1) {
    cursor = join(cursor, parts[index]);
    const metadata = lstatSync(cursor);
    if (metadata.isSymbolicLink()) {
      throw new VerificationError(
        'CANDIDATE_TREE_UNSAFE',
        `candidate path contains a symlink: ${relativePath}`,
      );
    }
    if (index < parts.length - 1 && !metadata.isDirectory()) {
      throw new VerificationError(
        'CANDIDATE_TREE_UNSAFE',
        `candidate path contains a non-directory parent: ${relativePath}`,
      );
    }
  }
}

function enumerateRegularFiles(root, errorCode) {
  const files = [];
  function walk(directory, relativeDirectory) {
    const before = lstatSync(directory, { bigint: true });
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw new VerificationError(errorCode, `directory tree contains a symlink or special entry: ${directory}`);
    }
    const canonical = realpathSync(directory);
    if (!isWithin(root, canonical)) {
      throw new VerificationError(errorCode, `directory tree escapes its root: ${directory}`);
    }
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const metadata = lstatSync(absolute);
      if (metadata.isSymbolicLink()) {
        throw new VerificationError(errorCode, `directory tree contains a symlink: ${relativePath}`);
      }
      if (metadata.isDirectory()) {
        walk(absolute, relativePath);
      } else if (metadata.isFile()) {
        const hashed = hashFileNoFollow(absolute, root, errorCode);
        files.push(Object.freeze({ path: relativePath, ...hashed }));
      } else {
        throw new VerificationError(errorCode, `directory tree contains a special file: ${relativePath}`);
      }
    }
    const after = lstatSync(directory, { bigint: true });
    if (!sameIdentity(before, after)) {
      throw new VerificationError(errorCode, `directory changed while it was scanned: ${directory}`);
    }
  }
  walk(root, '');
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

function validateCandidateManifest(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    throw new TypeError('candidate must be a frozen candidate manifest');
  }
  const workspacePath = canonicalDirectory(candidate.workspacePath, 'candidate.workspacePath');
  if (!Array.isArray(candidate.files) || candidate.files.length === 0) {
    throw new VerificationError('CANDIDATE_MANIFEST_EMPTY', 'candidate.files must contain file evidence');
  }
  const seen = new Set();
  const files = candidate.files.map((raw, index) => {
    const path = normalizeManifestPath(raw?.path, `candidate.files[${index}].path`);
    if (seen.has(path)) {
      throw new VerificationError('CANDIDATE_MANIFEST_DUPLICATE', `duplicate candidate path: ${path}`);
    }
    seen.add(path);
    if (typeof raw.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(raw.sha256)) {
      throw new TypeError(`candidate.files[${index}].sha256 must be a lowercase SHA-256 hex digest`);
    }
    if (!Number.isSafeInteger(raw.bytes) || raw.bytes < 0) {
      throw new TypeError(`candidate.files[${index}].bytes must be a non-negative safe integer`);
    }
    return Object.freeze({ path, sha256: raw.sha256, bytes: raw.bytes });
  }).sort((left, right) => left.path.localeCompare(right.path));
  const digest = manifestDigest(files);
  if (candidate.candidateDigest !== digest) {
    throw new VerificationError('CANDIDATE_DIGEST_MISMATCH', 'candidateDigest does not match its file manifest');
  }
  return Object.freeze({ workspacePath, files: Object.freeze(files), candidateDigest: digest });
}

function buildCandidateManifest(workspacePath) {
  const canonical = canonicalDirectory(workspacePath, 'candidate.workspacePath');
  const files = Object.freeze(enumerateRegularFiles(canonical, 'CANDIDATE_TREE_UNSAFE'));
  if (files.length === 0) {
    throw new VerificationError('CANDIDATE_MANIFEST_EMPTY', 'candidate workspace contains no files');
  }
  return Object.freeze({
    workspacePath: canonical,
    files,
    candidateDigest: manifestDigest(files),
  });
}

function assertExactInventory(workspacePath, expectedFiles) {
  const actual = enumerateRegularFiles(workspacePath, 'CANDIDATE_TREE_UNSAFE');
  if (actual.length !== expectedFiles.length
    || actual.some((file, index) => (
      file.path !== expectedFiles[index].path
      || file.sha256 !== expectedFiles[index].sha256
      || file.bytes !== expectedFiles[index].bytes
    ))) {
    throw new VerificationError(
      'CANDIDATE_INVENTORY_CHANGED',
      'candidate file paths or contents no longer match the frozen manifest',
    );
  }
}

function copyManifestFile(source, destination, workspacePath, expected) {
  assertManifestPathUnlinked(workspacePath, expected.path);
  const parent = dirname(source);
  const parentCanonical = realpathSync(parent);
  if (!isWithin(workspacePath, parentCanonical)) {
    throw new VerificationError('CANDIDATE_PATH_ESCAPE', `candidate parent escapes workspace: ${expected.path}`);
  }
  const before = lstatSync(source, { bigint: true });
  assertRegularUnlinked(before, 'CANDIDATE_TREE_UNSAFE', expected.path);

  let sourceDescriptor;
  let destinationDescriptor;
  try {
    sourceDescriptor = openSync(source, fsConstants.O_RDONLY | NO_FOLLOW);
    const opened = fstatSync(sourceDescriptor, { bigint: true });
    assertRegularUnlinked(opened, 'CANDIDATE_TREE_UNSAFE', expected.path);
    if (!sameIdentity(before, opened)) {
      throw new VerificationError('CANDIDATE_CHANGED_DURING_COPY', `candidate changed before copy: ${expected.path}`);
    }
    destinationDescriptor = openSync(
      destination,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    const copied = readDescriptor(sourceDescriptor, (chunk) => writeAll(destinationDescriptor, chunk));
    fsyncSync(destinationDescriptor);
    const afterRead = fstatSync(sourceDescriptor, { bigint: true });
    if (!sameIdentity(opened, afterRead)
      || opened.size !== afterRead.size
      || opened.mtimeNs !== afterRead.mtimeNs
      || opened.ctimeNs !== afterRead.ctimeNs) {
      throw new VerificationError('CANDIDATE_CHANGED_DURING_COPY', `candidate changed during copy: ${expected.path}`);
    }
    if (copied.sha256 !== expected.sha256 || copied.bytes !== expected.bytes) {
      throw new VerificationError('CANDIDATE_FILE_MISMATCH', `candidate file differs from manifest: ${expected.path}`);
    }
  } finally {
    if (destinationDescriptor !== undefined) closeSync(destinationDescriptor);
    if (sourceDescriptor !== undefined) closeSync(sourceDescriptor);
  }

  assertManifestPathUnlinked(workspacePath, expected.path);
  const afterPath = lstatSync(source, { bigint: true });
  const expectedCanonical = join(workspacePath, ...expected.path.split('/'));
  if (!sameIdentity(before, afterPath) || realpathSync(source) !== expectedCanonical) {
    throw new VerificationError('CANDIDATE_CHANGED_DURING_COPY', `candidate path changed during copy: ${expected.path}`);
  }
  const copied = hashFileNoFollow(destination, dirname(destination), 'SNAPSHOT_COPY_INVALID');
  if (copied.sha256 !== expected.sha256 || copied.bytes !== expected.bytes) {
    throw new VerificationError('SNAPSHOT_COPY_INVALID', `snapshot copy differs from manifest: ${expected.path}`);
  }
}

function makeReadOnlySnapshot(snapshotRoot, candidate) {
  const safeAttempt = candidate.attemptId.replace(/[^a-zA-Z0-9_.-]/gu, '_').slice(0, 80) || 'attempt';
  const snapshotPath = join(snapshotRoot, `${safeAttempt}-${randomUUID()}`);
  mkdirSync(snapshotPath, { mode: 0o700 });
  const directories = new Set([snapshotPath]);
  try {
    assertExactInventory(candidate.workspacePath, candidate.files);
    for (const file of candidate.files) {
      const destination = join(snapshotPath, ...file.path.split('/'));
      const destinationParent = dirname(destination);
      mkdirSync(destinationParent, { recursive: true, mode: 0o700 });
      let cursor = destinationParent;
      while (isWithin(snapshotPath, cursor)) {
        directories.add(cursor);
        if (cursor === snapshotPath) break;
        cursor = dirname(cursor);
      }
      copyManifestFile(
        join(candidate.workspacePath, ...file.path.split('/')),
        destination,
        candidate.workspacePath,
        file,
      );
    }
    assertExactInventory(candidate.workspacePath, candidate.files);
    const snapshotFiles = enumerateRegularFiles(snapshotPath, 'SNAPSHOT_COPY_INVALID');
    if (manifestDigest(snapshotFiles) !== candidate.candidateDigest) {
      throw new VerificationError('SNAPSHOT_DIGEST_MISMATCH', 'snapshot digest differs from candidate digest');
    }
    for (const file of candidate.files) {
      chmodSync(join(snapshotPath, ...file.path.split('/')), 0o444);
    }
    for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
      chmodSync(directory, 0o555);
    }
    return snapshotPath;
  } catch (error) {
    try {
      for (const directory of [...directories].sort((left, right) => left.length - right.length)) {
        chmodSync(directory, 0o700);
      }
      rmSync(snapshotPath, { recursive: true, force: true });
    } catch {
      // Preserve the original integrity failure; the unique partial path is never executed.
    }
    throw error;
  }
}

function outputEvidence(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value ?? '');
  return Object.freeze({
    bytes: buffer.length,
    sha256: sha256(buffer),
    redactedSummary: buffer.length === 0
      ? 'no output captured'
      : `${buffer.length} bytes captured; content omitted by Host`,
  });
}

function commandDigest(command, args) {
  return sha256(Buffer.from(JSON.stringify({ command, args })));
}

function freezeCheck(raw, index, suiteRoot) {
  if (!raw || typeof raw !== 'object') throw new TypeError(`checks[${index}] must be an object`);
  const id = requiredString(raw.id, `checks[${index}].id`);
  const command = realpathSync(requiredString(raw.command, `checks[${index}].command`));
  if (!statSync(command).isFile()) throw new TypeError(`checks[${index}].command must be a file`);
  const args = raw.args === undefined ? [] : raw.args;
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) {
    throw new TypeError(`checks[${index}].args must be an array of strings`);
  }
  if (args.some((value) => !value.startsWith('-'))) {
    throw new VerificationError(
      'CHECK_ARGUMENT_UNSAFE',
      `checks[${index}].args may contain only fixed option flags; use suiteFiles for test paths`,
    );
  }
  if (!Array.isArray(raw.suiteFiles) || raw.suiteFiles.length === 0) {
    throw new TypeError(`checks[${index}].suiteFiles must identify at least one Host suite file`);
  }
  const suiteFiles = raw.suiteFiles.map((value, suiteIndex) => {
    const normalized = normalizeManifestPath(value, `checks[${index}].suiteFiles[${suiteIndex}]`);
    const absolute = join(suiteRoot, ...normalized.split('/'));
    const metadata = lstatSync(absolute);
    assertRegularUnlinked(metadata, 'TEST_SUITE_UNSAFE', normalized);
    if (!isWithin(suiteRoot, realpathSync(absolute))) {
      throw new VerificationError('TEST_SUITE_UNSAFE', `suite file escapes suiteRoot: ${normalized}`);
    }
    return absolute;
  });
  const actualArgs = Object.freeze([...args, ...suiteFiles]);
  const timeoutMs = raw.timeoutMs === undefined
    ? DEFAULT_TIMEOUT_MS
    : positiveInteger(raw.timeoutMs, `checks[${index}].timeoutMs`);
  return Object.freeze({
    id,
    command,
    args: actualArgs,
    suiteFiles: Object.freeze([...suiteFiles]),
    required: raw.required !== false,
    timeoutMs,
    digest: commandDigest(command, actualArgs),
  });
}

function atomicWriteJson(reportRoot, filename, report) {
  const destination = join(reportRoot, filename);
  const temporary = join(reportRoot, `.${filename}.${randomUUID()}.tmp`);
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  let descriptor;
  try {
    descriptor = openSync(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    writeAll(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, destination);
    chmodSync(destination, 0o444);
    return destination;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try { rmSync(temporary, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

function validateBinding(request) {
  const binding = {};
  for (const name of [
    'projectId',
    'taskId',
    'attemptId',
    'codeDigest',
    'inputDigest',
    'environmentDigest',
  ]) {
    binding[name] = requiredString(request[name], name);
  }
  binding.goalRevision = positiveInteger(request.goalRevision, 'goalRevision');
  binding.contractRevision = positiveInteger(request.contractRevision, 'contractRevision');
  return binding;
}

class HostVerificationService {
  #snapshotRoot;
  #suiteRoot;
  #reportRoot;
  #suiteManifest;
  #suiteDigest;
  #checks;
  #environment;
  #isolation;
  #maxOutputBytes;

  constructor({
    snapshotRoot,
    suiteRoot,
    reportRoot,
    checks = [],
    environment = { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
    isolation = null,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  }) {
    this.#snapshotRoot = canonicalDirectory(snapshotRoot, 'snapshotRoot', { create: true });
    this.#suiteRoot = canonicalDirectory(suiteRoot, 'suiteRoot');
    this.#reportRoot = canonicalDirectory(reportRoot, 'reportRoot', { create: true });
    if (pathsOverlap(this.#snapshotRoot, this.#suiteRoot)
      || pathsOverlap(this.#snapshotRoot, this.#reportRoot)
      || pathsOverlap(this.#suiteRoot, this.#reportRoot)) {
      throw new VerificationError(
        'HOST_BOUNDARIES_OVERLAP',
        'snapshotRoot, suiteRoot, and reportRoot must be pairwise disjoint',
      );
    }
    if (!Array.isArray(checks)) throw new TypeError('checks must be an array');
    this.#checks = Object.freeze(checks.map((check, index) => freezeCheck(check, index, this.#suiteRoot)));
    if (new Set(this.#checks.map((check) => check.id)).size !== this.#checks.length) {
      throw new TypeError('check ids must be unique');
    }
    if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
      throw new TypeError('environment must be an object');
    }
    const entries = Object.entries(environment);
    if (entries.some(([key, value]) => !key || typeof value !== 'string')) {
      throw new TypeError('environment keys and values must be strings');
    }
    this.#environment = Object.freeze(Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))));
    if (isolation !== null && (typeof isolation !== 'object' || Array.isArray(isolation))) {
      throw new TypeError('isolation must be an object or null');
    }
    this.#isolation = isolation === null ? null : Object.freeze({ ...isolation });
    this.#maxOutputBytes = positiveInteger(maxOutputBytes, 'maxOutputBytes');
    this.#suiteManifest = Object.freeze(enumerateRegularFiles(this.#suiteRoot, 'TEST_SUITE_UNSAFE'));
    this.#suiteDigest = manifestDigest(this.#suiteManifest);
  }

  get testSuiteDigest() {
    return this.#suiteDigest;
  }

  verify(request) {
    if (!request || typeof request !== 'object') throw new TypeError('request must be an object');
    const binding = validateBinding(request);
    const manifest = validateCandidateManifest(request.candidate);
    const verifierPath = realpathSync(__filename);
    if (pathsOverlap(manifest.workspacePath, this.#snapshotRoot)
      || pathsOverlap(manifest.workspacePath, this.#suiteRoot)
      || pathsOverlap(manifest.workspacePath, this.#reportRoot)
      || isWithin(manifest.workspacePath, verifierPath)) {
      throw new VerificationError(
        'UNTRUSTED_VERIFIER_BOUNDARY',
        'candidate, snapshot, verifier, and test suite boundaries must be disjoint',
      );
    }
    for (const check of this.#checks) {
      if (isWithin(manifest.workspacePath, check.command)) {
        throw new VerificationError(
          'UNTRUSTED_CHECK_COMMAND',
          `check executable is inside the candidate workspace: ${check.id}`,
        );
      }
    }

    const freshSuiteManifest = enumerateRegularFiles(this.#suiteRoot, 'TEST_SUITE_UNSAFE');
    if (manifestDigest(freshSuiteManifest) !== this.#suiteDigest) {
      throw new VerificationError('TEST_SUITE_CHANGED', 'Host test suite changed after its digest was fixed');
    }

    if (request.runCheckIds !== undefined
      && (!Array.isArray(request.runCheckIds)
        || request.runCheckIds.some((id) => typeof id !== 'string'))) {
      throw new TypeError('runCheckIds must be an array of check ids');
    }
    const requestedIds = request.runCheckIds === undefined
      ? new Set(this.#checks.map((check) => check.id))
      : new Set(request.runCheckIds);
    for (const id of requestedIds) {
      if (!this.#checks.some((check) => check.id === id)) {
        throw new VerificationError('CHECK_NOT_ALLOWLISTED', `check is not allowlisted: ${id}`);
      }
    }

    const startedAt = new Date().toISOString();
    const snapshotPath = makeReadOnlySnapshot(this.#snapshotRoot, {
      ...manifest,
      attemptId: binding.attemptId,
    });

    const checkResults = [];
    for (const check of this.#checks) {
      if (!requestedIds.has(check.id)) {
        checkResults.push(Object.freeze({
          id: check.id,
          required: check.required,
          status: 'not_run',
          commandDigest: check.digest,
          exitCode: null,
          signal: null,
          stdout: outputEvidence(Buffer.alloc(0)),
          stderr: outputEvidence(Buffer.alloc(0)),
        }));
        continue;
      }
      const checkStartedAt = new Date().toISOString();
      const executed = spawnSync(check.command, check.args, {
        cwd: snapshotPath,
        env: this.#environment,
        shell: false,
        timeout: check.timeoutMs,
        maxBuffer: this.#maxOutputBytes,
        windowsHide: true,
      });
      const exitCode = Number.isInteger(executed.status) ? executed.status : null;
      checkResults.push(Object.freeze({
        id: check.id,
        required: check.required,
        status: exitCode === 0 && !executed.error ? 'passed' : 'failed',
        command: check.command,
        args: check.args,
        commandDigest: check.digest,
        startedAt: checkStartedAt,
        completedAt: new Date().toISOString(),
        exitCode,
        signal: executed.signal ?? null,
        errorCode: executed.error?.code ?? null,
        stdout: outputEvidence(executed.stdout),
        stderr: outputEvidence(executed.stderr),
      }));
    }

    const suiteAfter = enumerateRegularFiles(this.#suiteRoot, 'TEST_SUITE_UNSAFE');
    const suiteIntegrity = manifestDigest(suiteAfter) === this.#suiteDigest ? 'passed' : 'failed';
    const required = checkResults.filter((check) => check.required);
    let status;
    if (suiteIntegrity === 'failed' || required.some((check) => check.status === 'failed')) {
      status = 'failed';
    } else if (required.length === 0 || required.some((check) => check.status === 'not_run')) {
      status = 'not_run';
    } else {
      status = 'passed';
    }

    const verificationId = randomUUID();
    const reportFilename = `verification-${binding.attemptId.replace(/[^a-zA-Z0-9_.-]/gu, '_')}-${verificationId}.json`;
    const report = Object.freeze({
      schemaVersion: REPORT_SCHEMA_VERSION,
      verificationId,
      status,
      startedAt,
      completedAt: new Date().toISOString(),
      binding: Object.freeze({
        ...binding,
        candidateDigest: manifest.candidateDigest,
        testSuiteDigest: this.#suiteDigest,
        runtimeEnvironmentDigest: sha256(Buffer.from(JSON.stringify(this.#environment))),
      }),
      verifier: Object.freeze({
        path: verifierPath,
        sha256: `sha256:${hashFileNoFollow(verifierPath, dirname(verifierPath), 'VERIFIER_CHANGED').sha256}`,
      }),
      hostContext: request.hostContext && typeof request.hostContext === 'object'
        ? Object.freeze({ ...request.hostContext })
        : null,
      candidate: Object.freeze({
        workspacePath: manifest.workspacePath,
        snapshotPath,
        candidateDigest: manifest.candidateDigest,
        files: manifest.files,
      }),
      testSuite: Object.freeze({
        suiteRoot: this.#suiteRoot,
        testSuiteDigest: this.#suiteDigest,
        files: this.#suiteManifest,
        integrity: suiteIntegrity,
      }),
      checks: Object.freeze(checkResults),
      runtime: Object.freeze({
        node: process.version,
        platform: platform(),
        arch: arch(),
      }),
      limits: Object.freeze({
        shell: false,
        maxOutputBytes: this.#maxOutputBytes,
        networkIsolation: this.#isolation?.network ?? 'not_enforced',
        candidateFilesystem: this.#isolation?.filesystem ?? 'Host-owned read-only snapshot only',
        processIsolation: this.#isolation?.process ?? 'not_enforced',
        isolationProvider: this.#isolation?.provider ?? 'none',
        testSuiteTrust: 'Host-controlled external suiteRoot with fixed digest',
      }),
      untrustedWorkerClaimsUsed: false,
    });
    const reportPath = atomicWriteJson(this.#reportRoot, reportFilename, report);
    return Object.freeze({ report, reportPath, snapshotPath });
  }
}

module.exports = {
  HostVerificationService,
  VerificationError,
  buildCandidateManifest,
  manifestDigest,
};
