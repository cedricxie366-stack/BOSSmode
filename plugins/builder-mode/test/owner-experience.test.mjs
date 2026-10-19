import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, chmodSync, lstatSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { callAlignedFixture as call } from './aligned-fixture.mjs';
const roots = [];
function writable(dir) { if (!lstatSync(dir).isDirectory()) return; chmodSync(dir,0o700); for (const name of readdirSync(dir)) writable(join(dir,name)); }
afterEach(() => { for (const root of roots.splice(0)) { writable(root); rmSync(root,{recursive:true,force:true}); } });
async function start() {
  const workspacePath = mkdtempSync(join(tmpdir(),'builder-owner-')); roots.push(workspacePath);
  const opened = await call('builder_open_project',{workspacePath,goal:'整理创意并知道下一步做什么'});
  return {workspacePath,expectedStateRevision:opened.data.stateRevision};
}
const update = args => ({...args,meaningForYou:'先让你一个人能方便地记录和找回想法',currentFocus:'先完成一个人使用的创意整理流程',expectedEffect:'希望减少找资料和重复整理的时间，尚未测量',
  nextAction:'负责人完成最小版本并检查保存和查找',nextCheckpoint:'你能体验一次新增和查找',risks:['多人协作暂不在当前范围']});
const decision = args => ({...args,category:'scope',question:'第一版是否必须支持多人共同编辑？',whyNow:'它会改变首批使用者和交付范围',responsibleRole:'产品负责人',
  recommendedOptionId:'single',recommendationReason:'先验证你自己的整理习惯，再决定协作需求',ifDeferred:'继续单人范围，不开启多人共享',
  options:[{id:'single',label:'先单人使用',expectedOutcome:'先解决自己的资料整理',costImpact:'不新增外部服务；总成本未知',timeImpact:'工作范围较小，暂无可靠日期',risk:'无法共同编辑',reversibility:'之后可另行扩展'},
    {id:'shared',label:'首版多人协作',expectedOutcome:'共同编辑同一批资料',costImpact:'需先核实账户与服务成本',timeImpact:'增加协作与权限工作，尚未估时',risk:'需要处理访问边界',reversibility:'方向可调整，但新增工作可能不能复用'}]});

test('owner brief persists business expectations without claiming progress percentage or approval', async () => {
  const args = await start();
  const before = await call('builder_get_project',{workspacePath:args.workspacePath});
  await call('builder_record_update',update(args));
  const brief = await call('builder_get_brief',{workspacePath:args.workspacePath});
  assert.equal(brief.data.ownerBrief.expectedEffect,'希望减少找资料和重复整理的时间，尚未测量');
  assert.deepEqual(brief.data.ownerBrief.results,[]);
  assert.equal(brief.data.ownerBrief.estimate.confidence,'unknown');
  assert.equal(brief.data.ownerBrief.needsYourDecision.length,0);
  const after = await call('builder_get_project',{workspacePath:args.workspacePath});
  assert.equal(after.data.project.contractRevision,before.data.project.contractRevision);
  assert.deepEqual(after.data.tasks,[]);
  assert.equal('percentComplete' in brief.data.ownerBrief,false);
  await assert.rejects(call('builder_record_update',{...update({...args,expectedStateRevision:after.data.stateRevision}),completed:true}),/Unsupported argument/);
});

test('business decisions require impacts and recommendation; user attribution cannot grant permission', async () => {
  const args = await start();
  const missing = decision(args); delete missing.options[0].costImpact;
  await assert.rejects(call('builder_prepare_decision',missing),/costImpact/);
  await assert.rejects(call('builder_prepare_decision',{...decision(args),category:'database'}),/business tradeoffs/);
  const prepared = await call('builder_prepare_decision',decision(args));
  const pending = await call('builder_get_brief',{workspacePath:args.workspacePath});
  assert.equal(pending.data.ownerBrief.needsYourDecision.length,1);
  assert.equal(pending.data.ownerBrief.phase,'waiting_for_decision');
  const chosen = await call('builder_record_decision_response',{workspacePath:args.workspacePath,expectedStateRevision:prepared.data.stateRevision,
    decisionId:prepared.data.decisionId,optionId:'single',userQuote:'合成测试选择：先单人使用',sourceRef:'synthetic-test-message'});
  assert.equal(chosen.data.authorizationGranted,false);
  const reopened = await call('builder_get_brief',{workspacePath:args.workspacePath});
  assert.equal(reopened.data.ownerBrief.needsYourDecision.length,0);
  assert.equal(reopened.data.ownerBrief.recordedDecisions[0].attestation,'assistant_attributed');
  const denied = await call('builder_check_action',{workspacePath:args.workspacePath,action:'public_publish',resource:'synthetic',idempotencyKey:'still-denied'});
  assert.equal(denied.data.allowed,false);
});

test('stale response or contract cannot silently resolve the wrong decision', async () => {
  const args = await start();
  const prepared = await call('builder_prepare_decision',decision(args));
  const changed = await call('builder_record_contract',{workspacePath:args.workspacePath,expectedStateRevision:prepared.data.stateRevision,
    rules:[{id:'different',text:'改为只整理已有公开资料',status:'assumed',source:'assistant'}]});
  await assert.rejects(call('builder_record_decision_response',{workspacePath:args.workspacePath,expectedStateRevision:changed.data.stateRevision,
    decisionId:prepared.data.decisionId,optionId:'single',userQuote:'旧选择',sourceRef:'synthetic'}),/current contract/);
  const brief = await call('builder_get_brief',{workspacePath:args.workspacePath});
  assert.deepEqual(brief.data.ownerBrief.needsYourDecision,[]);
  assert.equal(brief.data.ownerBrief.decisionsToReconcile.length,1);
  assert.equal(brief.data.ownerBrief.decisionsToReconcile[0].authorizationGranted,false);
});

test('registered running work is not proof of an active native executor', async () => {
  const args = await start();
  await call('builder_begin_change',{...args,objective:'登记但不启动真实执行者',candidatePath:'product',verificationProfile:'registration-basic-v1'});
  const brief = await call('builder_get_brief',{workspacePath:args.workspacePath});
  assert.equal(brief.data.ownerBrief.phase,'execution_unconfirmed');
  assert.equal(brief.data.ownerBrief.activityObserved,false);
  assert.ok(brief.data.ownerBrief.blockers.some(b=>b.kind==='execution_unconfirmed'));
});

test('reconciled old decisions stop repeating without answering or authorizing current choices', async () => {
  const args = await start();
  const old = await call('builder_prepare_decision',decision(args));
  const reconciliation = {workspacePath:args.workspacePath,expectedStateRevision:old.data.stateRevision,decisionId:old.data.decisionId,
    resolution:'no_longer_relevant',reason:'合成测试范围已变',sourceRef:'synthetic current requirement'};
  await assert.rejects(call('builder_reconcile_decision',reconciliation),/Only stale/);
  const changed = await call('builder_record_contract',{workspacePath:args.workspacePath,expectedStateRevision:old.data.stateRevision,
    rules:[{id:'scope',text:'合成要求变化',status:'assumed',source:'assistant'}]});
  const replacement = await call('builder_prepare_decision',decision({workspacePath:args.workspacePath,expectedStateRevision:changed.data.stateRevision}));
  const resolved = await call('builder_reconcile_decision',{...reconciliation,expectedStateRevision:replacement.data.stateRevision,
    resolution:'replaced',replacementDecisionId:replacement.data.decisionId});
  assert.equal(resolved.data.authorizationGranted,false);
  const brief = await call('builder_get_brief',{workspacePath:args.workspacePath});
  assert.equal(brief.data.ownerBrief.decisionsToReconcile.length,0);
  assert.equal(brief.data.ownerBrief.needsYourDecision.length,1);
  assert.equal(brief.data.ownerBrief.recordedDecisions.length,0);
  assert.equal(brief.data.ownerBrief.decisionReconciliations[0].attestation,'assistant_reconciliation');
  await assert.rejects(call('builder_reconcile_decision',{...reconciliation,expectedStateRevision:resolved.data.stateRevision}),/already answered or reconciled/);
});

test('unknown external outcome is visible in owner-facing blockers', async () => {
  const args = await start();
  await call('builder_check_action',{workspacePath:args.workspacePath,action:'public_publish',resource:'synthetic-only',idempotencyKey:'unknown-fixture'});
  const db = new DatabaseSync(join(args.workspacePath,'.builder-mode/policy.sqlite'));
  const payload = JSON.parse(db.prepare('SELECT payload FROM policy_journal WHERE id=1').get().payload);
  payload.intents[0].status = 'unknown';
  db.prepare('UPDATE policy_journal SET payload=? WHERE id=1').run(JSON.stringify(payload)); db.close();
  const brief = await call('builder_get_brief',{workspacePath:args.workspacePath});
  assert.equal(brief.data.ownerBrief.phase,'reconciliation_required');
  assert.ok(brief.data.ownerBrief.blockers.some(b=>b.kind==='unknown_operation'));
});

async function checkedDelivery() {
  const args = await start();
  mkdirSync(join(args.workspacePath,'product'));
  writeFileSync(join(args.workspacePath,'product/note.txt'),'内部合成指南');
  const change = await call('builder_begin_change',{...args,objective:'可取回的合成指南',candidatePath:'product',verificationProfile:'artifact-data-v1',
    acceptancePlan:{checks:[{id:'exists',kind:'file',path:'note.txt'}],reviewCriteria:[{id:'fit',text:'说明范围清楚'}]}});
  const verified = await call('builder_verify_change',{workspacePath:args.workspacePath,expectedStateRevision:change.data.stateRevision,taskId:change.data.taskId,attemptId:change.data.attemptId});
  const evidence = verified.data.evidence.find(e=>e.id===verified.data.evidenceId);
  const binding = {workspacePath:args.workspacePath,taskId:change.data.taskId,attemptId:change.data.attemptId,verificationEvidenceId:evidence.id,candidateDigest:evidence.details.candidateDigest};
  const review = {criterionId:'fit',reviewerType:'assistant',outcome:'satisfied',comment:'内部合成内容说明',sourceRef:'synthetic fixture'};
  const reviewed = await call('builder_record_review',{...binding,...review,expectedStateRevision:verified.data.stateRevision});
  const delivered = await call('builder_prepare_delivery',{...binding,expectedStateRevision:reviewed.data.stateRevision});
  const reported = await call('builder_record_update',{...update({workspacePath:args.workspacePath,expectedStateRevision:delivered.data.stateRevision}),evidenceRefs:[delivered.data.manifest.id]});
  return {binding,review,delivered,args:{...args,expectedStateRevision:reported.data.stateRevision}};
}

test('later requested changes remove the old delivery from current results', async () => {
  const f = await checkedDelivery();
  await call('builder_record_review',{...f.binding,...f.review,expectedStateRevision:f.args.expectedStateRevision,outcome:'changes_requested'});
  const brief = await call('builder_get_brief',{workspacePath:f.args.workspacePath});
  assert.deepEqual(brief.data.ownerBrief.results,[]);
  assert.ok(brief.data.ownerBrief.resultWarning);
});

for (const target of ['product/note.txt','host-report.json']) test(`delivery corruption is visible: ${target}`, async () => {
  const f = await checkedDelivery();
  writeFileSync(join(f.delivered.data.destination,target),'tampered fixture');
  const brief = await call('builder_get_brief',{workspacePath:f.args.workspacePath});
  assert.deepEqual(brief.data.ownerBrief.results,[]);
  assert.equal(brief.data.ownerBrief.phase,'evidence_unavailable');
});

test('changed candidate is not presented as a current checked result', async () => {
  const args = await start();
  mkdirSync(join(args.workspacePath,'product'));
  writeFileSync(join(args.workspacePath,'product/note.txt'),'合成说明');
  const changed = await call('builder_begin_change',{...args,objective:'验证文件',candidatePath:'product',verificationProfile:'artifact-data-v1',
    acceptancePlan:{checks:[{id:'exists',kind:'file',path:'note.txt'}],reviewCriteria:[{id:'fit',text:'内容适合目标用户'}]}});
  const verified = await call('builder_verify_change',{workspacePath:args.workspacePath,expectedStateRevision:changed.data.stateRevision,taskId:changed.data.taskId,attemptId:changed.data.attemptId});
  await call('builder_record_update',{...update({workspacePath:args.workspacePath,expectedStateRevision:verified.data.stateRevision}),evidenceRefs:[verified.data.evidenceId]});
  assert.equal((await call('builder_get_brief',{workspacePath:args.workspacePath})).data.ownerBrief.results.length,1);
  writeFileSync(join(args.workspacePath,'product/note.txt'),'合成修改后的说明');
  const brief = await call('builder_get_brief',{workspacePath:args.workspacePath});
  assert.deepEqual(brief.data.ownerBrief.results,[]);
  assert.ok(brief.data.ownerBrief.resultWarning);
});

test('schema four upgrade preserves project and saves a pre-upgrade copy', async () => {
  const args = await start();
  const filename = join(args.workspacePath,'.builder-mode/state.sqlite');
  const legacy = new DatabaseSync(filename);
  legacy.exec('DROP TABLE owner_experience_events; DELETE FROM schema_meta WHERE schema_version=5; INSERT OR IGNORE INTO schema_meta(schema_version) VALUES(4);'); legacy.close();
  const migrated = await call('builder_open_project',{workspacePath:args.workspacePath});
  assert.equal(migrated.data.project.goal,'整理创意并知道下一步做什么');
  const copies = readdirSync(join(args.workspacePath,'.builder-mode')).filter(n=>n.includes('.before-v5-'));
  assert.equal(copies.length,1);
  const before = new DatabaseSync(join(args.workspacePath,'.builder-mode',copies[0]),{readOnly:true});
  assert.equal(before.prepare('SELECT MAX(schema_version) AS v FROM schema_meta').get().v,4); before.close();
  await call('builder_get_brief',{workspacePath:args.workspacePath});
});

test('candidate parent link cannot move verification outside the product workspace', async () => {
  const args = await start();
  const outside = mkdtempSync(join(tmpdir(),'builder-outside-')); roots.push(outside);
  mkdirSync(join(outside,'product')); writeFileSync(join(outside,'product/note.txt'),'synthetic');
  symlinkSync(outside,join(args.workspacePath,'linked'));
  const change = await call('builder_begin_change',{...args,objective:'Scope probe',candidatePath:'linked/product',verificationProfile:'artifact-data-v1',
    acceptancePlan:{checks:[{id:'file',kind:'file',path:'note.txt'}],reviewCriteria:[{id:'fit',text:'Bounded scope'}]}});
  const verified = await call('builder_verify_change',{workspacePath:args.workspacePath,expectedStateRevision:change.data.stateRevision,taskId:change.data.taskId,attemptId:change.data.attemptId});
  assert.equal(verified.isError,true);
  assert.equal(verified.data.status,'failed');
  assert.match(verified.message,/outside/);
});
