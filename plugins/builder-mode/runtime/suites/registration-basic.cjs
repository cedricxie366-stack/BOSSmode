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
    const firstResponse = await register('林青', 'lin@example.com');
    assert.equal(firstResponse.status, 201);
    const first = await firstResponse.json();
    assert.equal(first.registration.status, 'confirmed');
    const stored = await (await fetch(`${baseUrl}/api/registrations`)).json();
    const storedState = stored.state ?? stored;
    assert.equal(storedState.confirmed.length, 1);
    assert.equal(storedState.confirmed[0].name, '林青');
    assert.equal(storedState.confirmed[0].email.toLowerCase(), 'lin@example.com');

    const duplicate = await register('重复林青', 'LIN@EXAMPLE.COM');
    assert.equal(duplicate.status, 409);

    const page = await fetch(baseUrl);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /报名/);
    process.stdout.write('basic registration host verification passed\n');
  } finally {
    await server.stop();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
