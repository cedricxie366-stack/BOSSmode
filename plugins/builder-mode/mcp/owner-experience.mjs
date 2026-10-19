import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, lstatSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { currentReviewState } from './artifacts.mjs';
import { planStatus, requireTaskPlan } from './product-plan.mjs';
const require = createRequire(import.meta.url);
const { buildCandidateManifest } = require('../runtime/verification.cjs');
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
function text(value, name, max = 1600) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} needs a concise nonempty explanation`);
  return value.trim();
}
function object(value, fields, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !fields.includes(k))) throw new Error(`Unsupported ${name} fields`);
}
function projectFor(store, args) {
  const project = store.getProject(args.projectId ?? 'main');
  if (!project || args.expectedStateRevision !== project.stateRevision) throw new Error('Stale project state; reread before updating owner communication');
  return project;
}
function currentEvents(store, project) {
  return store.listOwnerEvents(project.id).filter(e => e.goalRevision === project.goalRevision && e.contractRevision === project.contractRevision);
}
function confined(root, filename) {
  const rel = path.relative(root, filename);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Result evidence outside project');
  let cursor = root;
  for (const part of rel.split(path.sep)) { cursor = path.join(cursor, part); if (lstatSync(cursor).isSymbolicLink()) throw new Error('Result evidence symlink rejected'); }
  return filename;
}
function resultEvidence(store, location, project, ids = []) {
  if (!Array.isArray(ids) || ids.length > 8) throw new Error('At most eight result references');
  return ids.map(id => {
    const evidence = store.getEvidence(id);
    const task = evidence && store.getTask(evidence.taskId);
    if (!task || task.projectId !== project.id || evidence.goalRevision !== project.goalRevision || evidence.contractRevision !== project.contractRevision
      || !['host-verification','delivery-manifest'].includes(evidence.kind)) throw new Error('Result requires current project evidence');
    requireTaskPlan(store,project,task);
    confined(location.stateRoot, evidence.location);
    if (digest(readFileSync(evidence.location)) !== evidence.digest) throw new Error('Result evidence changed');
    if (evidence.kind === 'host-verification' && evidence.status !== 'passed') throw new Error('Failed check is not a usable result');
    const candidatePath = task.input?.candidatePath;
    if (!candidatePath || path.isAbsolute(candidatePath) || candidatePath.split(/[\\/]/).includes('..')) throw new Error('Result candidate path invalid');
    let candidateCursor = location.workspace;
    for (const part of candidatePath.split('/')) { candidateCursor = path.join(candidateCursor, part); if (lstatSync(candidateCursor).isSymbolicLink()) throw new Error('Result candidate symlink rejected'); }
    if (buildCandidateManifest(path.join(location.workspace, candidatePath)).candidateDigest !== evidence.details?.candidateDigest) throw new Error('Result belongs to an older candidate');
    if (evidence.kind === 'delivery-manifest') {
      const manifest = JSON.parse(readFileSync(evidence.location));
      const productPath = confined(location.stateRoot, path.join(path.dirname(evidence.location), 'product'));
      const reportPath = confined(location.stateRoot, path.join(path.dirname(evidence.location), 'host-report.json'));
      if (buildCandidateManifest(productPath).candidateDigest !== manifest.candidateDigest
          || digest(readFileSync(reportPath)) !== manifest.reportDigest) throw new Error('Delivered assets changed');
      const latest = currentReviewState(store, task, evidence.attemptId, manifest.verificationEvidenceId, manifest.candidateDigest);
      if (latest.changesRequested || (manifest.status === 'reviewed_candidate' && latest.outstandingCriteria.length)) throw new Error('Delivery needs updated review');
    }
    return evidence;
  });
}

export function getOwnerBrief(args, { withStore, inspectRecovery }) {
  return withStore(args.workspacePath, (store, location) => {
    const project = store.getProject(args.projectId ?? 'main');
    if (!project) throw new Error('Project not found');
    const snapshot = store.readSnapshot(project.id);
    const events = currentEvents(store, project);
    const productPlan=planStatus(store,project);
    const update = events.filter(e => e.kind === 'update' && !e.payload.recordType && e.payload.planId===productPlan.planId).at(-1);
    const responses = new Map(events.filter(e => e.kind === 'decision_response').map(e => [e.payload.decisionId, e]));
    const pending = events.filter(e => e.kind === 'decision' && !responses.has(e.id));
    const goalEvents = store.listOwnerEvents(project.id).filter(e => e.goalRevision === project.goalRevision);
    const respondedIds = new Set(goalEvents.filter(e => e.kind === 'decision_response').map(e => e.payload.decisionId));
    const reconciliations = goalEvents.filter(e => e.kind === 'update' && e.payload.recordType === 'decision_reconciliation');
    const reconciledIds = new Set(reconciliations.map(e => e.payload.decisionId));
    const decisionsToReconcile = goalEvents.filter(e => e.kind === 'decision' && e.contractRevision !== project.contractRevision && !respondedIds.has(e.id) && !reconciledIds.has(e.id));
    const decisionHistory = goalEvents.filter(e => e.kind === 'decision_response' && e.contractRevision !== project.contractRevision);
    const active = snapshot.attempts.filter(a => a.applicability === 'current' && snapshot.tasks.some(t =>
      t.id === a.taskId && t.input?.planId === productPlan.planId && t.input?.planDigest === productPlan.planDigest));
    const latest = active.at(-1);
    const task = snapshot.tasks.find(t => t.id === latest?.taskId);
    const unknown = snapshot.attempts.some(a => a.unconfirmedActive || ['unknown_outcome','cancel_requested'].includes(a.status));
    const executionUnconfirmed = store.listRecoverableAttempts(project.id).some(a=>a.writer);
    let phase = unknown ? 'reconciliation_required'
      : executionUnconfirmed ? 'execution_unconfirmed'
      : task?.status === 'needs_revision' ? 'failed' : task?.status === 'verifying' ? 'needs_review'
      : task?.status === 'accepted' ? 'checked_scope' : 'not_started';
    let state = unknown ? '需先确认中断工作的状态，暂不重复执行'
      : executionUnconfirmed ? '已登记实施任务；当前是否仍在执行尚无宿主确认'
      : task?.status === 'accepted' ? '已有通过既定检查的版本，整体效果仍以实际体验为准'
      : task?.status === 'verifying' ? '已有候选成果，实质效果仍待评审'
      : task?.status === 'needs_revision' ? '检查发现问题，尚未完成'
      : task?.status === 'running' || task?.status === 'prepared' ? '已登记实施任务；当前是否仍在执行尚无宿主确认'
      : '尚未登记实施结果，需要先核对目标和下一步';
    const blockers = [];
    try {
      const recovery = inspectRecovery(location, snapshot).data;
      if (recovery.verificationOperations.some(o => o.reconciled === 'unknown_do_not_redispatch')
          || recovery.actions.some(a => ['dispatched','unknown'].includes(a.status))) {
        phase = 'reconciliation_required'; state = '有操作结果尚未确认；负责人需先核对，不能重复执行';
        blockers.push({ kind: 'unknown_operation', impact: '重复执行可能造成重复动作或覆盖', ownerAction: '核对已有结果；在确认前不重试相关操作' });
      }
      if (recovery.assetErrors.length) {
        if (phase !== 'reconciliation_required') { phase = 'evidence_unavailable'; state = '已有成果证据缺失或不一致，需先核对再交付'; }
        blockers.push({ kind: 'evidence_unavailable', impact: '不能将缺失或损坏的成果作为当前交付', ownerAction: '检查原成果与可用备份，说明可恢复范围' });
      }
    } catch {
      phase = 'reconciliation_required'; state = '暂时无法可靠读取恢复状态，不能据此宣称工作正常';
      blockers.push({ kind: 'state_unavailable', impact: '当前结果与风险尚未核实', ownerAction: '负责人检查状态读取问题，不要求用户自行排错' });
    }
    if (unknown || phase === 'execution_unconfirmed') blockers.push({ kind: 'execution_unconfirmed', impact: '任务登记不代表执行者仍活跃或已停止', ownerAction: '负责人核对实际执行状态，未确认前不重派写入工作' });
    if (pending.length && ['not_started','checked_scope','needs_review'].includes(phase)) {
      phase = 'waiting_for_decision'; state = '有业务选择待你判断；负责人可继续不受该选择影响的工作';
    }
    if (decisionsToReconcile.length) blockers.push({ kind: 'decision_revalidation', impact: '要求已变化，旧未决事项需要重新核对', ownerAction: '负责人先核对哪些选择仍相关，不直接重复询问或沿用旧批准' });
    let results = [];
    let resultWarning = null;
    try {
      results = resultEvidence(store, location, project, update?.payload.evidenceRefs ?? []).map(e => ({
        label: e.kind === 'delivery-manifest' ? '已整理本地成果包' : '已完成所声明范围的检查',
        status: e.kind === 'delivery-manifest' ? e.details?.status : e.details?.verificationScope,
        location: e.kind === 'delivery-manifest' ? path.dirname(e.location) : null,
      }));
    } catch { resultWarning = '此前引用的结果需要重新核对，暂不作为当前可用成果'; }
    if (resultWarning && !unknown && phase !== 'reconciliation_required') { phase = 'evidence_unavailable'; state = '当前成果或评审需要重新核对，旧检查不代表当前可用结果'; }
    const report = productPlan.status==='aligned' ? update?.payload ?? null : null;
    if (productPlan.status !== 'aligned' && !['reconciliation_required','execution_unconfirmed'].includes(phase)) {
      phase = 'awaiting_plan_alignment'; state = '先把第一版要做什么讲清楚，得到回应后再制作';
    }
    const meanings = {
      awaiting_plan_alignment:'我们还没对齐第一版要做什么，先看懂并调整方案，再开始制作。',
      execution_unconfirmed:'上次记录显示工作已开始，但目前不能确认它是否仍在进行；不会让新工作直接覆盖它。',
      reconciliation_required:'有一步是否完成还不确定，先查清楚，避免重复操作或覆盖已有内容。',
      evidence_unavailable:'目前不能放心地把旧结果交给你，需要先核对文件和最新反馈。',
      failed:'检查发现了问题，这一版还不能放心使用；负责人先查清影响并修复。',
      needs_review:'已有可查看的初稿，但它是否真正满足你的需要还没有确认。',
      checked_scope:'已有版本通过了列明的检查，但并非所有使用效果都已经验证。',
      waiting_for_decision:'有一项会影响结果的选择需要你判断；其他不受影响的工作可以继续。',
      not_started:'当前方案还没有经过检查的版本，接下来由负责人推进约定的第一步。',
    };
    const protectedPhase=['awaiting_plan_alignment','execution_unconfirmed','reconciliation_required','evidence_unavailable','failed'].includes(phase);
    const meaningForYou=protectedPhase ? meanings[phase] : report?.meaningForYou ?? meanings[phase];
    const userMessage=[meaningForYou,
      phase==='awaiting_plan_alignment' && productPlan.plan ? `第一版希望帮你：${productPlan.plan.userOutcome}` : null,
      !protectedPhase && report?.nextCheckpoint ? `下一次你能检查：${report.nextCheckpoint}` : null].filter(Boolean).join('\n');
    return { message: userMessage, data: {
      stateRevision: project.stateRevision,
      ownerBrief: { goal: project.goal, state, phase, activityObserved: false, blockers,
        meaningForYou, userMessage, productPlan,
        lastReportedAt: update?.createdAt ?? null,
        currentFocus: report?.currentFocus ?? productPlan.plan?.userOutcome ?? snapshot.brief?.summary ?? '当前尚未保存负责人进展说明',
        expectedEffect: report?.expectedEffect ?? productPlan.plan?.userOutcome ?? '预期效果尚未明确，不作保证',
        nextAction: phase==='awaiting_plan_alignment' ? '先解释和调整第一版方案，等用户对方案回应后制作' : report?.nextAction ?? snapshot.brief?.nextStep ?? '负责人先核对目标和现有成果',
        nextCheckpoint: report?.nextCheckpoint ?? productPlan.plan?.nextCheckpoint ?? '以可体验的结果为下一次检查点',
        results, resultWarning, risks: report?.risks ?? [],
        estimate: report?.estimate ?? { text: '暂无法可靠估计时间或费用', basis: '尚无足够测量依据', confidence: 'unknown' },
        interpretation: '负责人说明；结果状态由项目记录计算；预期不是保证',
        needsYourDecision: pending.map(e => ({ id: e.id, ...e.payload })),
        decisionsToReconcile: decisionsToReconcile.map(e => ({ id: e.id, ...e.payload, status: 'needs_owner_revalidation', authorizationGranted: false })),
        decisionHistory: decisionHistory.map(e => ({ ...e.payload, applicability: 'historical_requires_review', authorizationGranted: false })),
        decisionReconciliations: reconciliations.map(e => ({ ...e.payload, authorizationGranted: false })),
        recordedDecisions: [...responses.values()].map(e => ({ ...e.payload, authorizationGranted: false })),
      },
    } };
  }, { readOnly: true });
}

export function recordOwnerUpdate(args, { withStore }) {
  return withStore(args.workspacePath, (store, location) => {
    const project = projectFor(store, args);
    const payload = {};
    for (const key of ['meaningForYou','currentFocus','expectedEffect','nextAction','nextCheckpoint']) payload[key] = text(args[key], key);
    if (args.risks !== undefined && (!Array.isArray(args.risks) || args.risks.length > 5)) throw new Error('At most five material risks');
    payload.risks = (args.risks ?? []).map(r => text(r, 'risk'));
    resultEvidence(store, location, project, args.evidenceRefs);
    payload.evidenceRefs = args.evidenceRefs ?? [];
    if (args.estimate !== undefined) {
      object(args.estimate, ['text','basis','confidence'], 'estimate');
      if (!['low','medium','high','unknown'].includes(args.estimate.confidence)) throw new Error('Estimate confidence required');
      payload.estimate = { text: text(args.estimate.text, 'estimate'), basis: text(args.estimate.basis, 'estimate basis'), confidence: args.estimate.confidence };
    }
    payload.attribution = 'assistant_reported';
    payload.planId = planStatus(store,project).planId ?? null;
    const id = store.recordOwnerEvent({ id: `update-${randomUUID()}`, projectId: project.id, kind: 'update', payload });
    return { message: '已保存负责人说明；未修改任务完成状态或产生授权。', data: { id, stateRevision: store.getProject(project.id).stateRevision } };
  });
}

export function prepareDecision(args, { withStore }) {
  return withStore(args.workspacePath, store => {
    const project = projectFor(store, args);
    if (!['scope','budget','permission','safety','priority','quality_tradeoff'].includes(args.category)) throw new Error('Escalate business tradeoffs, not implementation details');
    if (!Array.isArray(args.options) || args.options.length < 2 || args.options.length > 3) throw new Error('Present two or three real options');
    const ids = new Set();
    const options = args.options.map(option => {
      const fields = ['id','label','expectedOutcome','costImpact','timeImpact','risk','reversibility'];
      object(option, fields, 'option');
      const value = Object.fromEntries(fields.map(key => [key, text(option[key], key)]));
      if (ids.has(value.id)) throw new Error('Duplicate decision option'); ids.add(value.id); return value;
    });
    if (!ids.has(args.recommendedOptionId)) throw new Error('Recommendation must select a presented option');
    const payload = { category: args.category, options, recommendedOptionId: args.recommendedOptionId, authorizationGranted: false };
    for (const key of ['question','whyNow','recommendationReason','ifDeferred','responsibleRole']) payload[key] = text(args[key], key);
    const id = store.recordOwnerEvent({ id: `decision-${randomUUID()}`, projectId: project.id, kind: 'decision', payload });
    return { message: '业务决策说明已准备；等待真实用户判断，不自动选择、不产生授权。', data: { decisionId: id, stateRevision: store.getProject(project.id).stateRevision, decision: payload } };
  });
}

export function recordDecisionResponse(args, { withStore }) {
  return withStore(args.workspacePath, store => {
    const project = projectFor(store, args);
    const events = currentEvents(store, project);
    const decision = events.find(e => e.id === args.decisionId && e.kind === 'decision');
    if (!decision || !decision.payload.options.some(o => o.id === args.optionId)) throw new Error('Decision/option must belong to the current contract');
    if (events.some(e => e.kind === 'decision_response' && e.payload.decisionId === args.decisionId)) throw new Error('Decision response already recorded; create a new proposal for changed scope');
    const payload = { decisionId: decision.id, optionId: args.optionId, userQuote: text(args.userQuote, 'actual user quote'),
      sourceRef: text(args.sourceRef, 'user message reference'), attestation: 'assistant_attributed', authorizationGranted: false };
    const id = store.recordOwnerEvent({ id: `response-${randomUUID()}`, projectId: project.id, kind: 'decision_response', payload });
    return { message: '已记录用户选择的转述；不代替宿主授权，未执行外部操作。', data: { id, stateRevision: store.getProject(project.id).stateRevision, ...payload } };
  });
}

export function reconcileDecision(args, { withStore }) {
  return withStore(args.workspacePath, store => {
    const project = projectFor(store, args);
    const events = store.listOwnerEvents(project.id).filter(e => e.goalRevision === project.goalRevision);
    const decision = events.find(e => e.id === args.decisionId && e.kind === 'decision');
    if (!decision || decision.contractRevision === project.contractRevision) throw new Error('Only stale pending decisions can be reconciled by the owner');
    if (events.some(e => e.payload.decisionId === decision.id && (e.kind === 'decision_response' || e.payload.recordType === 'decision_reconciliation'))) throw new Error('Decision already answered or reconciled');
    if (!['replaced','no_longer_relevant'].includes(args.resolution)) throw new Error('Unsupported reconciliation');
    let replacementDecisionId = null;
    if (args.resolution === 'replaced') {
      const replacement = events.find(e => e.id === args.replacementDecisionId && e.kind === 'decision' && e.contractRevision === project.contractRevision);
      if (!replacement) throw new Error('Replacement must be a current decision');
      replacementDecisionId = replacement.id;
    } else if (args.replacementDecisionId) throw new Error('Irrelevant decision cannot name a replacement');
    const payload = { recordType: 'decision_reconciliation', decisionId: decision.id, resolution: args.resolution,
      replacementDecisionId, reason: text(args.reason, 'reconciliation reason'), sourceRef: text(args.sourceRef, 'current requirement source'),
      attestation: 'assistant_reconciliation', authorizationGranted: false };
    const id = store.recordOwnerEvent({ id: `reconciliation-${randomUUID()}`, projectId: project.id, kind: 'update', payload });
    return { message: '旧事项核对记录已保存；没有替用户作选择，没有授予权限。', data: { id, stateRevision: store.getProject(project.id).stateRevision, ...payload } };
  });
}
