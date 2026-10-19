'use strict';

const assert = require('node:assert/strict');
const { chmodSync, mkdtempSync, readdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const { startCandidateServer } = require('./candidate-server-harness.js');

function makeWritable(root) {
  chmodSync(root, 0o700);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) makeWritable(path.join(root, entry.name));
  }
}

async function start(dataRoot) {
  return startCandidateServer(process.cwd(), {
    writableRoots: [dataRoot],
    env: { BUILDER_PRODUCT_DATA_DIR: dataRoot },
  });
}

async function register(baseUrl, name, email) {
  const response = await fetch(`${baseUrl}/api/registrations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

async function main() {
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'builder-registration-data-'));
  let server;
  try {
    server = await start(dataRoot);
    const first = await register(server.baseUrl, '林青', 'lin@example.com');
    await register(server.baseUrl, '周然', 'zhou@example.com');
    const waiting = await register(server.baseUrl, '顾宁', 'gu@example.com');
    assert.equal(waiting.registration.status, 'waitlisted');
    const duplicate = await fetch(`${server.baseUrl}/api/registrations`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '重复顾宁', email: 'GU@EXAMPLE.COM' }),
    });
    assert.equal(duplicate.status, 409);
    await server.stop();

    server = await start(dataRoot);
    let state = await (await fetch(`${server.baseUrl}/api/registrations`)).json();
    state = state.state ?? state;
    assert.deepEqual(state.confirmed.map((item) => item.name), ['林青', '周然']);
    assert.deepEqual(state.waitlist.map((item) => item.name), ['顾宁']);

    const backupResponse = await fetch(`${server.baseUrl}/api/backups`, { method: 'POST' });
    assert.equal(backupResponse.status, 201);
    const backup = await backupResponse.json();
    assert.equal(backup.backup.registrationCount, 3);
    assert.match(backup.backup.id, /^[a-zA-Z0-9_.-]+$/u);
    assert.ok(Number.isFinite(Date.parse(backup.backup.createdAt)));
    const unconfirmedRestore = await fetch(`${server.baseUrl}/api/backups/${backup.backup.id}/restore`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"confirm":false}',
    });
    assert.equal(unconfirmedRestore.status, 400);
    const extra = await register(server.baseUrl, '邵雨', 'shao@example.com');
    const removedWaiting = await fetch(`${server.baseUrl}/api/registrations/${extra.registration.id}`, { method: 'DELETE' });
    assert.equal(removedWaiting.status, 200);
    const waitingResult = await removedWaiting.json();
    assert.equal(waitingResult.promoted, null);
    assert.deepEqual(waitingResult.state.waitlist.map((item) => item.name), ['顾宁']);

    const cancelled = await fetch(`${server.baseUrl}/api/registrations/${first.registration.id}`, { method: 'DELETE' });
    assert.equal(cancelled.status, 200);
    const changed = await cancelled.json();
    assert.equal(changed.promoted.id, waiting.registration.id);

    const restoreResponse = await fetch(`${server.baseUrl}/api/backups/${backup.backup.id}/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(restoreResponse.status, 200);
    const restored = await restoreResponse.json();
    assert.equal(restored.safetyBackup.created, true);
    assert.equal(restored.integrity, 'ok');
    assert.equal(restored.state.confirmed[0].name, '林青');
    assert.equal(restored.state.waitlist[0].name, '顾宁');

    await server.stop();
    server = await start(dataRoot);
    state = await (await fetch(`${server.baseUrl}/api/registrations`)).json();
    state = state.state ?? state;
    assert.deepEqual(state.confirmed.map((item) => item.name), ['林青', '周然']);
    assert.deepEqual(state.waitlist.map((item) => item.name), ['顾宁']);
    process.stdout.write('persistent registration backup/restore verification passed\n');
  } finally {
    if (server) await server.stop().catch(() => {});
    makeWritable(dataRoot);
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
