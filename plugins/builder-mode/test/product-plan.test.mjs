import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { mkdtempSync,mkdirSync,writeFileSync,chmodSync,lstatSync,readdirSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Deliberately raw: these tests must exercise the gate without aligned fixtures.
import { callBuilderTool as call } from '../mcp/server.mjs';
const roots=[];
function writable(dir){if(!lstatSync(dir).isDirectory())return;chmodSync(dir,0o700);for(const name of readdirSync(dir))writable(join(dir,name));}
afterEach(()=>{for(const root of roots.splice(0)){writable(root);rmSync(root,{recursive:true,force:true});}});
async function fresh(){const workspacePath=mkdtempSync(join(tmpdir(),'builder-intake-'));roots.push(workspacePath);mkdirSync(join(workspacePath,'product'));writeFileSync(join(workspacePath,'product/note.txt'),'合成样例');return {workspacePath,...(await call('builder_open_project',{workspacePath,goal:'希望在微信里说出想法，自动整理并回看'})).data};}
const proposal = f => ({workspacePath:f.workspacePath,expectedStateRevision:f.stateRevision,
  userOutcome:'说完一个想法后能找回整理好的记录',whereYouWillUseIt:'目标是手机微信；手机录音和保存尚需验证，电脑预览不当作手机完成',
  firstVersion:['自己录音、整理和回看'],notIncluded:['多人分享、公开发布和付费服务'],steps:['先核实手机录音限制','制作并检查个人使用流程'],nextCheckpoint:'一段录音能保存并找回',openChoices:[]});
const change = f => ({workspacePath:f.workspacePath,expectedStateRevision:f.stateRevision,objective:'仅测试门槛，不代表语音应用已实现',candidatePath:'product',verificationProfile:'artifact-data-v1',
  acceptancePlan:{checks:[{id:'file',kind:'file',path:'note.txt'}],reviewCriteria:[{id:'quality',text:'仍需真实用户体验'}]}});
const response = (f,p) => ({workspacePath:f.workspacePath,expectedStateRevision:p.data.stateRevision,planId:p.data.planId,planDigest:p.data.planDigest,
  responseTo:'product_plan',response:'accept',userQuote:'合成测试回应：按这份首版方案做，先完成个人使用流程。',sourceRef:'test-fixture-not-real-user'});

test('new project cannot begin before discussion and a plan response',async()=>{
  const f=await fresh();
  await assert.rejects(call('builder_begin_change',change(f)),/PLAN_ALIGNMENT_REQUIRED/);
  const p=await call('builder_propose_plan',proposal(f));
  await assert.rejects(call('builder_begin_change',change({...f,stateRevision:p.data.stateRevision})),/PLAN_ALIGNMENT_REQUIRED/);
  const g=await call('builder_get_project',{workspacePath:f.workspacePath});
  assert.equal(g.data.tasks.length,0);assert.equal(g.data.productPlan.status,'awaiting_response');
  const b=await call('builder_get_brief',{workspacePath:f.workspacePath});
  assert.equal(b.data.ownerBrief.phase,'awaiting_plan_alignment');
  assert.match(b.message,/第一版|方案/);
});

test('GLM choice is preserved without accepting the whole product plan',async()=>{
  const f=await fresh(),p=await call('builder_propose_plan',proposal(f));
  const provider=await call('builder_record_product_context',{workspacePath:f.workspacePath,expectedStateRevision:p.data.stateRevision,
    items:[{id:'organizing-provider',kind:'decision',text:'合成用户选择GLM做整理服务',source:'user',sourceRef:'synthetic-provider-choice'}]});
  await assert.rejects(call('builder_begin_change',change({...f,stateRevision:provider.data.stateRevision})),/PLAN_ALIGNMENT_REQUIRED/);
  await assert.rejects(call('builder_record_plan_response',{...response(f,p),expectedStateRevision:provider.data.stateRevision,responseTo:'service_choice',userQuote:'试用glm作为自动整理的ai服务'}),/service choice/);
  const g=await call('builder_get_project',{workspacePath:f.workspacePath});
  assert.equal(g.data.productPlan.status,'awaiting_response'); assert.equal(g.data.tasks.length,0);
});

test('one recorded alignment permits ordinary same-goal revisions without repeated kickoff',async()=>{
  const f=await fresh(),p=await call('builder_propose_plan',proposal(f));
  const accepted=await call('builder_record_plan_response',response(f,p));
  assert.equal(accepted.data.authorizationGranted,false);assert.equal(accepted.data.attestation,'assistant_attributed');
  const c=await call('builder_begin_change',change({...f,stateRevision:accepted.data.stateRevision}));
  const verified=await call('builder_verify_change',{workspacePath:f.workspacePath,expectedStateRevision:c.data.stateRevision,taskId:c.data.taskId,attemptId:c.data.attemptId});
  const updated=await call('builder_record_contract',{workspacePath:f.workspacePath,expectedStateRevision:verified.data.stateRevision,rules:[{id:'wording',text:'普通文案修改',status:'confirmed',source:'user'}]});
  const second=await call('builder_begin_change',change({...f,stateRevision:updated.data.stateRevision}));
  assert.equal(second.data.productPlan.status,'aligned');
  const denied=await call('builder_check_action',{workspacePath:f.workspacePath,action:'public_publish',resource:'synthetic',idempotencyKey:'still-no-permission'});
  assert.equal(denied.data.allowed,false);
});

test('new proposal and new goal cannot reuse an old plan response',async()=>{
  const f=await fresh(),p=await call('builder_propose_plan',proposal(f));
  const accepted=await call('builder_record_plan_response',response(f,p));
  const p2=await call('builder_propose_plan',{...proposal({...f,stateRevision:accepted.data.stateRevision}),firstVersion:['改成多人共享，需要另行讨论权限']});
  await assert.rejects(call('builder_record_plan_response',{...response(f,p),expectedStateRevision:p2.data.stateRevision}),/latest plan/);
  await assert.rejects(call('builder_begin_change',change({...f,stateRevision:p2.data.stateRevision})),/PLAN_ALIGNMENT_REQUIRED/);
  const direction=await call('builder_change_direction',{workspacePath:f.workspacePath,expectedStateRevision:p2.data.stateRevision,newGoal:'改为内容策划',decision:'合成方向调整',briefSummary:'合成测试'});
  assert.equal(direction.data.productPlan.status,'not_discussed');
  await assert.rejects(call('builder_begin_change',change({...f,stateRevision:direction.data.stateRevision})),/PLAN_ALIGNMENT_REQUIRED/);
});

test('open choices cannot be silently accepted and identical proposals are not duplicated',async()=>{
  const f=await fresh();
  const args={...proposal(f),openChoices:['是否必须多人使用？']};
  const p=await call('builder_propose_plan',args);
  await assert.rejects(call('builder_record_plan_response',response(f,p)),/open choices/);
  const same=await call('builder_propose_plan',{...args,expectedStateRevision:p.data.stateRevision});
  assert.equal(same.data.planId,p.data.planId);assert.equal(same.data.stateRevision,p.data.stateRevision);
});

test('meaning-first progress does not require the user to interpret technical focus',async()=>{
  const f=await fresh(),p=await call('builder_propose_plan',proposal(f));
  const accepted=await call('builder_record_plan_response',response(f,p));
  await assert.rejects(call('builder_record_update',{workspacePath:f.workspacePath,expectedStateRevision:accepted.data.stateRevision,
    currentFocus:'HTTPS deployment',expectedEffect:'phone access',nextAction:'configure gateway',nextCheckpoint:'test'}),/meaningForYou/);
  const c=await call('builder_begin_change',change({...f,stateRevision:accepted.data.stateRevision}));
  const v=await call('builder_verify_change',{workspacePath:f.workspacePath,expectedStateRevision:c.data.stateRevision,taskId:c.data.taskId,attemptId:c.data.attemptId});
  const meaning='目前只检查了电脑上的演示，手机微信的录音和保存还没验证。';
  await call('builder_record_update',{workspacePath:f.workspacePath,expectedStateRevision:v.data.stateRevision,meaningForYou:meaning,
    currentFocus:'HTTPS / device validation',expectedEffect:'希望手机也能使用，尚未确认',nextAction:'负责人检查手机录音和保存',nextCheckpoint:'能在手机录音后找回记录'});
  const brief=await call('builder_get_brief',{workspacePath:f.workspacePath});
  assert.ok(brief.message.startsWith(meaning));assert.equal(brief.message.includes('HTTPS'),false);
  assert.equal(brief.data.ownerBrief.productPlan.status,'aligned');
});

test('replacing a completed plan removes its old results and prevents old review/delivery',async()=>{
  const f=await fresh(),p=await call('builder_propose_plan',proposal(f));
  const a=await call('builder_record_plan_response',response(f,p));
  const c=await call('builder_begin_change',change({...f,stateRevision:a.data.stateRevision}));
  const v=await call('builder_verify_change',{workspacePath:f.workspacePath,expectedStateRevision:c.data.stateRevision,taskId:c.data.taskId,attemptId:c.data.attemptId});
  const ev=v.data.evidence.find(e=>e.id===v.data.evidenceId);
  const u=await call('builder_record_update',{workspacePath:f.workspacePath,expectedStateRevision:v.data.stateRevision,meaningForYou:'旧电脑样例可查看',
    currentFocus:'旧电脑样例',expectedEffect:'旧范围',nextAction:'旧下一步',nextCheckpoint:'旧电脑结果',evidenceRefs:[ev.id]});
  const p2=await call('builder_propose_plan',{...proposal({...f,stateRevision:u.data.stateRevision}),firstVersion:['改为手机微信实际录音保存']});
  const brief=await call('builder_get_brief',{workspacePath:f.workspacePath});
  assert.equal(brief.data.ownerBrief.phase,'awaiting_plan_alignment');assert.deepEqual(brief.data.ownerBrief.results,[]);
  assert.equal(brief.message.includes('旧电脑样例可查看'),false);
  const binding={workspacePath:f.workspacePath,expectedStateRevision:p2.data.stateRevision,taskId:c.data.taskId,attemptId:c.data.attemptId,verificationEvidenceId:ev.id,candidateDigest:ev.details.candidateDigest};
  await assert.rejects(call('builder_prepare_delivery',binding),/PLAN_ALIGNMENT_REQUIRED/);
  const a2=await call('builder_record_plan_response',response(f,p2));
  await assert.rejects(call('builder_prepare_delivery',{...binding,expectedStateRevision:a2.data.stateRevision}),/older product plan/);
  const notStarted=await call('builder_get_brief',{workspacePath:f.workspacePath});
  assert.equal(notStarted.data.ownerBrief.phase,'not_started');
  assert.deepEqual(notStarted.data.ownerBrief.results,[]);
  assert.equal(notStarted.message.includes('已有可查看的初稿'),false);
});

test('unfinished work cannot be stranded by replacing its plan',async()=>{
  const f=await fresh(),p=await call('builder_propose_plan',proposal(f));
  const a=await call('builder_record_plan_response',response(f,p));
  const c=await call('builder_begin_change',change({...f,stateRevision:a.data.stateRevision}));
  await assert.rejects(call('builder_propose_plan',{...proposal({...f,stateRevision:c.data.stateRevision}),firstVersion:['改为另一套范围']}),/收尾/);
  const v=await call('builder_verify_change',{workspacePath:f.workspacePath,expectedStateRevision:c.data.stateRevision,taskId:c.data.taskId,attemptId:c.data.attemptId});
  assert.equal(v.data.status,'needs_review');
  const p2=await call('builder_propose_plan',{...proposal({...f,stateRevision:v.data.stateRevision}),firstVersion:['改为另一套范围']});
  assert.equal(p2.data.status,'awaiting_response');
});

test('a later response cannot strand an unfinished writer by revoking its plan',async()=>{
  const f=await fresh(),p=await call('builder_propose_plan',proposal(f));
  const a=await call('builder_record_plan_response',response(f,p));
  const c=await call('builder_begin_change',change({...f,stateRevision:a.data.stateRevision}));
  for(const reply of ['revise','discuss']) await assert.rejects(call('builder_record_plan_response',{
    ...response(f,p),expectedStateRevision:c.data.stateRevision,response:reply,userQuote:'合成新反馈：我想调整方案，先讨论。'}),/收尾/);
  const context=await call('builder_record_product_context',{workspacePath:f.workspacePath,expectedStateRevision:c.data.stateRevision,
    items:[{id:'new-feedback',kind:'open_question',text:'合成新反馈：我想调整方案，先讨论。',source:'user',sourceRef:'synthetic-followup'}]});
  const v=await call('builder_verify_change',{workspacePath:f.workspacePath,expectedStateRevision:context.data.stateRevision,taskId:c.data.taskId,attemptId:c.data.attemptId});
  assert.equal(v.data.status,'needs_review');
  const r=await call('builder_record_plan_response',{...response(f,p),expectedStateRevision:v.data.stateRevision,response:'revise',userQuote:'合成新反馈：我想调整方案，先讨论。'});
  assert.equal(r.data.status,'needs_revision');
});
