import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

for(const host of ['codex','dsh'])test(`${host} transport preserves real host identity and readable state`,async()=>{
  const workspacePath=mkdtempSync(join(tmpdir(),'builder-host-'));
  const child=spawn(process.execPath,[resolve(import.meta.dirname,'../mcp/server.mjs')],{
    env:{...process.env,BUILDER_MODE_HOST:host},stdio:['pipe','pipe','ignore']});
  const pending=new Map();let counter=0;
  const closed=new Promise(resolve=>child.once('exit',resolve));
  createInterface({input:child.stdout}).on('line',line=>{const r=JSON.parse(line);pending.get(r.id)?.(r);pending.delete(r.id);});
  const request=(method,params)=>new Promise(resolve=>{const id=++counter;pending.set(id,resolve);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
  try{
    const initialized=await request('initialize',{protocolVersion:'2025-11-25'});
    assert.equal(initialized.result.serverInfo.name,'Builder Mode');
    const opened=await request('tools/call',{name:'builder_open_project',arguments:{workspacePath,goal:'合成跨宿主检查'}});
    const data=opened.result.structuredContent;
    assert.equal(data.project.minimalExperiment.host,host);
    if(host==='dsh') assert.deepEqual(JSON.parse(opened.result.content[1].text),data);
    else assert.equal(opened.result.content.length,1);
    const state=await request('tools/call',{name:'builder_get_project',arguments:{workspacePath}});
    assert.equal(state.result.structuredContent.stateRevision,data.stateRevision);
  }finally{child.stdin.end();await closed;rmSync(workspacePath,{recursive:true,force:true});}
});
