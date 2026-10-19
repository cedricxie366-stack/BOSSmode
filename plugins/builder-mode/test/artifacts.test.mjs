import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, readdirSync, lstatSync, existsSync, renameSync, symlinkSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { callAlignedFixture as call } from './aligned-fixture.mjs';
const require = createRequire(import.meta.url);
const { validatePlan } = require('../runtime/suites/artifact-data.cjs');
const { backupBuilderState } = require('../runtime/backup.cjs');
const roots = [];
function writable(root) {
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) return;
  chmodSync(root, 0o700);
  for (const name of readdirSync(root)) writable(join(root, name));
}
afterEach(() => { for (const root of roots.splice(0)) { writable(root); rmSync(root, { recursive: true, force: true }); } });
const plan = { checks: [
  { id: 'text', kind: 'text_contains', path: 'note.md', value: 'Evidence' },
  { id: 'data', kind: 'json_fields', path: 'data.json', fields: { title: 'string', sources: 'array' } },
], reviewCriteria: [{ id: 'quality', text: 'Conclusions follow from supplied evidence, with limitations' }] };
async function fixture() {
  const workspacePath = mkdtempSync(join(tmpdir(), 'builder-delivery-')); roots.push(workspacePath);
  mkdirSync(join(workspacePath, 'product'));
  writeFileSync(join(workspacePath, 'product/note.md'), 'Evidence: synthetic-only demonstration. Limitations remain.');
  writeFileSync(join(workspacePath, 'product/data.json'), JSON.stringify({ title: 'Synthetic brief', sources: [] }));
  const opened = await call('builder_open_project', { workspacePath, goal: 'Deliver a version-bound synthetic note' });
  const change = await call('builder_begin_change', { workspacePath, expectedStateRevision: opened.data.stateRevision,
    objective: 'Synthetic data checks', candidatePath: 'product', verificationProfile: 'artifact-data-v1', acceptancePlan: plan });
  const verified = await call('builder_verify_change', { workspacePath, expectedStateRevision: change.data.stateRevision,
    taskId: change.data.taskId, attemptId: change.data.attemptId });
  assert.equal(verified.data.status, 'needs_review');
  const evidence = verified.data.evidence.find(e => e.id === verified.data.evidenceId);
  const args = { workspacePath, expectedStateRevision: verified.data.stateRevision,
    taskId: change.data.taskId, attemptId: change.data.attemptId, verificationEvidenceId: evidence.id,
    candidateDigest: evidence.details.candidateDigest };
  return { workspacePath, args, verified, evidence };
}
const review = args => ({ ...args, criterionId: 'quality', reviewerType: 'assistant', outcome: 'satisfied',
  comment: 'Synthetic note discloses its limitations; no factual generalization certified.', sourceRef: 'note.md:1' });

test('generic data checks, versioned review and honest portable delivery form a complete local workflow', async () => {
  const f = await fixture();
  const reviewed = await call('builder_record_review', review(f.args));
  assert.equal(reviewed.data.userApprovalGranted, false);
  assert.equal(reviewed.data.tasks.some(t => t.status === 'accepted'), false);
  const delivered = await call('builder_prepare_delivery', { ...f.args, expectedStateRevision: reviewed.data.stateRevision });
  assert.equal(delivered.data.manifest.status, 'reviewed_candidate');
  assert.equal(delivered.data.manifest.userAcceptance, 'not_attested');
  assert.equal(readFileSync(join(delivered.data.destination, 'product/note.md'), 'utf8'), readFileSync(join(f.workspacePath, 'product/note.md'), 'utf8'));
  const second = await call('builder_prepare_delivery', { ...f.args, expectedStateRevision: delivered.data.stateRevision });
  assert.notEqual(second.data.destination, delivered.data.destination);
  assert.ok(existsSync(join(delivered.data.destination, 'delivery.json')));
});

test('missing reviews remain visible and requested changes prevent ready delivery', async () => {
  const f = await fixture();
  const first = await call('builder_prepare_delivery', f.args);
  assert.equal(first.data.manifest.status, 'needs_review');
  const feedback = await call('builder_record_review', { ...review(f.args), expectedStateRevision: first.data.stateRevision, outcome: 'changes_requested' });
  await assert.rejects(call('builder_prepare_delivery', { ...f.args, expectedStateRevision: feedback.data.stateRevision }), /Outstanding requested changes/);
});

test('user attribution never grants host approval and unsupported approval switches are rejected', async () => {
  const f = await fixture();
  await assert.rejects(call('builder_record_review', { ...review(f.args), userApproved: true }), /Unsupported argument/);
  const result = await call('builder_record_review', { ...review(f.args), reviewerType: 'user_attributed', sourceRef: 'Synthetic attribution fixture, not an actual user acceptance' });
  assert.equal(result.data.attestation, 'assistant_attributed');
  assert.equal(result.data.tasks[0].status, 'verifying');
});

test('changing one byte or changing the contract invalidates old artifact reviews', async () => {
  const f = await fixture();
  writeFileSync(join(f.workspacePath, 'product/note.md'), 'Evidence: changed');
  await assert.rejects(call('builder_record_review', review(f.args)), /Working candidate changed/);
  const changed = await call('builder_record_contract', { workspacePath: f.workspacePath, expectedStateRevision: f.args.expectedStateRevision,
    rules: [{ id: 'new', text: 'New assumed requirement', status: 'assumed', source: 'assistant' }] });
  await assert.rejects(call('builder_prepare_delivery', { ...f.args, expectedStateRevision: changed.data.stateRevision }), /stale contract/);
});

test('tampered report or snapshot is not trusted for review', async () => {
  const f = await fixture();
  const report = JSON.parse(readFileSync(f.evidence.location));
  chmodSync(join(report.candidate.snapshotPath, 'note.md'), 0o600);
  writeFileSync(join(report.candidate.snapshotPath, 'note.md'), 'altered');
  await assert.rejects(call('builder_record_review', review(f.args)), /Frozen snapshot changed/);
  chmodSync(f.evidence.location, 0o600);
  writeFileSync(f.evidence.location, '{}');
  await assert.rejects(call('builder_record_review', review(f.args)), /report digest mismatch/);
});

test('plans reject code, traversal, no checks, unsupported types and oversized limits', () => {
  for (const invalid of [ { ...plan, checks: [] },
    { ...plan, checks: [{ id: 'x', kind: 'command', path: 'note.md' }] },
    { ...plan, checks: [{ id: 'x', kind: 'file', path: '../secret' }] },
    { ...plan, checks: [{ id: 'x', kind: 'file', path: 'note.md', maxBytes: 999999999 }] },
    { ...plan, shell: 'true' }, { ...plan, reviewCriteria: [] } ]) assert.throws(() => validatePlan(invalid));
});

test('v2 restores journals, reports and frozen assets independently of original evidence paths', async () => {
  const f = await fixture();
  await call('builder_check_action', { workspacePath: f.workspacePath, action: 'public_publish', resource: 'synthetic', idempotencyKey: 'same-key' });
  const journal = new DatabaseSync(join(f.workspacePath, '.builder-mode/verification-operations.sqlite'));
  journal.exec("UPDATE operations SET status='error',error='simulated lost response after commit'"); journal.close();
  const saved = await call('builder_backup_project', { workspacePath: f.workspacePath });
  const restored = await call('builder_restore_backup', { workspacePath: f.workspacePath, backupId: saved.data.backupId });
  assert.deepEqual(restored.data.journalsRestored, ['policy.sqlite', 'verification-operations.sqlite']);
  assert.equal(restored.data.liveProductRestored, false);
  renameSync(join(f.workspacePath, '.builder-mode/verification'), join(f.workspacePath, '.builder-mode/original-evidence-moved'));
  const recovered = await call('builder_recovery_status', { workspacePath: restored.data.restoredWorkspace });
  assert.equal(recovered.data.actions[0].idempotencyKey, 'same-key');
  assert.equal(recovered.data.verificationOperations[0].reconciled, 'committed_result_found');
  assert.equal(recovered.data.verificationOperations[0].committedStatus, 'needs_review');
  const loaded = await call('builder_get_project', { workspacePath: restored.data.restoredWorkspace });
  assert.ok(existsSync(loaded.data.evidence[0].location));
  assert.notEqual(loaded.data.evidence[0].location, f.evidence.location);
  writeFileSync(join(saved.data.destination, 'state.sqlite'), 'tampered');
  await assert.rejects(call('builder_restore_backup', { workspacePath: f.workspacePath, backupId: saved.data.backupId }), /integrity mismatch/);
});

test('workspace maintenance lock rejects concurrent mutation without partial backup', async () => {
  const f = await fixture();
  const lock = new DatabaseSync(join(f.workspacePath, '.builder-mode/coordination.sqlite'));
  try { lock.exec('BEGIN IMMEDIATE'); await assert.rejects(call('builder_backup_project', { workspacePath: f.workspacePath }), /locked|busy/); }
  finally { lock.close(); }
  const saved = await call('builder_backup_project', { workspacePath: f.workspacePath });
  assert.equal(saved.data.manifest.format, 'builder-workspace-backup-v2');
});

test('v2 restore retains unknown actions and writers but never reuses archived approvals', async () => {
  const f = await fixture();
  await call('builder_check_action', { workspacePath: f.workspacePath, action: 'public_publish', resource: 'synthetic', idempotencyKey: 'pending-key' });
  const db = new DatabaseSync(join(f.workspacePath, '.builder-mode/policy.sqlite'));
  const payload = JSON.parse(db.prepare('SELECT payload FROM policy_journal WHERE id=1').get().payload);
  payload.approvals = [{ id: 'synthetic-only-approval' }];
  payload.intents[0].status = 'unknown';
  payload.intents[0].dispatchCount = 1;
  db.prepare('UPDATE policy_journal SET payload=? WHERE id=1').run(JSON.stringify(payload)); db.close();
  await call('builder_begin_change', { workspacePath: f.workspacePath, expectedStateRevision: f.args.expectedStateRevision,
    objective: 'Unresolved synthetic writer', candidatePath: 'product', verificationProfile: 'artifact-data-v1', acceptancePlan: plan });
  const saved = await call('builder_backup_project', { workspacePath: f.workspacePath });
  const restored = await call('builder_restore_backup', { workspacePath: f.workspacePath, backupId: saved.data.backupId });
  const status = await call('builder_recovery_status', { workspacePath: restored.data.restoredWorkspace });
  assert.equal(status.data.unknown.length, 1);
  assert.equal(status.data.actions[0].status, 'unknown');
  assert.equal(status.data.actions[0].dispatchCount, 1);
  assert.equal(status.data.requiresReconciliation, true);
  const recovered = new DatabaseSync(join(restored.data.restoredWorkspace, '.builder-mode/policy.sqlite'), { readOnly: true });
  assert.deepEqual(JSON.parse(recovered.prepare('SELECT payload FROM policy_journal WHERE id=1').get().payload).approvals, []);
  recovered.close();
});

test('two generations of restore retain evidence identity and support review/delivery after explicit product recovery', async () => {
  const f = await fixture();
  let workspacePath = f.workspacePath;
  for (let generation = 0; generation < 2; generation++) {
    const saved = await call('builder_backup_project', { workspacePath });
    const restored = await call('builder_restore_backup', { workspacePath, backupId: saved.data.backupId });
    workspacePath = restored.data.restoredWorkspace;
    cpSync(join(f.workspacePath, 'product'), join(workspacePath, 'product'), { recursive: true });
    const current = await call('builder_get_project', { workspacePath });
    const reviewed = await call('builder_record_review', { ...review(f.args), workspacePath, expectedStateRevision: current.data.stateRevision });
    const delivered = await call('builder_prepare_delivery', { ...f.args, workspacePath, expectedStateRevision: reviewed.data.stateRevision });
    assert.equal(delivered.data.manifest.status, 'reviewed_candidate');
  }
});

test('missing referenced evidence blocks full backup and is exposed by recovery inspection', async () => {
  const f = await fixture();
  renameSync(f.evidence.location, f.evidence.location + '.moved');
  await assert.rejects(call('builder_backup_project', { workspacePath: f.workspacePath }), /Evidence assets incomplete/);
  const recovered = await call('builder_recovery_status', { workspacePath: f.workspacePath });
  assert.equal(recovered.data.requiresReconciliation, true);
  assert.equal(recovered.data.assetErrors.length, 1);
});

test('invalid verification rejected before execution does not create an unknown operation', async () => {
  const f = await fixture();
  await assert.rejects(call('builder_verify_change', { workspacePath: f.workspacePath,
    expectedStateRevision: f.args.expectedStateRevision, taskId: 'does-not-exist', attemptId: 'missing' }), /binding invalid/);
  const recovered = await call('builder_recovery_status', { workspacePath: f.workspacePath });
  assert.equal(recovered.data.verificationOperations.length, 1);
  assert.equal(recovered.data.requiresReconciliation, false);
});

test('dangling policy links and source database links are refused before touching target', async () => {
  const f = await fixture();
  const target = join(f.workspacePath, 'must-not-create.sqlite');
  symlinkSync(target, join(f.workspacePath, '.builder-mode/policy.sqlite'));
  await assert.rejects(call('builder_check_action', { workspacePath: f.workspacePath, action: 'public_publish', resource: 'synthetic', idempotencyKey: 'x' }), /symlink/);
  assert.equal(existsSync(target), false);
  symlinkSync(join(f.workspacePath, '.builder-mode/state.sqlite'), join(f.workspacePath, 'linked.sqlite'));
  await assert.rejects(backupBuilderState(join(f.workspacePath, 'linked.sqlite'), join(f.workspacePath, 'archive')), /symlinks/);
});
