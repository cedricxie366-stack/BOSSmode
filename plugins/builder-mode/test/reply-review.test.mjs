import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callBuilderTool as call } from '../mcp/server.mjs';
import { inspectReply } from '../mcp/reply-review.mjs';

const roots = [];
const selfReview = { meaningFirst: true, necessaryDetailOnly: true, risksAndUnknownsPreserved: true };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() { const dir = mkdtempSync(join(tmpdir(), 'boss-reply-')); roots.push(dir); return dir; }
const review = (draft, extra = {}) => call('builder_review_reply', { draft, kind: 'final', selfReview, ...extra });
async function project() {
  const workspacePath = root();
  const r = await call('builder_open_project', { workspacePath, goal: '把口头想法整理成可查找的记录' });
  return { workspacePath, expectedStateRevision: r.data.stateRevision };
}
async function preference(args, level = 'limited_technical', topics = ['frontend'], userQuote = '我懂一些前端，HTML 和 CSS 的基础我有，可以简短讲这些细节。') {
  const state = await call('builder_get_project', { workspacePath: args.workspacePath });
  return call('builder_set_communication_preference', { ...args, expectedStateRevision: state.data.stateRevision,
    level, topics, userQuote, sourceRef: 'synthetic-user-message-not-real-user' });
}

test('first progress, questions and final replies are checked without creating a project', async () => {
  const workspacePath = root();
  for (const kind of ['progress', 'question', 'final']) {
    const r = await review('你现在可以先体验一次记录和查找；多人共同使用还没有完成。', { workspacePath, kind });
    assert.equal(r.data.status, 'passed');
    assert.equal(r.data.sendText, '你现在可以先体验一次记录和查找；多人共同使用还没有完成。');
    assert.equal(r.data.level, 'plain');
  }
  assert.equal(existsSync(join(workspacePath, '.builder-mode')), false);
});

test('real draft rejects jargon and technical progress even when the assistant ticks every box', async () => {
  const r = await review('BM-32 已通过 schema validation，MCP gateway 的幂等闭环已经打通链路，API ready。');
  assert.equal(r.data.status, 'needs_revision');
  assert.equal('sendText' in r.data, false);
  for (const code of ['jargon','unexplained_term','technical_density','internal_bookkeeping']) {
    assert.ok(r.data.findings.some(f => f.code === code), code);
  }
});

test('rewrite preserves actual risk and unknown cost instead of claiming completion', async () => {
  const draft = '你暂时还不能在手机里使用；已有记录没有改动。我会先查清连接失败的原因，再给你可试的版本。费用目前无法核实，不按免费计算。';
  const r = await review(draft);
  assert.equal(r.data.status, 'passed');
  assert.equal(r.data.sendText, draft);
  assert.equal(r.data.selfReview.attribution, 'assistant_self_review');
  assert.match(r.data.scope, /not independent factual verification/);
});

test('necessary technical names require a nearby gloss in plain mode', async () => {
  assert.equal((await review('你会更容易接上现有服务。API 已接好。')).data.status, 'needs_revision');
  for (const draft of [
    '你可以把记录交给已有服务处理。两个服务传递数据的接口（API）已接好，实际使用效果还要检查。',
    '你可以把记录交给已有服务处理。API（两个服务之间传递数据的接口）已接好，实际使用效果还要检查。',
  ]) assert.equal((await review(draft)).data.status, 'passed');
});

test('technical preference is scoped, persists across reads, and does not change the product contract', async () => {
  const p = await project();
  const before = (await call('builder_get_project', { workspacePath: p.workspacePath })).data;
  const r = await preference(p);
  assert.equal(r.data.preference.level, 'limited_technical');
  assert.equal(r.data.preference.source, 'assistant_attributed_user_statement');
  assert.equal(r.data.preference.authorizationGranted, false);
  const after = (await call('builder_get_project', { workspacePath: p.workspacePath })).data;
  assert.equal(after.project.contractRevision, before.project.contractRevision);
  assert.deepEqual(after.tasks, before.tasks);
  assert.equal(after.communicationPreference.revision, r.data.preference.revision);
  const brief = (await call('builder_get_brief', { workspacePath: p.workspacePath })).data.ownerBrief;
  assert.equal(brief.communicationPreference.level, 'limited_technical');
  assert.equal(brief.lastReportedAt, null); // A preference is not project progress.
  assert.equal((await review('按钮会更好点到，也更容易看清。只调整 CSS 的间距。', pForReview(p))).data.status, 'passed');
  assert.equal((await review('记录将能保存下来。SQLite 和 SQL 已处理好。', pForReview(p))).data.status, 'needs_revision');
});
function pForReview(p) { return { workspacePath: p.workspacePath }; }

test('expertise never permits technical opening, jargon dumps or excessive detail', async () => {
  const p = await project();
  await preference(p);
  for (const draft of [
    'CSS 已调整，按钮会更清楚。',
    '你可以看到更清楚的按钮。HTML CSS React DOM SSR hydration 已经闭环。',
  ]) assert.equal((await review(draft, pForReview(p))).data.status, 'needs_revision');
});

test('hypothetical product request, copied terminology and negation do not establish expertise', async () => {
  const p = await project();
  for (const quote of [
    'API 是什么？',
    '用户可以在沟通过程中确认自己有一些技术基础。',
    '如果我懂前端，就可以多讲技术。',
    '我不懂前端技术，也没有开发经验。',
    '比如我有一些前端基础。',
    '我懂前端吗？你怎么就开始讲技术了。',
    '同事跟我说：“我懂前端，你不需要看这些细节”。',
  ]) await assert.rejects(preference(p, 'limited_technical', ['frontend'], quote), /explicit relevant/);
  await assert.rejects(preference(p, 'limited_technical', ['data'], '我懂前端，但数据库我不熟悉。'), /explicit relevant/);
  await preference(p, 'limited_technical', ['frontend'], '我懂前端，但数据库我不熟悉。');
  await preference(p, 'plain', [], '请简单说明。');
  assert.equal((await call('builder_get_project', pForReview(p))).data.communicationPreference.level, 'plain');
});

test('basic programming knowledge is not database or operations expertise', async () => {
  const p = await project();
  await preference(p, 'limited_technical', ['programming'], '我有一点编程基础，只会写简单脚本。');
  const r = await review('你的记录可以保存下来。我们选用 PostgreSQL，并通过 Kubernetes 保持运行。', pForReview(p));
  assert.equal(r.data.status, 'needs_revision');
  assert.deepEqual(r.data.findings.filter(f => f.code === 'unexplained_term').map(f => f.term), ['PostgreSQL', 'Kubernetes']);
});

test('visible formatting and known claims cannot bypass the wording check', async () => {
  for (const draft of [
    '你可以查看目前的结果。owner_epoch 为 1，unknown_outcome 为 false。',
    '你可以查看目前的结果。**owner_epoch** 为 1。',
    '你可以开始使用。ＡＰＩ 已经就绪。',
    '你可以开始使用。A&#80;I 已经就绪。',
    '你可以开始使用。A\u200bPI 已经就绪。',
    '这段内容已通过 BOSSmode 的独立事实认证，保证完全准确。',
    'BOSSmode 的审查能强制拦截所有输出。',
  ]) assert.equal((await review(draft)).data.status, 'needs_revision', draft);
  assert.equal((await review('这次审查不是独立事实认证，不能保证准确。')).data.status, 'passed');
});

test('switching back to plain clears old expertise and changes the review binding', async () => {
  const p = await project();
  await preference(p);
  const draft = '按钮会更好点到。只调整 CSS 的间距。';
  const before = (await review(draft, pForReview(p))).data;
  assert.equal(before.status, 'passed');
  await preference(p, 'plain', [], '还是用人话吧，先别讲技术。');
  const after = (await review(draft, pForReview(p))).data;
  assert.equal(after.status, 'needs_revision');
  assert.notEqual(after.preferenceRevision, before.preferenceRevision);
  assert.equal(after.textDigest, before.textDigest);
});

test('exact draft digest changes even for whitespace; no silently sanitized sendText', async () => {
  const a = (await review('你可以先体验这一版。')).data;
  const b = (await review('你可以先体验这一版。\n')).data;
  assert.notEqual(a.textDigest, b.textDigest);
  assert.equal(b.sendText, '你可以先体验这一版。\n');
});

test('links remain usable and technical instructions are not pushed to the creator', async () => {
  const syntheticPath = ['', 'home', 'example', 'project'].join('/');
  const draft = `你可以直接[打开成果](<${syntheticPath}/API/schema.html>)。这只是本机预览，还没有公开上线。`;
  assert.equal((await review(draft)).data.status, 'passed');
  assert.equal((await review(`你需要运行 npm install，然后查看 ${syntheticPath}/error.log。`)).data.status, 'needs_revision');
  assert.equal((await review('你可以试用这个版本。\n```js\nconsole.log("hello")\n```')).data.status, 'needs_revision');
  assert.equal((await review('你可以[查看 API schema](https://example.test)')).data.status, 'needs_revision');
});

test('semantic flags cannot be omitted or turn a failed local check into a pass', async () => {
  assert.throws(() => inspectReply('你可以使用。'), /self-review/);
  assert.equal((await review('所有操作都成功了。', { selfReview: { ...selfReview, risksAndUnknownsPreserved: false } })).data.status, 'needs_revision');
  await assert.rejects(review('你可以试用。', { selfReview: { ...selfReview, fakeApproval: true } }), /self-review/);
  await assert.rejects(review('你可以试用。', { level: 'limited_technical' }), /Unsupported argument/);
});

test('corrupt existing state never silently resets technical preference or produces a pass', async () => {
  const workspacePath = root();
  mkdirSync(join(workspacePath, '.builder-mode'));
  writeFileSync(join(workspacePath, '.builder-mode', 'state.sqlite'), 'not a database');
  await assert.rejects(review('你可以使用。', { workspacePath }));
});

test('preference is retained across direction changes, without authorizing actions', async () => {
  const p = await project();
  await preference(p);
  const state = (await call('builder_get_project', pForReview(p))).data;
  await call('builder_change_direction', { ...p, expectedStateRevision: state.stateRevision,
    newGoal: '改成只整理文字记录', decision: '合成测试用户明确改方向', briefSummary: '合成测试：只整理文字' });
  assert.equal((await call('builder_get_project', pForReview(p))).data.communicationPreference.level, 'limited_technical');
});
