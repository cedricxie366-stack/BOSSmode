'use strict';

const { backup, DatabaseSync } = require('node:sqlite');
const { createHash } = require('node:crypto');
const { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, realpathSync, readdirSync } = require('node:fs');
const { join, resolve, dirname, relative, isAbsolute } = require('node:path');
const { buildCandidateManifest } = require(existsSync(join(__dirname, 'verification.cjs')) ? './verification.cjs' : '../verification');

function digest(path) {
  return 'sha256:' + createHash('sha256').update(readFileSync(path)).digest('hex');
}
function validDatabase(filename) {
  if (lstatSync(filename).isSymbolicLink()) throw new Error('Database symlinks are not allowed');
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Database integrity failed');
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Database foreign key check failed');
    return {
      schema: db.prepare('SELECT MAX(schema_version) AS version FROM schema_meta').get().version,
      projects: db.prepare('SELECT project_id, state_revision, owner_epoch FROM projects ORDER BY project_id').all(),
    };
  } finally { db.close(); }
}

async function backupBuilderState(source, destination) {
  if (lstatSync(source).isSymbolicLink()) throw new Error('Database symlinks are not allowed');
  source = realpathSync(source);
  destination = resolve(destination);
  if (existsSync(destination)) throw new Error('Backup destination already exists');
  validDatabase(source);
  mkdirSync(destination, { recursive: false, mode: 0o700 });
  const db = new DatabaseSync(source, { readOnly: true });
  const filename = join(destination, 'state.sqlite');
  try { await backup(db, filename); } finally { db.close(); }
  const metadata = validDatabase(filename);
  const manifest = {
    format: 'builder-state-backup-v1', ...metadata,
    createdAt: new Date().toISOString(), digest: digest(filename),
    scope: 'Builder control state only; business data, source code and evidence files remain separate assets',
    excluded: ['policy.sqlite', 'verification-operations.sqlite', 'product code', 'business data', 'evidence files'],
  };
  writeFileSync(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return manifest;
}

// Restores to a NEW directory only. Never replaces a live database.
// Operator must bring the corresponding versioned code/evidence separately.
async function restoreBuilderState(source, destination) {
  if (lstatSync(source).isSymbolicLink() || lstatSync(join(source, 'manifest.json')).isSymbolicLink()
      || lstatSync(join(source, 'state.sqlite')).isSymbolicLink()) throw new Error('Archive symlinks are not allowed');
  source = realpathSync(source);
  destination = resolve(destination);
  if (existsSync(destination)) throw new Error('Restore target must be new; live state is never overwritten');
  const manifest = JSON.parse(readFileSync(join(source, 'manifest.json')));
  const input = join(source, 'state.sqlite');
  if (manifest.format !== 'builder-state-backup-v1' || digest(input) !== manifest.digest) {
    throw new Error('Backup manifest or digest mismatch');
  }
  const metadata = validDatabase(input);
  if (metadata.schema !== manifest.schema || JSON.stringify(metadata.projects) !== JSON.stringify(manifest.projects)) {
    throw new Error('Backup metadata mismatch');
  }
  mkdirSync(destination, { recursive: false, mode: 0o700 });
  const reader = new DatabaseSync(input, { readOnly: true });
  const output = join(destination, 'state.sqlite');
  try { await backup(reader, output); } finally { reader.close(); }
  const db = new DatabaseSync(output);
  try {
    db.exec(`
      BEGIN IMMEDIATE;
      UPDATE projects SET owner_epoch=owner_epoch+1, state_revision=state_revision+1;
      UPDATE run_attempts SET status='unknown_outcome', unconfirmed_active=1
        WHERE status IN ('prepared','running','cancel_requested','unknown_outcome') OR unconfirmed_active=1;
      COMMIT;
    `);
  } finally { db.close(); }
  return { restored: true, ...validDatabase(output), unresolvedWorkRequiresReconciliation: true,
    incompleteLegacyArchive: true, missing: ['policy journal','verification journal','frozen assets'], externalRedispatchAllowed: false };
}
const DATABASES = ['state.sqlite', 'policy.sqlite', 'verification-operations.sqlite'];
function auditWorkspaceAssets(stateRoot) {
  const db = new DatabaseSync(join(stateRoot, 'state.sqlite'), { readOnly: true });
  const errors = [];
  try {
    for (const row of db.prepare("SELECT * FROM evidence WHERE kind IN ('host-verification','delivery-manifest')").all()) {
      try {
        const rel = relative(stateRoot, row.location);
        if (!rel.startsWith('verification/') && !rel.startsWith('deliveries/')) throw new Error('Evidence outside archive scope');
        const file = safePath(stateRoot, rel);
        if (digest(file) !== row.digest) throw new Error('Evidence digest mismatch');
        const document = JSON.parse(readFileSync(file));
        if (row.kind === 'host-verification') {
          const details = JSON.parse(row.details_json ?? '{}');
          const snapshot = details.snapshotPath ?? document.candidate.snapshotPath;
          const snapshotRel = relative(stateRoot, snapshot);
          if (!snapshotRel.startsWith('verification/snapshots/')) throw new Error('Snapshot outside archive scope');
          safePath(stateRoot, snapshotRel);
          if (document.binding.taskId !== row.task_id || document.binding.attemptId !== row.attempt_id
              || document.binding.goalRevision !== row.goal_revision || document.binding.contractRevision !== row.contract_revision
              || buildCandidateManifest(snapshot).candidateDigest !== document.binding.candidateDigest) throw new Error('Report/snapshot binding mismatch');
        } else if (buildCandidateManifest(join(dirname(file), 'product')).candidateDigest !== document.candidateDigest) {
          throw new Error('Delivery product digest mismatch');
        }
      } catch (error) { errors.push({ evidenceId: row.evidence_id, reason: error.message }); }
    }
  } finally { db.close(); }
  return errors;
}
function safePath(root, name) {
  if (typeof name !== 'string' || isAbsolute(name) || name.split(/[\\/]/).some(p => !p || p === '..' || p === '.')) {
    throw new Error('Unsafe archive path');
  }
  let cursor = root;
  for (const part of name.split('/')) {
    cursor = join(cursor, part);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error('Archive symlinks are not allowed');
  }
  return cursor;
}
function inventory(root, prefix = '', budget = { files: 0, bytes: 0 }) {
  const rows = [];
  if (!existsSync(join(root, prefix))) return rows;
  for (const name of readdirSync(join(root, prefix)).sort()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    const file = safePath(root, rel);
    const stat = lstatSync(file);
    if (stat.isDirectory()) rows.push(...inventory(root, rel, budget));
    else if (stat.isFile()) {
      budget.files++; budget.bytes += stat.size;
      if (budget.files > 5000 || budget.bytes > 200 * 1024 * 1024) throw new Error('Archive exceeds bounded local asset size');
      rows.push({ path: rel, bytes: stat.size, digest: digest(file) });
    }
    else throw new Error('Archive only supports regular files');
  }
  return rows;
}

// Caller holds the workspace coordination lock. Reserved DB locks also exclude
// older database writers. These locks never imply a native worker has stopped.
async function backupWorkspace(stateRoot, destination) {
  stateRoot = realpathSync(stateRoot);
  if (existsSync(destination)) throw new Error('Backup destination already exists');
  const guards = [];
  try {
    for (const name of DATABASES) {
      if (!existsSync(join(stateRoot, name))) continue;
      const file = safePath(stateRoot, name);
      const db = new DatabaseSync(file, { timeout: 5000 });
      guards.push(db);
      db.exec('BEGIN IMMEDIATE');
    }
    const missing = auditWorkspaceAssets(stateRoot);
    if (missing.length) throw new Error('Evidence assets incomplete: ' + JSON.stringify(missing));
    mkdirSync(destination, { mode: 0o700 });
    for (const name of DATABASES) {
      if (!existsSync(join(stateRoot, name))) continue;
      const reader = new DatabaseSync(join(stateRoot, name), { readOnly: true });
      try { await backup(reader, join(destination, name)); } finally { reader.close(); }
    }
    const assets = [...inventory(stateRoot, 'verification'), ...inventory(stateRoot, 'deliveries')];
    if (assets.length > 5000 || assets.reduce((n, f) => n + f.bytes, 0) > 200 * 1024 * 1024) {
      throw new Error('Archive exceeds bounded local asset size');
    }
    for (const item of assets) {
      const output = safePath(destination, item.path);
      mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
      const bytes = readFileSync(safePath(stateRoot, item.path));
      if ('sha256:' + createHash('sha256').update(bytes).digest('hex') !== item.digest) throw new Error('Asset changed during backup');
      writeFileSync(output, bytes, { flag: 'wx', mode: 0o600 });
    }
    if (JSON.stringify(assets) !== JSON.stringify([...inventory(stateRoot, 'verification'), ...inventory(stateRoot, 'deliveries')])) throw new Error('Assets changed during backup');
    const manifest = { format: 'builder-workspace-backup-v2', createdAt: new Date().toISOString(),
      sourceStateRoot: stateRoot, ...validDatabase(join(destination, 'state.sqlite')),
      files: inventory(destination), scope: 'Control state, durable journals, frozen verification snapshots and reports',
      excluded: ['live product working tree', 'live business data', 'external effects'],
      consistency: 'coordinated MCP mutations plus write locks on included databases' };
    writeFileSync(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return manifest;
  } finally { for (const db of guards.reverse()) { try { db.exec('ROLLBACK'); } finally { db.close(); } } }
}

async function restoreWorkspace(source, destination) {
  if (lstatSync(source).isSymbolicLink() || lstatSync(join(source, 'manifest.json')).isSymbolicLink()) throw new Error('Archive symlinks are not allowed');
  const manifest = JSON.parse(readFileSync(join(source, 'manifest.json')));
  if (manifest.format === 'builder-state-backup-v1') return restoreBuilderState(source, destination);
  if (manifest.format !== 'builder-workspace-backup-v2') throw new Error('Unsupported archive format');
  if (existsSync(destination)) throw new Error('Restore target must be new');
  const actual = inventory(source).filter(f => f.path !== 'manifest.json');
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error('Archive integrity mismatch');
  if (!manifest.files.some(f => f.path === 'state.sqlite')) throw new Error('State missing');
  for (const file of manifest.files) {
    if (!DATABASES.includes(file.path) && !file.path.startsWith('verification/') && !file.path.startsWith('deliveries/')) throw new Error('Unsupported archive asset');
  }
  const metadata = validDatabase(join(source, 'state.sqlite'));
  if (![4, 5].includes(metadata.schema)) throw new Error('Unsupported archive schema');
  if (metadata.schema !== manifest.schema || JSON.stringify(metadata.projects) !== JSON.stringify(manifest.projects)) throw new Error('Archive metadata mismatch');
  mkdirSync(destination, { mode: 0o700 });
  for (const item of manifest.files) {
    const output = safePath(destination, item.path);
    mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
    writeFileSync(output, readFileSync(safePath(source, item.path)), { flag: 'wx', mode: 0o600 });
  }
  const db = new DatabaseSync(join(destination, 'state.sqlite'));
  try {
    db.exec(`BEGIN IMMEDIATE;
      UPDATE projects SET owner_epoch=owner_epoch+1,state_revision=state_revision+1;
      UPDATE run_attempts SET status='unknown_outcome',unconfirmed_active=1
        WHERE status IN ('prepared','running','cancel_requested','unknown_outcome') OR unconfirmed_active=1;`);
    for (const row of db.prepare('SELECT evidence_id, kind, location, details_json FROM evidence').all()) {
      const rel = relative(manifest.sourceStateRoot, row.location);
      if ((rel.startsWith('verification/') || rel.startsWith('deliveries/')) && manifest.files.some(f => f.path === rel)) {
        const details = JSON.parse(row.details_json ?? '{}');
        if (row.kind === 'host-verification') {
          const report = JSON.parse(readFileSync(join(destination, rel)));
          const snapshotRel = relative(manifest.sourceStateRoot, details.snapshotPath ?? report.candidate.snapshotPath);
          if (!snapshotRel.startsWith('verification/snapshots/') || !manifest.files.some(f => f.path.startsWith(snapshotRel + '/'))) throw new Error('Snapshot mapping unavailable');
          details.snapshotPath = join(destination, snapshotRel);
        }
        db.prepare('UPDATE evidence SET location=?,details_json=? WHERE evidence_id=?').run(join(destination, rel), JSON.stringify(details), row.evidence_id);
      }
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; } finally { db.close(); }
  const missing = auditWorkspaceAssets(destination);
  if (missing.length) throw new Error('Restored evidence incomplete: ' + JSON.stringify(missing));
  const policyPath = join(destination, 'policy.sqlite');
  if (existsSync(policyPath)) {
    const policy = new DatabaseSync(policyPath);
    try {
      const row = policy.prepare('SELECT payload FROM policy_journal WHERE id=1').get();
      const payload = JSON.parse(row.payload);
      payload.approvals = []; // Restored intents retain deduplication, not reusable approvals.
      policy.prepare('UPDATE policy_journal SET payload=? WHERE id=1').run(JSON.stringify(payload));
    } finally { policy.close(); }
  }
  writeFileSync(join(destination, 'recovery-origin.json'), JSON.stringify({ manifest,
    note: 'Reports remain immutable historical evidence. Live code/data and native executors are not restored; reverify new work.' }, null, 2));
  return { restored: true, ...validDatabase(join(destination, 'state.sqlite')), restoredAssets: manifest.files.length,
    journalsRestored: DATABASES.slice(1).filter(name => manifest.files.some(f => f.path === name)),
    liveProductRestored: false, unresolvedWorkRequiresReconciliation: true };
}
module.exports = { backupBuilderState, restoreBuilderState, backupWorkspace, restoreWorkspace, auditWorkspaceAssets };
