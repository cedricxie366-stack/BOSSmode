import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync, existsSync, readFileSync, cpSync } from 'node:fs';
import { resolve, join } from 'node:path';
const [plugin, output] = process.argv.slice(2).map(v=>resolve(v));
if (existsSync(output)) throw new Error('Use a fresh audit output directory');
const workspacePath = join(output,'workspace'); mkdirSync(join(workspacePath,'product'),{recursive:true});
const began = Date.now(), trace = []; let child, next=1, pending=new Map(), errors='';
async function launch() {
  child=spawn(process.execPath,[join(plugin,'mcp/server.mjs')],{cwd:plugin,stdio:['pipe','pipe','pipe']});
  child.stderr.on('data',d=>{errors=(errors+d).slice(-3000);});
  createInterface({input:child.stdout}).on('line',line=>{const message=JSON.parse(line),p=pending.get(message.id);if(p){pending.delete(message.id);clearTimeout(p.timer);p.resolve(message);}});
  child.on('exit',code=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('Server exited '+code+' '+errors));} pending.clear();});
  await request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'owner-journey-replay',version:'1'}});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
}
async function stop() {const ended=once(child,'exit');child.stdin.end();child.kill('SIGTERM');await ended;}
function request(method,params) {const id=next++;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Timed out '+method));},60000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});}
async function call(name,args={}) {
  const reply=await request('tools/call',{name,arguments:{workspacePath,...args}});
  trace.push({name,status:reply.result?.structuredContent?.status ?? null,isError:reply.result?.isError ?? false,
    revision:reply.result?.structuredContent?.stateRevision ?? null});
  if(reply.error||reply.result?.isError) throw new Error(JSON.stringify(reply));
  return reply.result.structuredContent;
}
const basePlan={checks:[{id:'start',kind:'text_contains',path:'guide.md',value:'怎么开始'},
  {id:'feedback',kind:'text_contains',path:'guide.md',value:'怎么反馈'}],reviewCriteria:[{id:'useful',text:'新用户能理解步骤，不需要工程知识；仍需真实用户验证'}]};
let plan=basePlan;
async function change(objective,body,diagnosis) {
  const current=await call('builder_get_project');
  const changed=await call('builder_begin_change',{expectedStateRevision:current.stateRevision,objective,candidatePath:'product',verificationProfile:'artifact-data-v1',acceptancePlan:plan,...(diagnosis?{diagnosis}:{})});
  writeFileSync(join(workspacePath,'product/guide.md'),body);
  return call('builder_verify_change',{expectedStateRevision:changed.stateRevision,taskId:changed.taskId,attemptId:changed.attemptId});
}
const first='# Builder 试用反馈小指南\n\n## 怎么开始\n描述你想完成什么，不必先拆任务或选择技术方案。\n\n## 怎么反馈\n告诉负责人哪里不顺手、你希望怎样，不必先写技术缺陷报告。\n';
try {
  await launch();
  const opened=await call('builder_open_project',{goal:'做一份简短的试用反馈指南，让参与者只描述目标和体验；内部自动演练，不是真实用户试用。'});
  const p=await call('builder_propose_plan',{expectedStateRevision:opened.stateRevision,userOutcome:'取回简短反馈指南',whereYouWillUseIt:'本地阅读',firstVersion:['说明怎么开始和怎么反馈'],
    notIncluded:['真实用户验证、上传资料和发布'],steps:['做第一版','按反馈修改并检查'],nextCheckpoint:'一份可阅读的指南'});
  await call('builder_record_plan_response',{expectedStateRevision:p.stateRevision,planId:p.planId,planDigest:p.planDigest,responseTo:'product_plan',response:'accept',
    userQuote:'合成测试回应：按这份本地指南方案做。',sourceRef:'automated-replay-not-real-user'});
  let version=await change('第一版可阅读指南',first); assert.equal(version.status,'needs_review');
  version=await change('小文案修改，保留原流程',first.replace('哪里不顺手','哪一步让你困惑')); assert.equal(version.status,'needs_review');
  const old=version;
  const contract=await call('builder_record_contract',{expectedStateRevision:version.stateRevision,rules:[{id:'feedback-destination',text:'演练中新要求：反馈仅保存在本地，不上传资料',status:'confirmed',source:'user'}]});
  plan={...basePlan,checks:[...basePlan.checks,{id:'local',kind:'text_contains',path:'guide.md',value:'仅保存在本地'}]};
  await stop(); await launch();
  const resumed=await call('builder_get_project');
  assert.equal(resumed.project.contractRevision,contract.project.contractRevision);
  assert.ok(resumed.rules.some(r=>r.id==='feedback-destination'&&r.text.includes('仅保存在本地')));
  const oldEvidence=old.evidence.find(e=>e.id===old.evidenceId);
  let oldRejected=false;
  try {await call('builder_prepare_delivery',{expectedStateRevision:resumed.stateRevision,taskId:old.taskId,attemptId:old.attemptId,verificationEvidenceId:oldEvidence.id,candidateDigest:oldEvidence.details.candidateDigest});}
  catch {oldRejected=true;} assert.ok(oldRejected);
  const failed=await change('受控故障：缺少刚确认的新要求',first); assert.equal(failed.status,'failed');
  const failureBrief=await call('builder_get_brief'); assert.equal(failureBrief.ownerBrief.phase,'failed');
  const repaired=await change('修复遗漏，保留原要求',first+'\n反馈仅保存在本地，不上传资料。\n','检查明确缺少新确认的本地反馈说明；补齐原句，不修改检查标准');
  assert.equal(repaired.status,'needs_review');
  const ev=repaired.evidence.find(e=>e.id===repaired.evidenceId);
  const binding={taskId:repaired.taskId,attemptId:repaired.attemptId,verificationEvidenceId:ev.id,candidateDigest:ev.details.candidateDigest};
  const reviewed=await call('builder_record_review',{...binding,expectedStateRevision:repaired.stateRevision,criterionId:'useful',reviewerType:'assistant',outcome:'unknown',comment:'脚本只验证结构和流程，是否好用尚无真实用户证据',sourceRef:'synthetic-automated-replay'});
  const delivered=await call('builder_prepare_delivery',{...binding,expectedStateRevision:reviewed.stateRevision});
  assert.equal(delivered.manifest.status,'needs_review');
  cpSync(join(delivered.destination,'product/guide.md'),join(output,'可阅读的试用反馈指南.md'));
  const current=await call('builder_get_project');
  assert.equal(current.tasks.filter(t=>t.status==='accepted').length,0);
  const report={kind:'automated-service-journey-not-human-trial',oldEvidenceRejected:oldRejected,
    sequence:['合成业务目标','可读第一版','小文案修改','确认新要求','真实服务重启续接','受控检查失败','有限修复','取回成果'],
    scope:'真实文件、MCP进程、检查/恢复记录；需求和反馈来自预设夹具，不是自主模型或真实用户',
    failureRetained:true,finalStatus:delivered.manifest.status,failedBrief:failureBrief.ownerBrief,
    humanTechnicalInterventions:null,repeatedUserExplanations:null,userInterventionMinutes:null,
    serviceReplayElapsedMs:Date.now()-began,wholeWorkflowElapsedMs:null,cost:null,trace};
  writeFileSync(join(output,'journey.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({status:'passed',oldEvidenceRejected:oldRejected,finalStatus:delivered.manifest.status,report:join(output,'journey.json')}));
} finally { if(child&&child.exitCode===null&&child.signalCode===null)await stop(); }
