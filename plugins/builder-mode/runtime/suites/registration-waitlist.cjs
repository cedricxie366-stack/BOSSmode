'use strict';

const assert = require('node:assert/strict');
const { startCandidateServer } = require('./candidate-server-harness.js');

async function main() {
  const server = await startCandidateServer();
  const { baseUrl } = server;
  const register = (name, email) => fetch(`${baseUrl}/api/registrations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email }),
  });
  try {
    const first = await (await register('林青', 'lin@example.com')).json();
    const second = await (await register('周然', 'zhou@example.com')).json();
    const waiting = await (await register('顾宁', 'gu@example.com')).json();
    const laterWaiting = await (await register('邵雨', 'shao@example.com')).json();
    assert.equal(first.registration.status, 'confirmed');
    assert.equal(second.registration.status, 'confirmed');
    assert.equal(waiting.registration.status, 'waitlisted');
    assert.equal(laterWaiting.registration.status, 'waitlisted');
    assert.deepEqual(laterWaiting.state.waitlist.map((item) => item.name), ['顾宁', '邵雨']);

    const duplicate = await register('重复顾宁', 'GU@EXAMPLE.COM');
    assert.equal(duplicate.status, 409);

    const cancelWaiting = await fetch(`${baseUrl}/api/registrations/${laterWaiting.registration.id}`, {
      method: 'DELETE',
    });
    assert.equal(cancelWaiting.status, 200);
    const afterWaitingCancel = await cancelWaiting.json();
    assert.equal(afterWaitingCancel.promoted, null);
    assert.deepEqual(afterWaitingCancel.state.confirmed.map((item) => item.name), ['林青', '周然']);
    assert.deepEqual(afterWaitingCancel.state.waitlist.map((item) => item.name), ['顾宁']);

    const cancelled = await fetch(`${baseUrl}/api/registrations/${first.registration.id}`, {
      method: 'DELETE',
    });
    assert.equal(cancelled.status, 200);
    const result = await cancelled.json();
    assert.equal(result.promoted.id, waiting.registration.id);
    assert.deepEqual(result.state.confirmed.map((item) => item.name), ['周然', '顾宁']);
    assert.deepEqual(result.state.waitlist, []);

    const page = await fetch(baseUrl);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /候补名单/);
    process.stdout.write('registration host verification passed\n');
  } finally {
    await server.stop();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
