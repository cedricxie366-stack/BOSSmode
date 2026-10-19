'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server');

async function withServer(run) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

function register(baseUrl, name, email) {
  return fetch(`${baseUrl}/api/registrations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email }),
  });
}

function cancel(baseUrl, id) {
  return fetch(`${baseUrl}/api/registrations/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

async function getState(baseUrl) {
  const response = await fetch(`${baseUrl}/api/state`);
  assert.equal(response.status, 200);
  return response.json();
}

describe('活动报名服务', () => {
  test('静态首页由同一服务提供并说明候补名单', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(baseUrl);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /text\/html/);
      const html = await response.text();
      assert.match(html, /社区木作入门/);
      assert.match(html, /候补名单/);
    });
  });

  test('初始状态为空且首位报名确认，并修剪输入值', async () => {
    await withServer(async (baseUrl) => {
      assert.deepEqual(await getState(baseUrl), {
        capacity: 2,
        confirmed: [],
        waitlist: [],
        remainingSeats: 2,
      });

      const response = await register(baseUrl, '  林青  ', '  Lin@example.com  ');
      assert.equal(response.status, 201);
      const body = await response.json();
      assert.equal(body.registration.name, '林青');
      assert.equal(body.registration.email, 'Lin@example.com');
      assert.equal(body.registration.status, 'confirmed');
      assert.equal(body.state.capacity, 2);
      assert.equal(body.state.remainingSeats, 1);
      assert.equal(body.state.confirmed.length, 1);
      assert.deepEqual(body.state.waitlist, []);
    });
  });

  test('无效姓名和邮箱返回 400 且不创建报名', async () => {
    await withServer(async (baseUrl) => {
      const missingName = await register(baseUrl, '   ', 'valid@example.com');
      assert.equal(missingName.status, 400);
      assert.deepEqual(await missingName.json(), { error: '请输入姓名' });

      const invalidEmail = await register(baseUrl, '林青', 'not-an-email');
      assert.equal(invalidEmail.status, 400);
      assert.deepEqual(await invalidEmail.json(), { error: '请输入有效的邮箱地址' });

      const state = await getState(baseUrl);
      assert.equal(state.confirmed.length, 0);
      assert.equal(state.waitlist.length, 0);
    });
  });

  test('容量只分配两个确认席位，之后按 FIFO 顺序加入候补名单', async () => {
    await withServer(async (baseUrl) => {
      const first = await register(baseUrl, '林青', 'lin@example.com');
      const second = await register(baseUrl, '周然', 'zhou@example.com');
      const third = await register(baseUrl, '顾宁', 'gu@example.com');
      const fourth = await register(baseUrl, '孟遥', 'meng@example.com');

      assert.equal(first.status, 201);
      assert.equal(second.status, 201);
      assert.equal(third.status, 201);
      assert.equal(fourth.status, 201);
      assert.equal((await first.json()).registration.status, 'confirmed');
      assert.equal((await second.json()).registration.status, 'confirmed');
      assert.equal((await third.json()).registration.status, 'waitlisted');
      assert.equal((await fourth.json()).registration.status, 'waitlisted');

      const state = await getState(baseUrl);
      assert.equal(state.capacity, 2);
      assert.equal(state.remainingSeats, 0);
      assert.deepEqual(state.confirmed.map(({ name }) => name), ['林青', '周然']);
      assert.deepEqual(state.waitlist.map(({ name }) => name), ['顾宁', '孟遥']);
      assert.ok(state.waitlist.every(({ status }) => status === 'waitlisted'));
    });
  });

  test('重复邮箱不区分大小写，并同时覆盖确认与候补名单', async () => {
    await withServer(async (baseUrl) => {
      await register(baseUrl, '林青', 'lin@example.com');
      await register(baseUrl, '周然', 'zhou@example.com');
      await register(baseUrl, '顾宁', 'gu@example.com');

      const confirmedDuplicate = await register(baseUrl, '另一位林青', 'LIN@EXAMPLE.COM');
      assert.equal(confirmedDuplicate.status, 409);
      assert.deepEqual(await confirmedDuplicate.json(), { error: '该邮箱已完成报名' });

      const waitlistedDuplicate = await register(baseUrl, '另一位顾宁', 'GU@EXAMPLE.COM');
      assert.equal(waitlistedDuplicate.status, 409);
      assert.deepEqual(await waitlistedDuplicate.json(), { error: '该邮箱已完成报名' });

      const state = await getState(baseUrl);
      assert.equal(state.confirmed.length, 2);
      assert.equal(state.waitlist.length, 1);
    });
  });

  test('取消已确认报名会自动提升最早候补者并保持后续队列顺序', async () => {
    await withServer(async (baseUrl) => {
      const first = await (await register(baseUrl, '林青', 'lin@example.com')).json();
      await register(baseUrl, '周然', 'zhou@example.com');
      const earliestWaiting = await (await register(baseUrl, '顾宁', 'gu@example.com')).json();
      await register(baseUrl, '孟遥', 'meng@example.com');

      const response = await cancel(baseUrl, first.registration.id);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.cancelled.id, first.registration.id);
      assert.equal(body.cancelled.status, 'confirmed');
      assert.equal(body.promoted.id, earliestWaiting.registration.id);
      assert.equal(body.promoted.name, '顾宁');
      assert.equal(body.promoted.status, 'confirmed');
      assert.equal(body.state.remainingSeats, 0);
      assert.deepEqual(body.state.confirmed.map(({ name }) => name), ['周然', '顾宁']);
      assert.deepEqual(body.state.waitlist.map(({ name }) => name), ['孟遥']);
    });
  });

  test('取消候补者只移除该队列项且不触发提升', async () => {
    await withServer(async (baseUrl) => {
      await register(baseUrl, '林青', 'lin@example.com');
      await register(baseUrl, '周然', 'zhou@example.com');
      const firstWaiting = await (await register(baseUrl, '顾宁', 'gu@example.com')).json();
      await register(baseUrl, '孟遥', 'meng@example.com');

      const response = await cancel(baseUrl, firstWaiting.registration.id);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.cancelled.status, 'waitlisted');
      assert.equal(body.promoted, null);
      assert.equal(body.state.remainingSeats, 0);
      assert.deepEqual(body.state.confirmed.map(({ name }) => name), ['林青', '周然']);
      assert.deepEqual(body.state.waitlist.map(({ name }) => name), ['孟遥']);
    });
  });

  test('无人候补时取消已确认报名会释放席位', async () => {
    await withServer(async (baseUrl) => {
      const registered = await (await register(baseUrl, '林青', 'lin@example.com')).json();
      const response = await cancel(baseUrl, registered.registration.id);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.cancelled.id, registered.registration.id);
      assert.equal(body.promoted, null);
      assert.equal(body.state.remainingSeats, 2);
      assert.deepEqual(body.state.confirmed, []);
      assert.deepEqual(body.state.waitlist, []);
    });
  });

  test('取消未知编号返回 404 且不改变状态', async () => {
    await withServer(async (baseUrl) => {
      await register(baseUrl, '林青', 'lin@example.com');
      const before = await getState(baseUrl);

      const response = await cancel(baseUrl, 'not-found');
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: '未找到该报名记录' });
      assert.deepEqual(await getState(baseUrl), before);
    });
  });
});
