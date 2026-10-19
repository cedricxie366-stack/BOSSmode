import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { toolDefinitions } from '../mcp/server.mjs';
import { callAlignedFixture as callBuilderTool } from './aligned-fixture.mjs';

const require = createRequire(import.meta.url);
const { startCandidateServer } = require('../runtime/suites/candidate-server-harness.js');

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const workspaces = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    makeWritable(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});

function makeWritable(root) {
  const metadata = lstatSync(root);
  if (!metadata.isDirectory()) return;
  chmodSync(root, 0o700);
  for (const name of readdirSync(root)) {
    const child = path.join(root, name);
    if (lstatSync(child).isDirectory()) makeWritable(child);
  }
}

function createWorkspace() {
  const workspace = mkdtempSync(path.join(tmpdir(), 'builder-mode-plugin-'));
  workspaces.push(workspace);
  mkdirSync(path.join(workspace, 'product'));
  cpSync(path.join(repositoryRoot, 'examples', 'registration'), path.join(workspace, 'product'), {
    recursive: true,
    force: true,
  });
  return workspace;
}

for (const [example, profile] of [['research-note', 'research-note-v1'], ['content-note', 'content-brief-v1']]) {
  test(`${profile} checks structure without claiming substantive acceptance`, async () => {
    const workspacePath = mkdtempSync(path.join(tmpdir(), 'builder-artifact-'));
    workspaces.push(workspacePath);
    cpSync(path.join(repositoryRoot, 'examples', example, 'product'), path.join(workspacePath, 'product'), { recursive: true });
    const opened = await callBuilderTool('builder_open_project', { workspacePath, goal: 'Review a non-software draft' });
    const change = await callBuilderTool('builder_begin_change', {
      workspacePath, expectedStateRevision: opened.data.stateRevision,
      objective: 'Check draft completeness', candidatePath: 'product', verificationProfile: profile,
    });
    const result = await callBuilderTool('builder_verify_change', {
      workspacePath, expectedStateRevision: change.data.stateRevision,
      taskId: change.data.taskId, attemptId: change.data.attemptId,
    });
    assert.equal(result.data.status, 'needs_review');
    const reopened = await callBuilderTool('builder_get_project', { workspacePath });
    assert.equal(reopened.data.tasks.some(task => task.status === 'accepted'), false);
    assert.equal(reopened.data.attempts.some(attempt => attempt.verified), false);
  });
}

test('a killed change process leaves an unresolved writer and blocks redispatch', async () => {
  const workspacePath = createWorkspace();
  const opened = await callBuilderTool('builder_open_project', { workspacePath, goal: 'Actual process crash probe' });
  const moduleUrl = new URL('../mcp/server.mjs', import.meta.url).href;
  const code = `import { callBuilderTool } from ${JSON.stringify(moduleUrl)};
    await callBuilderTool('builder_begin_change', ${JSON.stringify({ workspacePath,
      expectedStateRevision: opened.data.stateRevision, objective: 'Crash after durable begin',
      candidatePath: 'product', verificationProfile: 'registration-basic-v1' })});
    process.kill(process.pid, 'SIGKILL');`;
  const exit = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  assert.equal(exit.signal, 'SIGKILL');
  const recovered = await callBuilderTool('builder_recovery_status', { workspacePath });
  assert.equal(recovered.data.unknown.length, 1);
  assert.equal(recovered.data.automaticRedispatch, false);
  await assert.rejects(callBuilderTool('builder_begin_change', {
    workspacePath, expectedStateRevision: recovered.data.stateRevision,
    objective: 'Do not silently restart', candidatePath: 'product', verificationProfile: 'registration-basic-v1',
  }), /writer|unresolved|active/i);
});

test('advertises bounded Builder tools including backup and recovery inspection', () => {
  assert.deepEqual(toolDefinitions.map((tool) => tool.name), [
    'builder_propose_plan',
    'builder_record_plan_response',
    'builder_reconcile_decision',
    'builder_get_brief',
    'builder_record_update',
    'builder_prepare_decision',
    'builder_record_decision_response',
    'builder_record_review',
    'builder_prepare_delivery',
    'builder_restore_backup',
    'builder_backup_project',
    'builder_recovery_status',
    'builder_check_action',
    'builder_open_project',
    'builder_get_project',
    'builder_record_contract',
    'builder_begin_change',
    'builder_record_product_context',
    'builder_change_direction',
    'builder_verify_change',
  ]);
  assert.equal(toolDefinitions.find((tool) => tool.name === 'builder_get_project').annotations.readOnlyHint, true);
  assert.equal(toolDefinitions.some((tool) => /approve|passed/u.test(tool.name)), false);
});

test('backup and durable action proposal are reachable through plugin tools without executing external effects', async () => {
  const workspacePath = createWorkspace();
  await callBuilderTool('builder_open_project', { workspacePath, goal: 'Tool boundary test' });
  const saved = await callBuilderTool('builder_backup_project', { workspacePath });
  assert.equal(saved.data.manifest.format, 'builder-workspace-backup-v2');
  const restored = await callBuilderTool('builder_restore_backup', { workspacePath, backupId: saved.data.backupId });
  const reopened = await callBuilderTool('builder_get_project', { workspacePath: restored.data.restoredWorkspace });
  assert.equal(reopened.data.project.ownerEpoch, 2);
  assert.equal(reopened.data.project.goal, 'Tool boundary test');
  const args = { workspacePath, action: 'public_publish', resource: 'synthetic-only', idempotencyKey: 'proposal-1' };
  const denied = await callBuilderTool('builder_check_action', args);
  assert.equal(denied.data.allowed, false);
  assert.equal(denied.data.executed, false);
  await callBuilderTool('builder_check_action', args);
  const status = await callBuilderTool('builder_recovery_status', { workspacePath });
  assert.equal(status.data.actions.length, 1);
  assert.equal(status.data.actions[0].dispatchCount, 0);
  assert.equal(status.data.automaticRedispatch, false);
});

test('persists, verifies, revises, and reloads a project without chat history', async () => {
  const workspacePath = createWorkspace();
  const opened = await callBuilderTool('builder_open_project', {
    workspacePath,
    goal: 'Create a small registration product and improve it with a waitlist.',
  });
  assert.equal(opened.data.project.goalRevision, 1);

  const initialContract = await callBuilderTool('builder_record_contract', {
    workspacePath,
    expectedStateRevision: opened.data.stateRevision,
    rules: [{
      id: 'registration-core',
      text: 'A person can register once with a name and email.',
      status: 'confirmed',
      source: 'user',
    }],
  });
  const initialContext = await callBuilderTool('builder_record_product_context', {
    workspacePath,
    expectedStateRevision: initialContract.data.stateRevision,
    brief: {
      summary: 'A local registration tool for volunteer organizers.',
      nextStep: 'Deliver and verify the basic registration flow.',
    },
    items: [
      { id: 'audience', kind: 'audience', text: 'Volunteer organizers', source: 'user' },
      { id: 'storage-assumption', kind: 'assumption', text: 'In-memory storage is enough for C1.', source: 'assistant' },
      { id: 'research', kind: 'research_fact', text: 'The selected runtime is Node.js 24.', source: 'research', sourceRef: 'runtime-probe' },
      { id: 'open-question', kind: 'open_question', text: 'Should registrations persist after restart?', source: 'assistant' },
    ],
  });
  assert.equal(initialContext.data.project.contractRevision, initialContract.data.project.contractRevision);
  const initialChange = await callBuilderTool('builder_begin_change', {
    workspacePath,
    expectedStateRevision: initialContext.data.stateRevision,
    objective: 'Deliver the basic registration flow.',
    candidatePath: 'product',
    verificationProfile: 'registration-basic-v1',
  });
  const initialVerification = await callBuilderTool('builder_verify_change', {
    workspacePath,
    expectedStateRevision: initialChange.data.stateRevision,
    taskId: initialChange.data.taskId,
    attemptId: initialChange.data.attemptId,
  });
  assert.equal(initialVerification.data.status, 'accepted');
  assert.equal(initialVerification.data.limitations.networkIsolation, 'loopback-only; non-local network denied');
  assert.match(initialVerification.data.limitations.processIsolation, /process-fork denied/u);

  const revisedContract = await callBuilderTool('builder_record_contract', {
    workspacePath,
    expectedStateRevision: initialVerification.data.stateRevision,
    rules: [{
      id: 'waitlist',
      text: 'When capacity is full, queue people in order and promote the earliest after a cancellation.',
      status: 'confirmed',
      source: 'user',
    }],
  });
  const revisedChange = await callBuilderTool('builder_begin_change', {
    workspacePath,
    expectedStateRevision: revisedContract.data.stateRevision,
    objective: 'Add FIFO waitlisting while preserving registration.',
    candidatePath: 'product',
    verificationProfile: 'registration-waitlist-v1',
  });
  const revisedVerification = await callBuilderTool('builder_verify_change', {
    workspacePath,
    expectedStateRevision: revisedChange.data.stateRevision,
    taskId: revisedChange.data.taskId,
    attemptId: revisedChange.data.attemptId,
  });
  assert.equal(revisedVerification.data.status, 'accepted');

  const reloaded = await callBuilderTool('builder_get_project', { workspacePath });
  assert.equal(reloaded.data.rules.length, 2);
  assert.equal(reloaded.data.tasks.filter((task) => task.status === 'accepted').length, 2);
  assert.equal(reloaded.data.tasks.filter((task) => task.acceptedAttemptId).length, 2);
  assert.equal(reloaded.data.evidence.filter((item) => item.status === 'passed').length, 2);
  const journal = new DatabaseSync(path.join(workspacePath, '.builder-mode', 'verification-operations.sqlite'));
  journal.prepare("UPDATE operations SET status='pending' WHERE attempt_id=?").run(revisedChange.data.attemptId);
  journal.close();
  const recovered = await callBuilderTool('builder_recovery_status', { workspacePath });
  assert.equal(recovered.data.verificationOperations.at(-1).reconciled, 'committed_result_found');
  assert.equal(recovered.data.automaticRedispatch, false);
  assert.equal(reloaded.data.contextItems.length, 4);
  assert.equal(reloaded.data.brief.summary, 'A local registration tool for volunteer organizers.');
  assert.equal(reloaded.data.contextItems.find((item) => item.id === 'audience').attestation, 'assistant_attributed');
  assert.equal(reloaded.data.contextItems.find((item) => item.id === 'research').attestation, 'research_cited');

  const databasePath = path.join(workspacePath, '.builder-mode', 'state.sqlite');
  const beforeRead = statSync(databasePath).mtimeMs;
  await callBuilderTool('builder_get_project', { workspacePath });
  assert.equal(statSync(databasePath).mtimeMs, beforeRead);
});

test('a missing verifier report records failure without leaving a running writer', async () => {
  const workspacePath = createWorkspace();
  const opened = await callBuilderTool('builder_open_project', { workspacePath, goal: 'Report fault' });
  const change = await callBuilderTool('builder_begin_change', { workspacePath,
    expectedStateRevision: opened.data.stateRevision, objective: 'Exercise report-read failure',
    candidatePath: 'product', verificationProfile: 'registration-basic-v1' });
  const { HostVerificationService } = require('../runtime/verification.cjs');
  const original = HostVerificationService.prototype.verify;
  try {
    HostVerificationService.prototype.verify = function (request) {
      const outcome = original.call(this, request);
      assert.ok(outcome.reportPath.startsWith(path.join(workspacePath, '.builder-mode')));
      unlinkSync(outcome.reportPath);
      return outcome;
    };
    const result = await callBuilderTool('builder_verify_change', { workspacePath,
      taskId: change.data.taskId, attemptId: change.data.attemptId,
      expectedStateRevision: change.data.stateRevision });
    assert.equal(result.data.status, 'failed');
    assert.equal(result.data.attempts.at(-1).status, 'failed');
    assert.equal(result.data.evidence.at(-1).kind, 'host-verification-error');
  } finally { HostVerificationService.prototype.verify = original; }
});

test('explicit direction change advances revisions and makes unfinished old work historical', async () => {
  const workspacePath = createWorkspace();
  const opened = await callBuilderTool('builder_open_project', {
    workspacePath,
    goal: 'Build a registration product.',
  });
  const oldChange = await callBuilderTool('builder_begin_change', {
    workspacePath,
    expectedStateRevision: opened.data.stateRevision,
    objective: 'Old unfinished registration work.',
    candidatePath: 'product',
    verificationProfile: 'registration-basic-v1',
  });
  const changed = await callBuilderTool('builder_change_direction', {
    workspacePath,
    expectedStateRevision: oldChange.data.stateRevision,
    newGoal: 'Build a general planning assistant.',
    decision: 'The user explicitly chose to replace the registration product with a planning assistant.',
    briefSummary: 'A planning assistant whose first workflow is still undecided.',
    nextStep: 'Choose the first planning workflow.',
  });
  assert.equal(changed.data.project.goalRevision, 2);
  assert.equal(changed.data.project.contractRevision, 2);
  assert.equal(changed.data.tasks[0].status, 'superseded');
  assert.equal(changed.data.tasks[0].applicability, 'historical');
  assert.equal(changed.data.attempts[0].status, 'superseded');
  assert.equal(changed.data.attempts[0].unconfirmedActive, true);
  assert.equal(changed.data.contextItems[0].attestation, 'assistant_attributed');
  assert.equal(changed.data.brief.nextStep, 'Choose the first planning workflow.');
  await assert.rejects(callBuilderTool('builder_verify_change', {
    workspacePath,
    expectedStateRevision: changed.data.stateRevision,
    taskId: oldChange.data.taskId,
    attemptId: oldChange.data.attemptId,
  }), /Only a running change can be verified/u);
});

test('refuses stale writes, unsafe candidate paths, and unsupported verification profiles', async () => {
  const workspacePath = createWorkspace();
  const opened = await callBuilderTool('builder_open_project', { workspacePath, goal: 'Test project.' });
  await assert.rejects(
    callBuilderTool('builder_record_contract', {
      workspacePath,
      expectedStateRevision: opened.data.stateRevision + 1,
      rules: [{ id: 'x', text: 'x', status: 'confirmed', source: 'user' }],
    }),
    /Stale project state/u,
  );
  await assert.rejects(
    callBuilderTool('builder_begin_change', {
      workspacePath,
      expectedStateRevision: opened.data.stateRevision,
      objective: 'Escape.',
      candidatePath: '../outside',
      verificationProfile: 'registration-basic-v1',
    }),
    /candidatePath/u,
  );
  await assert.rejects(
    callBuilderTool('builder_begin_change', {
      workspacePath,
      expectedStateRevision: opened.data.stateRevision,
      objective: 'Unsupported.',
      candidatePath: 'product',
      verificationProfile: 'anything-v1',
    }),
    /Unsupported verification profile/u,
  );
});

test('read-only retrieval does not create state in an unrelated workspace', async () => {
  const workspacePath = mkdtempSync(path.join(tmpdir(), 'builder-mode-plugin-empty-'));
  workspaces.push(workspacePath);
  await assert.rejects(
    callBuilderTool('builder_get_project', { workspacePath }),
    /does not exist/u,
  );
  assert.equal(existsSync(path.join(workspacePath, '.builder-mode')), false);
});

test('two MCP processes cannot claim the same expected revision or writer slot', async () => {
  const workspacePath = createWorkspace();
  const opened = await callBuilderTool('builder_open_project', { workspacePath, goal: 'Single writer' });
  const input = { workspacePath, expectedStateRevision: opened.data.stateRevision,
    objective: 'Race', candidatePath: 'product', verificationProfile: 'registration-basic-v1' };
  const moduleURL = new URL('../mcp/server.mjs', import.meta.url).href;
  const script = `import {callBuilderTool} from ${JSON.stringify(moduleURL)};
    try { await callBuilderTool('builder_begin_change', JSON.parse(process.argv[1])); }
    catch { process.exitCode = 3; }`;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(input)], { stdio: 'ignore' });
    child.on('error', reject); child.on('exit', resolve);
  });
  const outcomes = await Promise.all([run(), run()]);
  assert.deepEqual(outcomes.sort(), [0, 3]);
  const current = await callBuilderTool('builder_get_project', { workspacePath });
  assert.equal(current.data.attempts.filter((attempt) => attempt.status === 'running').length, 1);
});

test('candidate scan errors are recorded and repair cannot run without new diagnosis', async () => {
  const workspacePath = createWorkspace();
  const opened = await callBuilderTool('builder_open_project', { workspacePath, goal: 'Check scan failures' });
  const input = { workspacePath, objective: 'Missing candidate', candidatePath: 'missing-product',
    verificationProfile: 'registration-basic-v1', expectedStateRevision: opened.data.stateRevision };
  const change = await callBuilderTool('builder_begin_change', input);
  const result = await callBuilderTool('builder_verify_change', {
    workspacePath, expectedStateRevision: change.data.stateRevision,
    taskId: change.data.taskId, attemptId: change.data.attemptId,
  });
  assert.equal(result.data.status, 'failed');
  assert.equal(result.data.attempts[0].status, 'failed');
  assert.equal(result.data.evidence[0].status, 'failed');
  await assert.rejects(callBuilderTool('builder_begin_change', {
    ...input, expectedStateRevision: result.data.stateRevision,
  }), /diagnosis/);
  let latest = result.data.stateRevision;
  for (const diagnosis of ['Missing directory identified', 'Incorrect root mapping identified']) {
    const retry = await callBuilderTool('builder_begin_change', {
      ...input, expectedStateRevision: latest, diagnosis,
    });
    const failure = await callBuilderTool('builder_verify_change', {
      workspacePath, expectedStateRevision: retry.data.stateRevision,
      taskId: retry.data.taskId, attemptId: retry.data.attemptId,
    });
    latest = failure.data.stateRevision;
  }
  await assert.rejects(callBuilderTool('builder_begin_change', {
    ...input, expectedStateRevision: latest, diagnosis: 'Third automatic repair',
  }), /TASK_REPAIR_LIMIT/);
});

test('Seatbelt candidate process cannot write outside its snapshot, fork, or reach external network', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'builder-mode-isolation-'));
  workspaces.push(root);
  const candidate = path.join(root, 'candidate');
  const marker = path.join(root, 'escaped.txt');
  const secret = path.join(root, 'other-project-secret.txt');
  mkdirSync(candidate);
  writeFileSync(secret, 'must-not-be-readable');
  writeFileSync(path.join(candidate, 'server.js'), `
    const http = require('node:http');
    const fs = require('node:fs');
    const cp = require('node:child_process');
    let fileWriteDenied = false;
    let outsideReadDenied = false;
    try { fs.writeFileSync(${JSON.stringify(marker)}, 'escaped'); }
    catch (error) { fileWriteDenied = error.code === 'EPERM'; }
    try { fs.readFileSync(${JSON.stringify(secret)}, 'utf8'); }
    catch (error) { outsideReadDenied = error.code === 'EPERM'; }
    const fork = cp.spawnSync('/usr/bin/true');
    const external = fetch('https://example.com', { signal: AbortSignal.timeout(1000) }).then(() => false, () => true);
    const server = http.createServer(async (request, response) => {
      if (request.url === '/probe') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          fileWriteDenied,
          outsideReadDenied,
          forkDenied: fork.error?.code === 'EPERM',
          externalDenied: await external,
        }));
        return;
      }
      response.end('ready');
    });
    server.listen(Number(process.env.PORT), '127.0.0.1');
  `);
  const isolated = await startCandidateServer(candidate, { protectedReadRoots: [root] });
  try {
    const result = await (await fetch(`${isolated.baseUrl}/probe`)).json();
    assert.deepEqual(result, {
      fileWriteDenied: true,
      outsideReadDenied: true,
      forkDenied: true,
      externalDenied: true,
    });
    assert.equal(existsSync(marker), false);
  } finally {
    await isolated.stop();
  }
});

test('failed Host verification leaves a recorded, non-recoverable repair state', async () => {
  const workspacePath = mkdtempSync(path.join(tmpdir(), 'builder-mode-failed-verification-'));
  workspaces.push(workspacePath);
  mkdirSync(path.join(workspacePath, 'product'));
  writeFileSync(path.join(workspacePath, 'product', 'server.js'), `
    const http = require('node:http');
    http.createServer((request, response) => {
      if (request.url === '/') { response.end('报名'); return; }
      response.statusCode = 500;
      response.end('{}');
    }).listen(Number(process.env.PORT), '127.0.0.1');
  `);
  const opened = await callBuilderTool('builder_open_project', {
    workspacePath,
    goal: 'Deliberately failing verification test.',
  });
  const change = await callBuilderTool('builder_begin_change', {
    workspacePath,
    expectedStateRevision: opened.data.stateRevision,
    objective: 'Exercise a failing Host suite.',
    candidatePath: 'product',
    verificationProfile: 'registration-basic-v1',
  });
  const verification = await callBuilderTool('builder_verify_change', {
    workspacePath,
    expectedStateRevision: change.data.stateRevision,
    taskId: change.data.taskId,
    attemptId: change.data.attemptId,
  });
  assert.equal(verification.data.status, 'failed');
  assert.equal(verification.data.tasks.at(-1).status, 'needs_revision');
  assert.equal(verification.data.attempts.at(-1).status, 'failed');
  assert.equal(verification.data.evidence.at(-1).status, 'failed');
  assert.equal(verification.data.attempts.some((attempt) => ['prepared', 'running'].includes(attempt.status)), false);
});
