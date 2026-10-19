import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const [plugin, workspace, evidenceRoot] = process.argv.slice(2, 5).map(value => resolve(value));
const artifactProfile = process.argv[5];
const events = [];
const child = spawn(process.execPath, [join(plugin, 'mcp/server.mjs')], {
  cwd: plugin, stdio: ['pipe', 'pipe', 'pipe'],
});
let next = 1;
const pending = new Map();
let stderr = '';
child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
createInterface({ input: child.stdout }).on('line', line => {
  const value = JSON.parse(line);
  const handler = pending.get(value.id);
  if (handler) { pending.delete(value.id); clearTimeout(handler.timer); handler.resolve(value); }
});
child.on('exit', code => {
  for (const handler of pending.values()) {
    clearTimeout(handler.timer); handler.reject(new Error('MCP exited: ' + code + ' ' + stderr));
  }
});
function request(method, params) {
  const id = next++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP timed out: ' + method)); }, 90000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
async function call(name, arguments_) {
  const reply = await request('tools/call', { name, arguments: { workspacePath: workspace, ...arguments_ } });
  events.push({ name, arguments: arguments_, reply });
  if (reply.error || reply.result?.isError) throw new Error(JSON.stringify(reply));
  return reply.result.structuredContent;
}
try {
  const initialized = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {},
    clientInfo: { name: 'builder-runtime-verifier', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  let current = artifactProfile
    ? await call('builder_open_project', { goal: 'Synthetic cross-type draft verification; not a real user trial.' })
    : await call('builder_open_project', {});
  if(current.productPlan?.status!=='aligned') {
    const plan=await call('builder_propose_plan',{expectedStateRevision:current.stateRevision,userOutcome:'合成安装回归，不是真实用户方案',whereYouWillUseIt:'独立本地测试目录',
      firstVersion:['验证声明范围内的行为'],notIncluded:['真实付费、外发、语音应用和用户体验认证'],steps:['准备结果','检查并取回结果'],nextCheckpoint:'可核对的合成结果'});
    await call('builder_record_plan_response',{expectedStateRevision:plan.stateRevision,planId:plan.planId,planDigest:plan.planDigest,responseTo:'product_plan',response:'accept',
      userQuote:'合成测试回应：按这个安装回归方案执行。',sourceRef:'automated-install-fixture-not-real-user'});
    current=await call('builder_get_project',{});
  }
  const change = await call('builder_begin_change', {
    expectedStateRevision: current.stateRevision, candidatePath: 'product',
    verificationProfile: artifactProfile || 'registration-persistent-v1', objective: 'Current installed plugin bounded regression.',
    ...(artifactProfile === 'artifact-data-v1' ? { acceptancePlan: JSON.parse(readFileSync(join(workspace, 'acceptance-plan.json'))) } : {}),
  });
  const verified = await call('builder_verify_change', {
    taskId: change.taskId, attemptId: change.attemptId, expectedStateRevision: change.stateRevision,
  });
  if (verified.status !== (artifactProfile ? 'needs_review' : 'accepted')) throw new Error('Unexpected Host status');
  const reloaded = await call('builder_get_project', {});
  if (artifactProfile && reloaded.tasks.some(task => task.status === 'accepted')) throw new Error('Draft incorrectly accepted');
  const reported = await call('builder_record_update', {
    expectedStateRevision: reloaded.stateRevision,
    meaningForYou:'这些结果用于检查本地交付流程，不代表真实用户体验已经通过。',
    currentFocus: '本地合成样例已完成所声明范围的检查',
    expectedEffect: '验证交付、反馈和恢复流程；不代表真实用户效果已证明',
    nextAction: '负责人整理结果与仍未确认的效果', nextCheckpoint: '可读取结果及其限制的本地成果包',
    evidenceRefs: [verified.evidenceId], risks: ['真实用户体验尚未验证'],
  });
  const ownerBrief = await call('builder_get_brief', {});
  if (ownerBrief.ownerBrief.results.length !== 1 || ownerBrief.ownerBrief.estimate.confidence !== 'unknown') throw new Error('Owner brief did not preserve evidence/estimate limits');
  let delivery = null;
  if (artifactProfile) {
    const selected = verified.evidence.find(e => e.id === verified.evidenceId);
    const common = { taskId: change.taskId, attemptId: change.attemptId,
      verificationEvidenceId: selected.id, candidateDigest: selected.details.candidateDigest };
    let revision = reported.stateRevision;
    const criteria = artifactProfile === 'artifact-data-v1'
      ? JSON.parse(readFileSync(join(workspace, 'acceptance-plan.json'))).reviewCriteria : [{ id: 'quality' }];
    for (const criterion of criteria) {
      const reviewed = await call('builder_record_review', { ...common, expectedStateRevision: revision,
        criterionId: criterion.id, reviewerType: 'assistant', outcome: 'unknown',
        comment: 'Integration probe records unresolved quality, not substantive acceptance.', sourceRef: 'synthetic integration probe' });
      revision = reviewed.stateRevision;
    }
    delivery = await call('builder_prepare_delivery', { ...common, expectedStateRevision: revision });
    if (delivery.manifest.status !== 'needs_review' || delivery.manifest.userAcceptance !== 'not_attested') throw new Error('Unexpected acceptance claim');
  }
  const proposal = await call('builder_check_action', {
    action: 'public_publish', resource: 'synthetic-evidence-only', idempotencyKey: 'resume-publish-probe-v1',
  });
  if (proposal.allowed || proposal.executed) throw new Error('Unexpected publish permission');
  const saved = await call('builder_backup_project', {});
  const recovery = await call('builder_recovery_status', {});
  mkdirSync(evidenceRoot, { recursive: true });
  const restored = await call('builder_restore_backup', { backupId: saved.backupId });
  const recoveredProject = await call('builder_get_project', { workspacePath: restored.restoredWorkspace });
  const recoveredStatus = await call('builder_recovery_status', { workspacePath: restored.restoredWorkspace });
  if (!recoveredStatus.actions.some(a => a.idempotencyKey === 'resume-publish-probe-v1')) throw new Error('Durable action journal missing after restore');
  if (recoveredProject.project.goal !== current.project.goal
      || recoveredProject.project.ownerEpoch <= current.project.ownerEpoch) throw new Error('Restored context/owner mismatch');
  const proof = {
    kind: 'live-installed-stdio', initialized, verified: {
      status: verified.status, evidenceId: verified.evidenceId, reportPath: verified.reportPath,
      stateRevision: verified.stateRevision, taskId: change.taskId, attemptId: change.attemptId,
    }, backup: saved, restored, recovery, delivery, ownerBrief, deniedAction: proposal, events,
    limits: { recoveredAsset: 'state-journals-frozen-assets; live working tree/business data excluded', nativeStopAttestation: 'unavailable',
      externalOperationsExecuted: false },
  };
  writeFileSync(join(evidenceRoot, 'stdio-proof.json'), JSON.stringify(proof, null, 2) + '\n');
  writeFileSync(join(evidenceRoot, 'host-report.json'), readFileSync(verified.reportPath));
  console.log(JSON.stringify({ plugin: initialized.result.serverInfo, status: verified.status,
    backup: 'created', restore: restored.restored, deniedAction: proposal.code,
    unresolvedWriters: recovery.unknown.length, path: join(evidenceRoot, 'stdio-proof.json') }));
} finally { child.stdin.end(); child.kill('SIGTERM'); }
