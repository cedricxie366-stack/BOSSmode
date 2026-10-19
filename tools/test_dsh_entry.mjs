import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, lstatSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root=resolve(import.meta.dirname,'..');
const workspacePath=mkdtempSync(join(tmpdir(),'builder-dsh-entry-'));
const child=spawn(process.execPath,[join(root,'plugins/builder-mode-dsh/server.mjs')],{stdio:['pipe','pipe','ignore']});
let id=0;const pending=new Map();
const exited=new Promise(resolve=>child.once('exit',resolve));
function writable(directory){if(!lstatSync(directory).isDirectory())return;chmodSync(directory,0o700);for(const name of readdirSync(directory))writable(join(directory,name));}
createInterface({input:child.stdout}).on('line',line=>{const r=JSON.parse(line);pending.get(r.id)?.(r);pending.delete(r.id);});
const request=(method,params)=>new Promise(resolve=>{const next=++id;pending.set(next,resolve);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:next,method,params})+'\n');});
async function call(name,args={}){
  const r=(await request('tools/call',{name,arguments:{workspacePath,...args}})).result;
  assert.equal(r.isError,false,r.content?.[0]?.text);
  assert.deepEqual(JSON.parse(r.content[1].text),r.structuredContent);
  return r.structuredContent;
}
try{
  await request('initialize',{protocolVersion:'2025-11-25'});
  const p=await call('builder_open_project',{goal:'合成跨宿主产物验证'});
  assert.equal(p.runtimeHost,'dsh'); assert.equal(p.project.minimalExperiment.host,'dsh');
  const plan=await call('builder_propose_plan',{expectedStateRevision:p.stateRevision,userOutcome:'合成样例文件',whereYouWillUseIt:'隔离本地目录',firstVersion:['一个说明文件'],notIncluded:['真实服务和外发'],steps:['生成并检查'],nextCheckpoint:'可读取说明文件'});
  const a=await call('builder_record_plan_response',{expectedStateRevision:plan.stateRevision,planId:plan.planId,planDigest:plan.planDigest,responseTo:'product_plan',response:'accept',userQuote:'合成测试：按此计划做。',sourceRef:'automated-fixture-not-user-acceptance'});
  mkdirSync(join(workspacePath,'product'));writeFileSync(join(workspacePath,'product/note.txt'),'合成成果');
  const c=await call('builder_begin_change',{expectedStateRevision:a.stateRevision,objective:'合成工具检查',candidatePath:'product',verificationProfile:'artifact-data-v1',acceptancePlan:{checks:[{id:'note',kind:'file',path:'note.txt'}],reviewCriteria:[{id:'quality',text:'真实用户效果仍待验证'}]}});
  const v=await call('builder_verify_change',{expectedStateRevision:c.stateRevision,taskId:c.taskId,attemptId:c.attemptId});
  assert.equal(v.status,'needs_review');
  console.log(JSON.stringify({status:'passed',scope:'DSH dedicated entry and shared core only; not full native host/model acceptance'}));
}finally{child.stdin.end();await exited;writable(workspacePath);rmSync(workspacePath,{recursive:true,force:true});}
