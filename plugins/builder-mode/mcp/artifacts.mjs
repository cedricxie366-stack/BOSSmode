import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { requireTaskPlan } from './product-plan.mjs';
const require = createRequire(import.meta.url);
const { buildCandidateManifest } = require('../runtime/verification.cjs');
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

function confined(root, filename) {
  const relative = path.relative(root, filename);
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('Artifact path outside controlled root');
  let cursor = root;
  if (lstatSync(root).isSymbolicLink()) throw new Error('Artifact root cannot be symlink');
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    if (lstatSync(cursor).isSymbolicLink()) throw new Error('Artifact symlinks are not allowed');
  }
  return filename;
}

function binding(store, location, args) {
  const project = store.getProject(args.projectId ?? 'main');
  if (!project || project.stateRevision !== args.expectedStateRevision) throw new Error('Stale project state; reload before artifact work');
  const evidence = store.getEvidence(args.verificationEvidenceId);
  const task = store.getTask(args.taskId);
  const attempt = store.getAttempt(args.attemptId);
  if (!task || task.projectId !== project.id || !attempt || attempt.taskId !== task.id
      || !evidence || evidence.attemptId !== attempt.id || evidence.kind !== 'host-verification' || evidence.status !== 'passed') {
    throw new Error('Artifact requires bound passing Host evidence');
  }
  if (task.goalRevision !== project.goalRevision || task.contractRevision !== project.contractRevision) throw new Error('Artifact belongs to a stale contract');
  requireTaskPlan(store,project,task);
  if (store.listRecoverableAttempts(project.id).some(a => a.writer)) throw new Error('Unresolved writer blocks artifact review/delivery');
  const reportPath = confined(path.join(location.stateRoot, 'verification'), evidence.location);
  const reportBytes = readFileSync(reportPath);
  if (digest(reportBytes) !== evidence.digest) throw new Error('Host report digest mismatch');
  const report = JSON.parse(reportBytes);
  for (const [key, value] of Object.entries({ projectId: project.id, taskId: task.id, attemptId: attempt.id,
    goalRevision: project.goalRevision, contractRevision: project.contractRevision, inputDigest: attempt.inputDigest })) {
    if (report.binding[key] !== value) throw new Error('Host report binding mismatch');
  }
  if (args.candidateDigest !== report.binding.candidateDigest || report.status !== 'passed') throw new Error('Candidate/report mismatch');
  let snapshotPath = evidence.details?.snapshotPath ?? report.candidate.snapshotPath;
  const originPath = path.join(location.stateRoot, 'recovery-origin.json');
  if (!evidence.details?.snapshotPath && existsSync(originPath)) {
    confined(location.stateRoot, originPath);
    const origin = JSON.parse(readFileSync(originPath));
    const rel = path.relative(origin.manifest.sourceStateRoot, snapshotPath);
    if (rel.startsWith('verification/snapshots/')) snapshotPath = path.join(location.stateRoot, rel);
  }
  confined(path.join(location.stateRoot, 'verification', 'snapshots'), snapshotPath);
  const snapshot = buildCandidateManifest(snapshotPath);
  if (snapshot.candidateDigest !== args.candidateDigest) throw new Error('Frozen snapshot changed');
  const candidatePath = confined(location.workspace, path.resolve(location.workspace, task.input.candidatePath));
  if (buildCandidateManifest(candidatePath).candidateDigest !== args.candidateDigest) throw new Error('Working candidate changed; verify a new attempt');
  const criteria = task.input.acceptancePlan?.reviewCriteria ?? [{ id: 'quality', text: 'Substantive correctness and fitness for the agreed purpose' }];
  return { project, evidence, task, attempt, report, reportBytes, snapshot, criteria };
}

export function recordReview(args, { withStore, summarizeSnapshot }) {
  return withStore(args.workspacePath, (store, location) => {
    const b = binding(store, location, args);
    if (!['assistant', 'user_attributed'].includes(args.reviewerType)) throw new Error('Unsupported reviewer type');
    if (!['satisfied', 'changes_requested', 'unknown'].includes(args.outcome)) throw new Error('Unsupported review outcome');
    if (!b.criteria.some(c => c.id === args.criterionId)) throw new Error('Unknown review criterion');
    for (const key of ['comment', 'sourceRef']) if (typeof args[key] !== 'string' || !args[key].trim() || args[key].length > 8000) throw new Error(`${key} required and bounded`);
    const details = { verificationEvidenceId: b.evidence.id, candidateDigest: args.candidateDigest,
      criterionId: args.criterionId, reviewerType: args.reviewerType,
      attestation: args.reviewerType === 'user_attributed' ? 'assistant_attributed' : 'assistant_review',
      outcome: args.outcome, comment: args.comment, sourceRef: args.sourceRef,
      userApprovalGranted: false };
    const id = `review-${randomUUID()}`;
    store.addEvidence({ id, taskId: b.task.id, attemptId: b.attempt.id,
      goalRevision: b.project.goalRevision, contractRevision: b.project.contractRevision,
      kind: 'artifact-review', status: 'recorded', digest: digest(JSON.stringify(details)),
      location: `builder://review/${id}`, details });
    return { message: 'Version-bound review recorded. It does not grant approval or accept the deliverable.',
      data: { reviewId: id, ...details, ...summarizeSnapshot(store, b.project.id) } };
  });
}

export function currentReviewState(store, task, attemptId, verificationEvidenceId, candidateDigest) {
    const criteria = task.input.acceptancePlan?.reviewCriteria ?? [{ id: 'quality', text: 'Substantive correctness and fitness for the agreed purpose' }];
    const reviews = store.listEvidence(attemptId).filter(e => e.kind === 'artifact-review'
      && e.details?.candidateDigest === candidateDigest && e.details?.verificationEvidenceId === verificationEvidenceId);
    const latest = new Map();
    for (const review of reviews) {
      if (review.digest !== digest(JSON.stringify(review.details))) throw new Error('Review record digest mismatch');
      latest.set(`${review.details.criterionId}:${review.details.reviewerType}`, review.details);
    }
    const outstandingCriteria = criteria.filter(c => ![...latest.values()].some(r => r.criterionId === c.id && r.outcome === 'satisfied')
      || [...latest.values()].some(r => r.criterionId === c.id && r.outcome === 'unknown'));
    return { reviews: [...latest.values()], outstandingCriteria, changesRequested: [...latest.values()].some(r => r.outcome === 'changes_requested') };
}

export function prepareDelivery(args, { withStore, summarizeSnapshot }) {
  return withStore(args.workspacePath, (store, location) => {
    const b = binding(store, location, args);
    const reviewState = currentReviewState(store, b.task, b.attempt.id, b.evidence.id, args.candidateDigest);
    if (reviewState.changesRequested) throw new Error('Outstanding requested changes block delivery; revise and reverify');
    const { outstandingCriteria } = reviewState;
    const status = b.task.status === 'accepted' ? 'accepted_profile_scope'
      : outstandingCriteria.length ? 'needs_review' : 'reviewed_candidate';
    const root = path.join(location.stateRoot, 'deliveries');
    if (existsSync(root) && lstatSync(root).isSymbolicLink()) throw new Error('Delivery root cannot be symlink');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const id = `delivery-${randomUUID()}`;
    const destination = path.join(root, id);
    const output = path.join(destination, 'product');
    mkdirSync(output, { recursive: true, mode: 0o700 });
    if (b.snapshot.files.length > 5000 || b.snapshot.files.reduce((n, f) => n + (f.bytes ?? f.size ?? 0), 0) > 200 * 1024 * 1024) throw new Error('Delivery too large');
    for (const file of b.snapshot.files) {
      const target = path.join(output, file.path);
      mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, readFileSync(path.join(b.snapshot.workspacePath, file.path)), { flag: 'wx', mode: 0o600 });
    }
    if (buildCandidateManifest(output).candidateDigest !== args.candidateDigest) throw new Error('Delivery copy integrity failed');
    writeFileSync(path.join(destination, 'host-report.json'), b.reportBytes, { flag: 'wx', mode: 0o600 });
    const manifest = { id, status, createdAt: new Date().toISOString(), projectId: b.project.id,
      goalRevision: b.project.goalRevision, contractRevision: b.project.contractRevision,
      taskId: b.task.id, attemptId: b.attempt.id, candidateDigest: args.candidateDigest,
      verificationEvidenceId: b.evidence.id, reportDigest: b.evidence.digest,
      verificationScope: b.evidence.details?.verificationScope ?? 'historical_profile_scope',
      files: b.snapshot.files, reviews: reviewState.reviews, outstandingCriteria,
      userAcceptance: 'not_attested', externalPublication: false,
      limits: ['Only frozen candidate files included', 'No live business data or external effects restored', 'Review is not user approval'] };
    writeFileSync(path.join(destination, 'delivery.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    writeFileSync(path.join(destination, 'README.txt'), `Builder 本地交付候选\n状态：${status}\n成果位于 product；检查和评审范围见 delivery.json。\n用户认可尚未由宿主证明；不包含运行中业务数据；未公开发布。\n`, { flag: 'wx', mode: 0o600 });
    store.addEvidence({ id, taskId: b.task.id, attemptId: b.attempt.id, goalRevision: b.project.goalRevision,
      contractRevision: b.project.contractRevision, kind: 'delivery-manifest', status: 'recorded',
      digest: digest(readFileSync(path.join(destination, 'delivery.json'))), location: path.join(destination, 'delivery.json'),
      details: { candidateDigest: args.candidateDigest, status, userApprovalGranted: false } });
    return { message: 'Local delivery prepared with explicit verification/review limits; no publication or user approval.',
      data: { destination, manifest, ...summarizeSnapshot(store, b.project.id) } };
  });
}
