import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { recordReview, prepareDelivery } from './artifacts.mjs';
import { getOwnerBrief, recordOwnerUpdate, prepareDecision, recordDecisionResponse, reconcileDecision } from './owner-experience.mjs';
import { proposePlan, recordPlanResponse, requireAlignedPlan, planStatus } from './product-plan.mjs';
import { communicationPreference, setCommunicationPreference, reviewReply } from './reply-review.mjs';

const require = createRequire(import.meta.url);
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginManifest = JSON.parse(readFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
const {
  BuilderStateStore,
  createStateHostAuthority,
} = require(path.join(pluginRoot, 'runtime', 'state.cjs'));
const {
  HostVerificationService,
  buildCandidateManifest,
} = require(path.join(pluginRoot, 'runtime', 'verification.cjs'));

const SERVER_NAME = 'BOSSmode';
const SERVER_VERSION = pluginManifest.version;
const RUNTIME_HOST = process.env.BUILDER_MODE_HOST ?? 'codex';
if (!['codex', 'dsh'].includes(RUNTIME_HOST)) throw new Error('Unsupported Builder host');
const PLUGIN_ID = RUNTIME_HOST === 'dsh' ? 'builder-mode-dsh' : 'builder-mode@builder-mode-local';
const DEFAULT_PROJECT_ID = 'main';
const stateHostAuthority = createStateHostAuthority();
const runtimePolicy = JSON.parse(readFileSync(path.join(pluginRoot, 'runtime', 'policy.defaults.json'), 'utf8'));
const { backupWorkspace, restoreWorkspace, auditWorkspaceAssets } = require(path.join(pluginRoot, 'runtime', 'backup.cjs'));
const { DurableHostPolicyEngine } = require(path.join(pluginRoot, 'runtime', 'policy.cjs'));
const JsonRpcError = Object.freeze({ METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602 });
const PROFILE_DEFINITIONS = Object.freeze({
  'artifact-data-v1': Object.freeze({
    acceptance: ['Frozen declarative data checks pass; semantic quality requires separately recorded review.'],
    suiteFile: 'artifact-data.cjs', reviewRequired: true,
  }),
  'research-note-v1': Object.freeze({
    acceptance: ['Research note and cited source metadata are present and linked; facts require review.'],
    suiteFile: 'research-note.cjs', reviewRequired: true,
  }),
  'content-brief-v1': Object.freeze({
    acceptance: ['Content and audience/goal/format brief fields are present; quality and alignment require review.'],
    suiteFile: 'content-brief.cjs', reviewRequired: true,
  }),
  'registration-basic-v1': Object.freeze({
    acceptance: Object.freeze([
      'A valid registration is stored and returned as confirmed.',
      'The same email cannot register twice, ignoring letter case.',
      'The product page is reachable and explains registration.',
    ]),
    suiteFile: 'registration-basic.cjs',
  }),
  'registration-waitlist-v1': Object.freeze({
    acceptance: Object.freeze([
      'All basic registration behavior remains available.',
      'Registrations beyond capacity enter a FIFO waitlist.',
      'Cancelling a confirmed registration promotes the earliest waitlisted person.',
      'Cancelling a waitlisted registration removes it without promoting anyone.',
      'The product page displays the waitlist capability.',
    ]),
    suiteFile: 'registration-waitlist.cjs',
  }),
  'registration-persistent-v1': Object.freeze({
    acceptance: Object.freeze([
      'All waitlist and cancellation behavior remains available.',
      'Confirmed and waitlisted registrations survive a full server restart.',
      'A Host-requested SQLite backup reports its creation time and registration count.',
      'Restore requires explicit confirmation, creates a safety backup, passes integrity checking, and restores the saved roster.',
    ]),
    suiteFile: 'registration-persistent.cjs',
  }),
});

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function requiredPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return value;
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function checkDatabaseFile(filename) {
  let stat;
  try { stat = lstatSync(filename); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Database must be a regular file, not a symlink');
}

function canonicalWorkspace(workspacePath) {
  const requested = requiredString(workspacePath, 'workspacePath');
  if (!path.isAbsolute(requested)) throw new TypeError('workspacePath must be absolute.');
  const metadata = lstatSync(requested);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new TypeError('workspacePath must be a real directory, not a symlink.');
  }
  return realpathSync(requested);
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function projectLocation(workspacePath, { create = true } = {}) {
  const workspace = canonicalWorkspace(workspacePath);
  const stateRoot = path.join(workspace, '.builder-mode');
  if (existsSync(stateRoot)) {
    const metadata = lstatSync(stateRoot);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new TypeError('.builder-mode must be a real directory, not a symlink.');
    }
  } else if (create) {
    mkdirSync(stateRoot, { recursive: false, mode: 0o700 });
  } else {
    throw new Error('Builder project state does not exist in this workspace.');
  }
  const canonicalStateRoot = realpathSync(stateRoot);
  const database = path.join(canonicalStateRoot, 'state.sqlite');
  checkDatabaseFile(database);
  if (existsSync(database) || !create) {
    const metadata = lstatSync(database);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error('Builder project state database is not a regular file.');
    }
  }
  return Object.freeze({ workspace, stateRoot: canonicalStateRoot, database });
}

function resolveCandidate(workspace, stateRoot, relativePath) {
  const requested = requiredString(relativePath, 'candidatePath');
  if (path.isAbsolute(requested) || requested.split(/[\\/]+/u).includes('..')) {
    throw new TypeError('candidatePath must be relative and cannot contain parent traversal.');
  }
  const candidate = path.resolve(workspace, requested);
  if (!isWithin(workspace, candidate) || isWithin(stateRoot, candidate) || isWithin(candidate, stateRoot)) {
    throw new TypeError('candidatePath must stay inside the workspace and outside .builder-mode.');
  }
  const metadata = lstatSync(candidate);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new TypeError('candidatePath must identify a real directory.');
  }
  const canonical = realpathSync(candidate);
  if (!isWithin(workspace, canonical) || isWithin(stateRoot, canonical) || isWithin(canonical, stateRoot)) {
    throw new Error('Candidate resolves outside the permitted product workspace');
  }
  return canonical;
}

function withStore(workspacePath, callback, { readOnly = false } = {}) {
  const location = projectLocation(workspacePath, { create: !readOnly });
  const store = new BuilderStateStore(location.database, { readOnly });
  try {
    return readOnly ? callback(store, location) : store.transaction(() => callback(store, location));
  } finally {
    store.close();
  }
}

function summarizeSnapshot(store, projectId) {
  const snapshot = store.readSnapshot(projectId);
  return Object.freeze({
    runtimeHost: RUNTIME_HOST,
    stateRevision: snapshot.revision,
    project: snapshot.project,
    brief: snapshot.brief,
    contextItems: snapshot.contextItems,
    communicationPreference: communicationPreference(store, projectId),
    productPlan: planStatus(store,snapshot.project),
    rules: store.listRules({
      projectId,
      contractRevision: snapshot.project.contractRevision,
    }),
    tasks: snapshot.tasks.map((task) => ({
      id: task.id,
      status: task.status,
      acceptance: task.acceptance,
      input: task.input,
      acceptedAttemptId: task.acceptedAttemptId,
      applicability: task.applicability,
    })),
    attempts: snapshot.attempts.map((attempt) => ({
      id: attempt.id,
      taskId: attempt.taskId,
      status: attempt.status,
      verified: attempt.verified,
      failureReason: attempt.failureReason,
      unconfirmedActive: attempt.unconfirmedActive,
      applicability: attempt.applicability,
    })),
    evidence: snapshot.evidence.map((evidence) => ({
      id: evidence.id,
      taskId: evidence.taskId,
      attemptId: evidence.attemptId,
      kind: evidence.kind,
      status: evidence.status,
      digest: evidence.digest,
      location: evidence.location,
      applicability: evidence.applicability,
      details: evidence.details,
    })),
  });
}

function advanceContract(store, project, { ruleUpdates = [], contextUpdates = [], brief = null } = {}) {
  const existingRules = store.listRules({ projectId: project.id, contractRevision: project.contractRevision });
  const existingContext = store.listContextItems({
    projectId: project.id,
    goalRevision: project.goalRevision,
    contractRevision: project.contractRevision,
  });
  const rules = new Map(existingRules.map((rule) => [rule.id, rule]));
  const context = new Map(existingContext.map((item) => [item.id, item]));
  for (const update of ruleUpdates) rules.set(update.id, update);
  for (const update of contextUpdates) context.set(update.id, update);
  const previousBrief = store.getLatestProductBrief({
    projectId: project.id,
    goalRevision: project.goalRevision,
    contractRevision: project.contractRevision,
  });
  const nextContractRevision = project.contractRevision + 1;
  store.transaction(() => {
    store.createContractRevision({
      projectId: project.id,
      revision: nextContractRevision,
      goalRevision: project.goalRevision,
      activate: true,
    });
    for (const rule of [...rules.values()].sort((left, right) => left.id.localeCompare(right.id))) {
      store.addRule({ ...rule, projectId: project.id, contractRevision: nextContractRevision });
    }
    for (const item of [...context.values()].sort((left, right) => left.id.localeCompare(right.id))) {
      store.addContextItem({
        ...item,
        projectId: project.id,
        goalRevision: project.goalRevision,
        contractRevision: nextContractRevision,
      });
    }
    const nextBrief = brief ?? previousBrief;
    if (nextBrief) {
      const latest = store.getLatestProductBrief({ projectId: project.id });
      store.addProductBrief({
        projectId: project.id,
        briefRevision: (latest?.briefRevision ?? 0) + 1,
        goalRevision: project.goalRevision,
        contractRevision: nextContractRevision,
        summary: nextBrief.summary,
        nextStep: nextBrief.nextStep ?? null,
      });
    }
  });
}

function openProject(args) {
  return withStore(args.workspacePath, (store, location) => {
    const projectId = args.projectId === undefined ? DEFAULT_PROJECT_ID : requiredString(args.projectId, 'projectId');
    let project = store.getProject(projectId);
    if (!project) {
      project = store.createProject({
        id: projectId,
        goal: requiredString(args.goal, 'goal'),
        minimalExperiment: {
          host: RUNTIME_HOST,
          plugin: 'builder-mode',
          phase: 'C1',
        },
      });
    }
    return {
      message: `Builder project ${projectId} is ready at state revision ${project.stateRevision}.`,
      data: { workspacePath: location.workspace, ...summarizeSnapshot(store, projectId) },
    };
  });
}

function getProject(args) {
  return withStore(args.workspacePath, (store, location) => {
    const projectId = args.projectId === undefined ? DEFAULT_PROJECT_ID : requiredString(args.projectId, 'projectId');
    if (!store.getProject(projectId)) throw new Error(`Builder project not found: ${projectId}.`);
    const snapshot = summarizeSnapshot(store, projectId);
    return {
      message: `Loaded Builder project ${projectId} at state revision ${snapshot.stateRevision}.`,
      data: { workspacePath: location.workspace, ...snapshot },
    };
  }, { readOnly: true });
}

function recordContract(args) {
  return withStore(args.workspacePath, (store) => {
    const projectId = args.projectId === undefined ? DEFAULT_PROJECT_ID : requiredString(args.projectId, 'projectId');
    const expected = requiredPositiveInteger(args.expectedStateRevision, 'expectedStateRevision');
    const project = store.getProject(projectId);
    if (!project) throw new Error(`Builder project not found: ${projectId}.`);
    if (project.stateRevision !== expected) {
      throw new Error(`Stale project state: expected ${expected}, current ${project.stateRevision}. Reload before writing.`);
    }
    if (!Array.isArray(args.rules) || args.rules.length === 0) {
      throw new TypeError('rules must contain at least one product rule.');
    }
    const updates = args.rules.map((rule, index) => {
      const status = requiredString(rule?.status, `rules[${index}].status`);
      if (!['confirmed', 'assumed'].includes(status)) {
        throw new TypeError(`rules[${index}].status must be confirmed or assumed.`);
      }
      const source = requiredString(rule?.source, `rules[${index}].source`);
      if (!['user', 'assistant', 'research'].includes(source)) {
        throw new TypeError(`rules[${index}].source must be user, assistant, or research.`);
      }
      return {
        id: requiredString(rule?.id, `rules[${index}].id`),
        text: requiredString(rule?.text, `rules[${index}].text`),
        status,
        source: source === 'user' ? 'assistant-attributed-user' : source,
        examples: Array.isArray(rule?.examples) ? rule.examples.map((item) => requiredString(item, 'rule example')) : [],
      };
    });

    advanceContract(store, project, { ruleUpdates: updates });
    const snapshot = summarizeSnapshot(store, projectId);
    return {
      message: `Recorded product contract revision ${snapshot.project.contractRevision}.`,
      data: snapshot,
    };
  });
}

function recordProductContext(args) {
  return withStore(args.workspacePath, (store) => {
    const projectId = args.projectId === undefined ? DEFAULT_PROJECT_ID : requiredString(args.projectId, 'projectId');
    const expected = requiredPositiveInteger(args.expectedStateRevision, 'expectedStateRevision');
    const project = store.getProject(projectId);
    if (!project) throw new Error(`Builder project not found: ${projectId}.`);
    if (project.stateRevision !== expected) {
      throw new Error(`Stale project state: expected ${expected}, current ${project.stateRevision}. Reload before writing.`);
    }
    const rawItems = args.items ?? [];
    if (!Array.isArray(rawItems)) throw new TypeError('items must be an array.');
    const contextUpdates = rawItems.map((item, index) => {
      const kind = requiredString(item?.kind, `items[${index}].kind`);
      if (!['audience', 'outcome', 'constraint', 'decision', 'assumption', 'open_question', 'research_fact'].includes(kind)) {
        throw new TypeError(`Unsupported product context kind: ${kind}.`);
      }
      const source = requiredString(item?.source, `items[${index}].source`);
      if (!['user', 'assistant', 'research'].includes(source)) {
        throw new TypeError(`items[${index}].source must be user, assistant, or research.`);
      }
      const status = item?.status === undefined ? 'active' : requiredString(item.status, `items[${index}].status`);
      if (!['active', 'resolved'].includes(status)) {
        throw new TypeError(`items[${index}].status must be active or resolved.`);
      }
      const sourceRef = item?.sourceRef === undefined ? null : requiredString(item.sourceRef, `items[${index}].sourceRef`);
      if (kind === 'decision' && source !== 'user') {
        throw new Error('A product decision can only be recorded as user-attributed, never as an assistant decision.');
      }
      if (kind === 'assumption' && source !== 'assistant') {
        throw new Error('Assumptions must be labeled as assistant-sourced.');
      }
      if (kind === 'research_fact' && (source !== 'research' || sourceRef === null)) {
        throw new Error('Research facts require source=research and a sourceRef citation.');
      }
      return {
        id: requiredString(item?.id, `items[${index}].id`),
        kind,
        text: requiredString(item?.text, `items[${index}].text`),
        status,
        source,
        sourceRef: sourceRef ?? (source === 'user' ? 'current-user-request-unattested' : null),
        attestation: source === 'user'
          ? 'assistant_attributed'
          : source === 'research' ? 'research_cited' : 'none',
      };
    });
    let brief = null;
    if (args.brief !== undefined) {
      if (!args.brief || typeof args.brief !== 'object' || Array.isArray(args.brief)) {
        throw new TypeError('brief must be an object.');
      }
      brief = {
        summary: requiredString(args.brief.summary, 'brief.summary'),
        nextStep: args.brief.nextStep === undefined ? null : requiredString(args.brief.nextStep, 'brief.nextStep'),
      };
    }
    if (contextUpdates.length === 0 && brief === null) {
      throw new TypeError('Provide at least one context item or a product brief.');
    }
    store.transaction(() => {
      for (const item of contextUpdates) {
        store.addContextItem({
          ...item,
          projectId,
          goalRevision: project.goalRevision,
          contractRevision: project.contractRevision,
        });
      }
      if (brief) {
        const latest = store.getLatestProductBrief({ projectId });
        store.addProductBrief({
          projectId,
          briefRevision: (latest?.briefRevision ?? 0) + 1,
          goalRevision: project.goalRevision,
          contractRevision: project.contractRevision,
          summary: brief.summary,
          nextStep: brief.nextStep,
        });
      }
    });
    const snapshot = summarizeSnapshot(store, projectId);
    return {
      message: `Recorded product context without changing goal or contract revision ${snapshot.project.contractRevision}. User-attributed items are marked assistant_attributed unless the Host can attest them.`,
      data: snapshot,
    };
  });
}

function changeDirection(args) {
  return withStore(args.workspacePath, (store) => {
    const projectId = args.projectId === undefined ? DEFAULT_PROJECT_ID : requiredString(args.projectId, 'projectId');
    const expected = requiredPositiveInteger(args.expectedStateRevision, 'expectedStateRevision');
    const snapshot = store.reviseProjectGoal({
      projectId,
      expectedRevision: expected,
      goal: requiredString(args.newGoal, 'newGoal'),
      decision: requiredString(args.decision, 'decision'),
      briefSummary: requiredString(args.briefSummary, 'briefSummary'),
      nextStep: args.nextStep === undefined ? null : requiredString(args.nextStep, 'nextStep'),
      authority: stateHostAuthority,
    });
    return {
      message: `Changed the product direction to goal revision ${snapshot.project.goalRevision}. The user decision is assistant-attributed, not Host-attested; prior evidence is historical only.`,
      data: summarizeSnapshot(store, projectId),
    };
  });
}

function beginChange(args) {
  return withStore(args.workspacePath, (store, location) => {
    const projectId = args.projectId === undefined ? DEFAULT_PROJECT_ID : requiredString(args.projectId, 'projectId');
    const expected = requiredPositiveInteger(args.expectedStateRevision, 'expectedStateRevision');
    const project = store.getProject(projectId);
    if (!project) throw new Error(`Builder project not found: ${projectId}.`);
    const alignedPlan=requireAlignedPlan(store, project);
    if (project.stateRevision !== expected) {
      throw new Error(`Stale project state: expected ${expected}, current ${project.stateRevision}. Reload before writing.`);
    }
    const profileName = requiredString(args.verificationProfile, 'verificationProfile');
    const profile = PROFILE_DEFINITIONS[profileName];
    if (!profile) throw new Error(`Unsupported verification profile: ${profileName}.`);
    const candidatePath = requiredString(args.candidatePath, 'candidatePath');
    if (path.isAbsolute(candidatePath) || candidatePath.split(/[\\/]+/u).includes('..') || candidatePath.startsWith('.builder-mode')) {
      throw new TypeError('candidatePath must be a safe relative directory outside .builder-mode.');
    }
    const activeWriter = store.listRecoverableAttempts(projectId).find((attempt) => attempt.writer);
    if (activeWriter) {
      throw new Error(`A previous writer is not confirmed stopped: ${activeWriter.id}.`);
    }
    const objective = requiredString(args.objective, 'objective');
    const previous = store.readSnapshot(projectId).attempts.filter((entry) =>
      entry.goalRevision === project.goalRevision && entry.contractRevision === project.contractRevision
      && entry.workspacePath === path.join(location.workspace, candidatePath)).at(-1);
    const failedTask = previous?.status === 'failed' ? store.getTask(previous.taskId) : null;
    let repairRoot = null;
    let repairOrdinal = 0;
    let diagnosis = null;
    if (failedTask && failedTask.input?.verificationProfile === profileName) {
      diagnosis = requiredString(args.diagnosis, 'diagnosis for retry of failed work');
      repairRoot = failedTask.input?.repairRoot ?? failedTask.id;
      const repairs = store.readSnapshot(projectId).tasks.filter((entry) => entry.input?.repairRoot === repairRoot);
      const limit = runtimePolicy.max_auto_repairs_per_task;
      if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Repair policy unavailable');
      if (repairs.length >= limit) throw new Error('TASK_REPAIR_LIMIT: diagnose a new approach before any further work');
      if (repairs.some((entry) => entry.input.diagnosis === diagnosis)) {
        throw new Error('REPEATED_DIAGNOSIS: the same failure requires new evidence, not another identical retry');
      }
      repairOrdinal = repairs.length + 1;
    }
    const taskId = `change-${randomUUID()}`;
    const attemptId = `attempt-${randomUUID()}`;
    const acceptancePlan = profileName === 'artifact-data-v1'
      ? require(path.join(pluginRoot, 'runtime/suites/artifact-data.cjs')).validatePlan(args.acceptancePlan) : null;
    if (args.acceptancePlan && !acceptancePlan) throw new Error('acceptancePlan requires artifact-data-v1');
    const input = { objective, verificationProfile: profileName, candidatePath, repairRoot, repairOrdinal, diagnosis,
      planId:alignedPlan.planId, planDigest:alignedPlan.planDigest,
      acceptancePlan, planSource: acceptancePlan ? 'assistant_proposed' : 'host_profile' };
    const inputDigest = sha256(JSON.stringify({
      projectId,
      goalRevision: project.goalRevision,
      contractRevision: project.contractRevision,
      input,
      acceptance: profile.acceptance,
    }));
    store.createTask({
      id: taskId,
      projectId,
      goalRevision: project.goalRevision,
      contractRevision: project.contractRevision,
      acceptance: [...profile.acceptance],
      status: 'ready',
      allowedPaths: [candidatePath],
      prohibitedActions: ['external-publish', 'external-send', 'payment', 'real-customer-data'],
      input,
      workspacePath: path.join(location.workspace, candidatePath),
      executionMode: `${RUNTIME_HOST}-native`,
    });
    store.setTaskStatus(taskId, 'running');
    store.createAttempt({
      id: attemptId,
      taskId,
      goalRevision: project.goalRevision,
      contractRevision: project.contractRevision,
      provider: `${RUNTIME_HOST}-native`,
      workspacePath: path.join(location.workspace, candidatePath),
      inputDigest,
      status: 'running',
      writer: true,
      workPackage: { objective, acceptance: [...profile.acceptance], candidatePath },
    });
    const snapshot = summarizeSnapshot(store, projectId);
    return {
      message: `Started ${taskId}. Implement only inside ${candidatePath}, then call builder_verify_change.`,
      data: { taskId, attemptId, inputDigest, ...snapshot },
    };
  });
}

function verifyChange(args) {
  return withStore(args.workspacePath, (store, location) => {
    const projectId = args.projectId === undefined ? DEFAULT_PROJECT_ID : requiredString(args.projectId, 'projectId');
    const expected = requiredPositiveInteger(args.expectedStateRevision, 'expectedStateRevision');
    const project = store.getProject(projectId);
    if (!project) throw new Error(`Builder project not found: ${projectId}.`);
    if (project.stateRevision !== expected) {
      throw new Error(`Stale project state: expected ${expected}, current ${project.stateRevision}. Reload before verifying.`);
    }
    const taskId = requiredString(args.taskId, 'taskId');
    const attemptId = requiredString(args.attemptId, 'attemptId');
    const task = store.getTask(taskId);
    const attempt = store.getAttempt(attemptId);
    if (!task || task.projectId !== projectId || !attempt || attempt.taskId !== taskId) {
      throw new Error('Task and attempt must belong to the selected Builder project.');
    }
    if (task.status !== 'running' || attempt.status !== 'running') {
      throw new Error(`Only a running change can be verified; got ${task.status}/${attempt.status}.`);
    }
    if (task.goalRevision !== project.goalRevision || task.contractRevision !== project.contractRevision) {
      throw new Error('The change is stale for the current product contract.');
    }
    if(task.input?.planId) {
      const aligned=requireAlignedPlan(store,project);
      if(task.input.planId!==aligned.planId || task.input.planDigest!==aligned.planDigest) throw new Error('The change belongs to a replaced product plan');
    }
    const profile = PROFILE_DEFINITIONS[task.input?.verificationProfile];
    if (!profile) throw new Error('The task does not have a supported Host verification profile.');
    let result;
    let candidate;
    try {
    const candidatePath = resolveCandidate(location.workspace, location.stateRoot, task.input.candidatePath);
    if (candidatePath !== realpathSync(attempt.workspacePath)) {
      throw new Error('Candidate path no longer matches the recorded attempt.');
    }
    candidate = buildCandidateManifest(candidatePath);
    const suiteRoot = path.join(pluginRoot, 'runtime', 'suites');
    const service = new HostVerificationService({
      snapshotRoot: path.join(location.stateRoot, 'verification', 'snapshots'),
      suiteRoot,
      reportRoot: path.join(location.stateRoot, 'verification', 'reports'),
      environment: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC',
        ...(task.input.acceptancePlan ? { BUILDER_ACCEPTANCE_PLAN: JSON.stringify(task.input.acceptancePlan) } : {}) },
      checks: [{
        id: task.input.verificationProfile,
        command: process.execPath,
        args: [],
        suiteFiles: [profile.suiteFile],
        required: true,
        timeoutMs: 60_000,
      }],
      isolation: profile.reviewRequired ? {
        provider: 'Host data-only checks', filesystem: 'Snapshot data is read, never executed',
        network: 'No network requests performed by the check',
        process: 'No candidate code executed',
      } : {
        provider: 'macOS Seatbelt (/usr/bin/sandbox-exec)',
        filesystem: task.input.verificationProfile === 'registration-persistent-v1'
          ? 'candidate code is read-only; writes are limited to one Host-created temporary product-data directory and /dev/null'
          : 'candidate runs from a Host-owned read-only snapshot; source workspace and test-suite data reads are denied; all file writes are denied except /dev/null',
        network: 'loopback-only; non-local network denied',
        process: 'candidate process-fork denied; supervisor terminates the isolated process group',
      },
    });
    const currentAttempt = store.getAttempt(attemptId);
      result = service.verify({
        projectId,
        taskId,
        attemptId,
        goalRevision: project.goalRevision,
        contractRevision: project.contractRevision,
        codeDigest: candidate.candidateDigest,
        inputDigest: currentAttempt.inputDigest,
        environmentDigest: sha256(JSON.stringify({ node: process.version, profile: task.input.verificationProfile })),
        candidate,
        hostContext: {
          pluginId: PLUGIN_ID,
          pluginVersion: SERVER_VERSION,
          installedPluginRoot: pluginRoot,
        },
      });
    const reportDigest = sha256(readFileSync(result.reportPath));
    const evidenceId = `verification-${result.report.verificationId}`;
    store.transaction(() => {
      store.setAttemptStatus(attemptId, 'candidate');
      store.setTaskStatus(taskId, 'candidate');
      store.addEvidence({
        id: evidenceId,
        taskId,
        attemptId,
        goalRevision: project.goalRevision,
        contractRevision: project.contractRevision,
        kind: 'host-verification',
        digest: reportDigest,
        location: result.reportPath,
        status: result.report.status,
        exitCode: result.report.checks.find((check) => check.required)?.exitCode ?? null,
        details: {
          candidateDigest: candidate.candidateDigest,
          snapshotPath: result.snapshotPath,
          verificationScope: profile.reviewRequired ? 'structure_only' : 'profile_behavior_checks',
          testSuiteDigest: result.report.binding.testSuiteDigest,
          verifierDigest: result.report.verifier.sha256,
          pluginId: PLUGIN_ID,
          pluginVersion: SERVER_VERSION,
          limitations: result.report.limits,
        },
      });
      if (result.report.status === 'passed' && profile.reviewRequired) {
        store.setTaskStatus(taskId, 'verifying');
      } else if (result.report.status === 'passed') {
        store.verifyAttempt({ attemptId, evidenceIds: [evidenceId] });
        store.acceptTask({ taskId, attemptId });
      } else {
        store.setAttemptStatus(attemptId, 'failed');
        store.setTaskStatus(taskId, 'needs_revision');
      }
    });
    const snapshot = summarizeSnapshot(store, projectId);
    return {
      message: result.report.status === 'passed' && profile.reviewRequired
        ? 'Artifact completeness checks passed; factual/creative quality requires review. This is not an accepted delivery.'
        : result.report.status === 'passed'
        ? `Accepted ${taskId} with Host verification evidence ${evidenceId}.`
        : `Host verification did not pass for ${taskId}; the change was not accepted.`,
      data: {
        status: result.report.status === 'passed'
          ? (profile.reviewRequired ? 'needs_review' : 'accepted') : result.report.status,
        taskId,
        attemptId,
        evidenceId,
        reportPath: result.reportPath,
        snapshotPath: result.snapshotPath,
        checks: result.report.checks,
        limitations: result.report.limits,
        ...snapshot,
      },
    };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const evidenceId = `verification-error-${randomUUID()}`;
      store.transaction(() => {
        store.addEvidence({ id: evidenceId, taskId, attemptId,
          goalRevision: project.goalRevision, contractRevision: project.contractRevision,
          kind: 'host-verification-error', digest: sha256(message),
          location: `builder://verification-error/${evidenceId}`, status: 'failed',
          exitCode: null, details: { message } });
        store.setAttemptStatus(attemptId, 'failed');
        store.setTaskStatus(taskId, 'needs_revision');
      });
      return { isError: true, message: `Verification failed safely: ${message}`,
        data: { status: 'failed', evidenceId, ...summarizeSnapshot(store, projectId) } };
    }
  });
}

async function backupProject(args) {
  const location = projectLocation(args.workspacePath, { create: false });
  const root = path.join(location.stateRoot, 'backups');
  if (existsSync(root) && lstatSync(root).isSymbolicLink()) throw new Error('Backup root cannot be a symlink');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const destination = path.join(root, randomUUID());
  const manifest = await backupWorkspace(location.stateRoot, destination);
  return { message: 'State, journals and frozen verification assets backed up. Live business data and working code remain separate.',
    data: { destination, backupId: path.basename(destination), manifest } };
}

async function restoreBackup(args) {
  const location = projectLocation(args.workspacePath, { create: false });
  const backupId = requiredString(args.backupId, 'backupId');
  if (!/^[0-9a-f-]{36}$/.test(backupId)) throw new Error('Invalid backup identifier');
  const backupRoot = path.join(location.stateRoot, 'backups');
  const archive = path.join(backupRoot, backupId);
  for (const pathname of [backupRoot, archive]) {
    if (lstatSync(pathname).isSymbolicLink()) throw new Error('Backup path cannot be a symlink');
  }
  const recoveryRoot = path.join(location.stateRoot, 'recovered');
  if (existsSync(recoveryRoot) && lstatSync(recoveryRoot).isSymbolicLink()) throw new Error('Recovery root cannot be a symlink');
  mkdirSync(recoveryRoot, { recursive: true, mode: 0o700 });
  const restoredWorkspace = path.join(recoveryRoot, randomUUID());
  mkdirSync(restoredWorkspace, { mode: 0o700 });
  const restored = await restoreWorkspace(archive, path.join(restoredWorkspace, '.builder-mode'));
  return { message: 'Restored control state to a separate workspace; original data is intact. Code and business data require their own versioned assets.',
    data: { ...restored, restoredWorkspace, sourceWorkspace: location.workspace } };
}

function recoveryStatus(args) {
  const location = projectLocation(args.workspacePath, { create: false });
  const snapshot = getProject(args).data;
  return inspectRecovery(location, snapshot);
}

function inspectRecovery(location, snapshot) {
  const assetErrors = auditWorkspaceAssets(location.stateRoot);
  const unknown = snapshot.attempts.filter((attempt) => attempt.unconfirmedActive
    || ['running', 'prepared', 'unknown_outcome', 'cancel_requested'].includes(attempt.status));
  const policyFile = path.join(location.stateRoot, 'policy.sqlite');
  checkDatabaseFile(policyFile);
  const operationFile = path.join(location.stateRoot, 'verification-operations.sqlite');
  checkDatabaseFile(operationFile);
  let verificationOperations = [];
  if (existsSync(operationFile)) {
    if (lstatSync(operationFile).isSymbolicLink()) throw new Error('Operation journal cannot be a symlink');
    const db = new DatabaseSync(operationFile, { readOnly: true });
    try {
      verificationOperations = db.prepare('SELECT * FROM operations ORDER BY rowid').all().map((operation) => {
        const attempt = snapshot.attempts.find((entry) => entry.id === operation.attempt_id);
        const task = snapshot.tasks.find((entry) => entry.id === operation.task_id);
        const evidence = snapshot.evidence.find((entry) => entry.attemptId === operation.attempt_id && entry.status === 'passed');
        let committed = null;
        if (task?.status === 'accepted' && attempt?.verified && evidence) committed = 'accepted';
        else if (task?.status === 'verifying' && attempt?.status === 'candidate' && evidence) committed = 'needs_review';
        else if (attempt?.status === 'failed' && snapshot.evidence.some(e => e.attemptId === attempt.id && e.status === 'failed')) committed = 'failed';
        return { ...operation, committedStatus: committed,
          reconciled: ['pending','error'].includes(operation.status)
            ? (committed ? 'committed_result_found' : 'unknown_do_not_redispatch') : operation.status };
      });
    } finally { db.close(); }
  }
  let actions = [];
  if (existsSync(policyFile)) {
    if (lstatSync(policyFile).isSymbolicLink()) throw new Error('Policy journal cannot be a symlink');
    const db = new DatabaseSync(policyFile, { readOnly: true });
    try {
      const row = db.prepare('SELECT payload FROM policy_journal WHERE id=1').get();
      actions = JSON.parse(row.payload).intents.map(({ id, idempotencyKey, status, dispatchCount }) =>
        ({ id, idempotencyKey, status, dispatchCount }));
    } finally { db.close(); }
  }
  const unresolvedOperations = verificationOperations.filter(o => o.reconciled === 'unknown_do_not_redispatch');
  const unresolvedActions = actions.filter(a => ['dispatched','unknown'].includes(a.status));
  return { message: unknown.length || unresolvedOperations.length || unresolvedActions.length || assetErrors.length ? 'Recovery requires reconciliation; no work redispatched.'
    : 'No unresolved local writer. Restore to a separate directory preserves the live project.',
    data: { stateRevision: snapshot.stateRevision, unknown, actions, verificationOperations,
      assetErrors,
      requiresReconciliation: !!(unknown.length || unresolvedOperations.length || unresolvedActions.length || assetErrors.length),
      automaticRedispatch: false, stopEvidenceAvailable: false,
      restoreMechanism: 'builder_restore_backup restores state, journals and frozen assets to a new directory; live code/data remain separate.' } };
}

function checkExternalAction(args) {
  const location = projectLocation(args.workspacePath, { create: false });
  const snapshot = getProject(args).data;
  const authority = Object.freeze({});
  const policyFile = path.join(location.stateRoot, 'policy.sqlite');
  checkDatabaseFile(policyFile);
  if (existsSync(policyFile) && lstatSync(policyFile).isSymbolicLink()) throw new Error('Policy journal cannot be a symlink');
  const engine = new DurableHostPolicyEngine({
    filename: policyFile, approvalAuthority: authority,
    supportedActions: ['public_publish', 'new_paid_service', 'real_customer_data', 'external_request'],
    policy: runtimePolicy,
  });
  try {
    const key = requiredString(args.idempotencyKey, 'idempotencyKey');
    const prepared = engine.prepareAction({
      id: sha256(key), idempotencyKey: key, projectId: snapshot.project.id,
      goalRevision: snapshot.project.goalRevision, contractRevision: snapshot.project.contractRevision,
      action: requiredString(args.action, 'action'), resource: requiredString(args.resource, 'resource'),
      scopeDigest: sha256(args.resource), actor: { type: 'model', id: 'proposal-only' },
    });
    if (!prepared.allowed) return { message: prepared.reason, data: prepared };
    const decision = engine.authorizeAction({ intentId: prepared.intent.id,
      usageAuthority: authority, usage: { visibility: 'unknown' } });
    return { message: decision.reason ?? 'No external connector configured; no action executed.',
      data: { ...decision, executed: false, intentId: prepared.intent.id, approvalSource: 'none' } };
  } finally { engine.close(); }
}

export const toolDefinitions = Object.freeze([
  {
    name: 'builder_review_reply', title: 'Check a reply before sending it',
    description: 'Review the exact draft of every owner-facing progress message, question and final reply before sending. Locally checks jargon, technical density and saved user preference, with a disclosed assistant semantic self-review. Revise failed drafts; send passing sendText unchanged. Does not verify facts or intercept host output. Can run before project creation.',
    inputSchema: { type: 'object', properties: {
      workspacePath: { type: 'string' }, projectId: { type: 'string' },
      draft: { type: 'string', maxLength: 24000 }, kind: { type: 'string', enum: ['progress','question','final'] },
      selfReview: { type: 'object', properties: {
        meaningFirst: { type: 'boolean' }, necessaryDetailOnly: { type: 'boolean' }, risksAndUnknownsPreserved: { type: 'boolean' },
      }, required: ['meaningFirst','necessaryDetailOnly','risksAndUnknownsPreserved'], additionalProperties: false },
    }, required: ['draft','kind','selfReview'], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'builder_set_communication_preference', title: 'Remember how much technical detail the user wants',
    description: 'Save an actual explicit user-background statement and its reference, limiting technical detail to familiar topics. Default is plain; do not infer expertise from terminology, credentials, examples, or a hypothetical request. Plain resets the preference. This is assistant attribution, not authenticated consent or action authorization.',
    inputSchema: { type: 'object', properties: {
      workspacePath: { type: 'string' }, projectId: { type: 'string' }, expectedStateRevision: { type: 'integer' },
      level: { type: 'string', enum: ['plain','limited_technical'] },
      topics: { type: 'array', maxItems: 4, items: { type: 'string', enum: ['frontend','data','operations','programming'] } },
      userQuote: { type: 'string' }, sourceRef: { type: 'string' },
    }, required: ['workspacePath','expectedStateRevision','level','topics','userQuote','sourceRef'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name:'builder_propose_plan',title:'Discuss the first usable version',
    description:'Save a short user-facing first-version proposal: outcome, where it will be used, included/excluded scope, order and next checkpoint. Does not start implementation.',
    inputSchema:{type:'object',properties:{workspacePath:{type:'string'},projectId:{type:'string'},expectedStateRevision:{type:'integer'},
      userOutcome:{type:'string'},whereYouWillUseIt:{type:'string'},firstVersion:{type:'array',minItems:1,maxItems:5,items:{type:'string'}},notIncluded:{type:'array',minItems:1,maxItems:5,items:{type:'string'}},
      steps:{type:'array',minItems:1,maxItems:5,items:{type:'string'}},nextCheckpoint:{type:'string'},openChoices:{type:'array',maxItems:5,items:{type:'string'}}},
      required:['workspacePath','expectedStateRevision','userOutcome','whereYouWillUseIt','firstVersion','notIncluded','steps','nextCheckpoint'],additionalProperties:false},
    annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},
  },
  {
    name:'builder_record_plan_response',title:'Record the user response to the product plan',
    description:'Record an actual response to the latest first-version proposal. Provider selection or credentials are not plan acceptance. Assistant-attributed, never external authorization.',
    inputSchema:{type:'object',properties:{workspacePath:{type:'string'},projectId:{type:'string'},expectedStateRevision:{type:'integer'},
      planId:{type:'string'},planDigest:{type:'string'},responseTo:{type:'string',enum:['product_plan']},response:{type:'string',enum:['accept','revise','discuss']},userQuote:{type:'string'},sourceRef:{type:'string'}},
      required:['workspacePath','expectedStateRevision','planId','planDigest','responseTo','response','userQuote','sourceRef'],additionalProperties:false},
    annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},
  },
  {
    name: 'builder_reconcile_decision', title: 'Reconcile an obsolete pending decision',
    description: 'Record why a stale-contract pending decision is replaced or no longer relevant. Cannot answer a current decision, select an option or grant approval.',
    inputSchema: { type: 'object', properties: {
      workspacePath: { type: 'string' }, projectId: { type: 'string' }, expectedStateRevision: { type: 'integer' },
      decisionId: { type: 'string' }, resolution: { type: 'string', enum: ['replaced','no_longer_relevant'] },
      replacementDecisionId: { type: 'string' }, reason: { type: 'string' }, sourceRef: { type: 'string' },
    }, required: ['workspacePath','expectedStateRevision','decisionId','resolution','reason','sourceRef'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'builder_get_brief', title: 'Read owner-facing progress and decisions',
    description: 'Read an owner-facing overview: goal, evidence-scoped results, reported expectations, risks, next checkpoint and pending business decisions. No fabricated percentage or acceptance.',
    inputSchema: { type: 'object', properties: { workspacePath: { type: 'string' }, projectId: { type: 'string' } }, required: ['workspacePath'], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'builder_record_update', title: 'Save accountable progress and expectations',
    description: 'Save concise business-facing focus, expected effect, next action/checkpoint and material risks. Result references must match current checked artifacts. Does not change task acceptance.',
    inputSchema: { type: 'object', properties: {
      workspacePath: { type: 'string' }, projectId: { type: 'string' }, expectedStateRevision: { type: 'integer' },
      currentFocus: { type: 'string' }, expectedEffect: { type: 'string' }, nextAction: { type: 'string' }, nextCheckpoint: { type: 'string' },
      meaningForYou: { type: 'string', description:'Explain the practical consequence in everyday language before implementation details.' },
      risks: { type: 'array', items: { type: 'string' } }, evidenceRefs: { type: 'array', items: { type: 'string' } },
      estimate: { type: 'object', properties: { text: { type: 'string' }, basis: { type: 'string' }, confidence: { type: 'string', enum: ['low','medium','high','unknown'] } }, required: ['text','basis','confidence'], additionalProperties: false },
    }, required: ['workspacePath','expectedStateRevision','meaningForYou','currentFocus','expectedEffect','nextAction','nextCheckpoint'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'builder_prepare_decision', title: 'Explain a genuine owner decision',
    description: 'Prepare two or three business options with effect, cost/time/risk/reversibility, recommendation and consequence of deferring. Never use for routine technical implementation choices.',
    inputSchema: { type: 'object', properties: {
      workspacePath: { type: 'string' }, projectId: { type: 'string' }, expectedStateRevision: { type: 'integer' },
      category: { type: 'string', enum: ['scope','budget','permission','safety','priority','quality_tradeoff'] },
      question: { type: 'string' }, whyNow: { type: 'string' }, responsibleRole: { type: 'string' }, ifDeferred: { type: 'string' },
      recommendedOptionId: { type: 'string' }, recommendationReason: { type: 'string' },
      options: { type: 'array', minItems: 2, maxItems: 3, items: { type: 'object', properties: {
        id: { type: 'string' }, label: { type: 'string' }, expectedOutcome: { type: 'string' }, costImpact: { type: 'string' },
        timeImpact: { type: 'string' }, risk: { type: 'string' }, reversibility: { type: 'string' },
      }, required: ['id','label','expectedOutcome','costImpact','timeImpact','risk','reversibility'], additionalProperties: false } },
    }, required: ['workspacePath','expectedStateRevision','category','question','whyNow','responsibleRole','ifDeferred','recommendedOptionId','recommendationReason','options'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'builder_record_decision_response', title: 'Record attributed owner choice',
    description: 'Record an actual user statement choosing an option, with its message reference. Assistant-attributed, not Host approval; cannot execute or authorize an external action.',
    inputSchema: { type: 'object', properties: {
      workspacePath: { type: 'string' }, projectId: { type: 'string' }, expectedStateRevision: { type: 'integer' },
      decisionId: { type: 'string' }, optionId: { type: 'string' }, userQuote: { type: 'string' }, sourceRef: { type: 'string' },
    }, required: ['workspacePath','expectedStateRevision','decisionId','optionId','userQuote','sourceRef'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'builder_record_review', title: 'Record version-bound artifact feedback',
    description: 'Append a review for a verified exact candidate. User attribution is not Host approval. Never accepts a task.',
    inputSchema: { type: 'object', properties: {
      workspacePath: { type: 'string' }, projectId: { type: 'string' }, expectedStateRevision: { type: 'integer' },
      taskId: { type: 'string' }, attemptId: { type: 'string' }, verificationEvidenceId: { type: 'string' },
      candidateDigest: { type: 'string' }, criterionId: { type: 'string' },
      reviewerType: { type: 'string', enum: ['assistant','user_attributed'] },
      outcome: { type: 'string', enum: ['satisfied','changes_requested','unknown'] },
      comment: { type: 'string' }, sourceRef: { type: 'string' },
    }, required: ['workspacePath','expectedStateRevision','taskId','attemptId','verificationEvidenceId','candidateDigest','criterionId','reviewerType','outcome','comment','sourceRef'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'builder_prepare_delivery', title: 'Prepare checked local delivery',
    description: 'Copy an unchanged checked snapshot to a new delivery directory, with checks, reviews and unresolved requirements. Does not publish or grant acceptance.',
    inputSchema: { type: 'object', properties: {
      workspacePath: { type: 'string' }, projectId: { type: 'string' }, expectedStateRevision: { type: 'integer' },
      taskId: { type: 'string' }, attemptId: { type: 'string' }, verificationEvidenceId: { type: 'string' }, candidateDigest: { type: 'string' },
    }, required: ['workspacePath','expectedStateRevision','taskId','attemptId','verificationEvidenceId','candidateDigest'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'builder_restore_backup', title: 'Restore a separate copy of Builder state',
    description: 'Restore an existing backup to a new generated workspace, fence old owners, preserve unresolved work, and leave the live project intact.',
    inputSchema: { type: 'object', properties: { workspacePath: { type: 'string' }, backupId: { type: 'string' } },
      required: ['workspacePath', 'backupId'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'builder_backup_project', title: 'Back up Builder state',
    description: 'Create a new consistent control-state backup without modifying product files or replacing any live database.',
    inputSchema: { type: 'object', properties: { workspacePath: { type: 'string' } },
      required: ['workspacePath'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'builder_recovery_status', title: 'Inspect recovery needs',
    description: 'Read unresolved writers and durable external-action status. Does not claim a worker has stopped or automatically retry it.',
    inputSchema: { type: 'object', properties: { workspacePath: { type: 'string' }, projectId: { type: 'string' } },
      required: ['workspacePath'], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'builder_check_action', title: 'Check external action boundaries',
    description: 'Persist an action proposal and check the scoped policy. Never executes an external operation or generates a user approval.',
    inputSchema: { type: 'object', properties: {
      workspacePath: { type: 'string' }, projectId: { type: 'string' },
      action: { type: 'string', enum: ['public_publish', 'new_paid_service', 'real_customer_data', 'external_request'] },
      resource: { type: 'string' }, idempotencyKey: { type: 'string' },
    }, required: ['workspacePath', 'action', 'resource', 'idempotencyKey'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'builder_open_project',
    title: 'Open Builder Project',
    description: 'Create or open durable Builder product context in a local workspace. This writes only under .builder-mode.',
    inputSchema: {
      type: 'object',
      properties: {
        workspacePath: { type: 'string', description: 'Absolute local project workspace path.' },
        projectId: { type: 'string', default: DEFAULT_PROJECT_ID },
        goal: { type: 'string', description: 'Initial product goal; required only when creating the project.' },
      },
      required: ['workspacePath'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'builder_get_project',
    title: 'Get Builder Project',
    description: 'Read the current product goal, confirmed or assumed rules, changes, attempts, and verification evidence.',
    inputSchema: {
      type: 'object',
      properties: {
        workspacePath: { type: 'string', description: 'Absolute local project workspace path.' },
        projectId: { type: 'string', default: DEFAULT_PROJECT_ID },
      },
      required: ['workspacePath'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'builder_record_contract',
    title: 'Record Product Contract',
    description: 'Create a new durable product-contract revision from confirmed decisions and explicitly labeled assumptions.',
    inputSchema: {
      type: 'object',
      properties: {
        workspacePath: { type: 'string' },
        projectId: { type: 'string', default: DEFAULT_PROJECT_ID },
        expectedStateRevision: { type: 'integer', minimum: 1 },
        rules: {
          type: 'array', minItems: 1,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' }, text: { type: 'string' },
              status: { type: 'string', enum: ['confirmed', 'assumed'] },
              source: { type: 'string', enum: ['user', 'assistant', 'research'] },
              examples: { type: 'array', items: { type: 'string' } },
            },
            required: ['id', 'text', 'status', 'source'],
            additionalProperties: false,
          },
        },
      },
      required: ['workspacePath', 'expectedStateRevision', 'rules'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'builder_begin_change',
    title: 'Begin Verified Change',
    description: 'Bind one implementation change to the current product contract and a Host-controlled verification profile before editing.',
    inputSchema: {
      type: 'object',
      properties: {
        workspacePath: { type: 'string' },
        projectId: { type: 'string', default: DEFAULT_PROJECT_ID },
        expectedStateRevision: { type: 'integer', minimum: 1 },
        objective: { type: 'string' },
        diagnosis: { type: 'string', description: 'New concrete diagnosis required before retrying failed work; same-task repairs remain bounded.' },
        candidatePath: { type: 'string', description: 'Relative output directory, such as product.' },
        verificationProfile: { type: 'string', enum: Object.keys(PROFILE_DEFINITIONS) },
        acceptancePlan: { type: 'object', description: 'artifact-data-v1 only: frozen checks and reviewCriteria. Deterministic data checks, never commands.' },
      },
      required: ['workspacePath', 'expectedStateRevision', 'objective', 'candidatePath', 'verificationProfile'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'builder_record_product_context',
    title: 'Record Product Brief and Context',
    description: 'Save a readable product brief plus sourced audience, outcome, constraint, decision, assumption, research fact, or open-question items. User attribution is disclosed as assistant-attributed, not Host-attested.',
    inputSchema: {
      type: 'object',
      properties: {
        workspacePath: { type: 'string' },
        projectId: { type: 'string', default: DEFAULT_PROJECT_ID },
        expectedStateRevision: { type: 'integer', minimum: 1 },
        brief: {
          type: 'object',
          properties: {
            summary: { type: 'string' },
            nextStep: { type: 'string' },
          },
          required: ['summary'],
          additionalProperties: false,
        },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              kind: { type: 'string', enum: ['audience', 'outcome', 'constraint', 'decision', 'assumption', 'open_question', 'research_fact'] },
              text: { type: 'string' },
              status: { type: 'string', enum: ['active', 'resolved'] },
              source: { type: 'string', enum: ['user', 'assistant', 'research'] },
              sourceRef: { type: 'string', description: 'Required citation for research facts; optional attribution note otherwise.' },
            },
            required: ['id', 'kind', 'text', 'source'],
            additionalProperties: false,
          },
        },
      },
      required: ['workspacePath', 'expectedStateRevision'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'builder_change_direction',
    title: 'Change Product Direction',
    description: 'Use only after an explicit user decision to replace the product goal. Advances goal and contract revisions and makes unfinished prior work inapplicable.',
    inputSchema: {
      type: 'object',
      properties: {
        workspacePath: { type: 'string' },
        projectId: { type: 'string', default: DEFAULT_PROJECT_ID },
        expectedStateRevision: { type: 'integer', minimum: 1 },
        newGoal: { type: 'string' },
        decision: { type: 'string', description: 'Concise user-attributed direction decision; stored as assistant_attributed.' },
        briefSummary: { type: 'string' },
        nextStep: { type: 'string' },
      },
      required: ['workspacePath', 'expectedStateRevision', 'newGoal', 'decision', 'briefSummary'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'builder_verify_change',
    title: 'Verify and Accept Change',
    description: 'Freeze the recorded candidate, run its preselected Host test suite, store evidence, and accept only a passing current-revision result.',
    inputSchema: {
      type: 'object',
      properties: {
        workspacePath: { type: 'string' },
        projectId: { type: 'string', default: DEFAULT_PROJECT_ID },
        expectedStateRevision: { type: 'integer', minimum: 1 },
        taskId: { type: 'string' },
        attemptId: { type: 'string' },
      },
      required: ['workspacePath', 'expectedStateRevision', 'taskId', 'attemptId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
]);

export async function callBuilderTool(name, args = {}) {
  const definition = toolDefinitions.find((entry) => entry.name === name);
  if (!definition) throw new Error('Unknown Builder tool');
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(definition.inputSchema.properties, key)) throw new Error('Unsupported argument: ' + key);
  }
  if (definition.annotations.readOnlyHint) return dispatchBuilderTool(name, args);
  const location = projectLocation(args.workspacePath, { create: name === 'builder_open_project' });
  const coordinatorPath = path.join(location.stateRoot, 'coordination.sqlite');
  checkDatabaseFile(coordinatorPath);
  if (existsSync(coordinatorPath) && lstatSync(coordinatorPath).isSymbolicLink()) throw new Error('Coordinator cannot be a symlink');
  const coordinator = new DatabaseSync(coordinatorPath, { timeout: 1000 });
  try {
    coordinator.exec('BEGIN IMMEDIATE');
    return await dispatchBuilderTool(name, args);
  } finally { coordinator.close(); }
}

async function dispatchBuilderTool(name, args) {
  const handler = {
    builder_review_reply: args => reviewReply(args, { withStore, canonicalWorkspace }),
    builder_set_communication_preference: args => setCommunicationPreference(args, { withStore }),
    builder_propose_plan: args => proposePlan(args,{withStore}),
    builder_record_plan_response: args => recordPlanResponse(args,{withStore}),
    builder_reconcile_decision: args => reconcileDecision(args, { withStore }),
    builder_get_brief: args => getOwnerBrief(args, { withStore, inspectRecovery }),
    builder_record_update: args => recordOwnerUpdate(args, { withStore }),
    builder_prepare_decision: args => prepareDecision(args, { withStore }),
    builder_record_decision_response: args => recordDecisionResponse(args, { withStore }),
    builder_record_review: args => recordReview(args, { withStore, summarizeSnapshot }),
    builder_prepare_delivery: args => prepareDelivery(args, { withStore, summarizeSnapshot }),
    builder_restore_backup: restoreBackup,
    builder_backup_project: backupProject,
    builder_recovery_status: recoveryStatus,
    builder_check_action: checkExternalAction,
    builder_open_project: openProject,
    builder_get_project: getProject,
    builder_record_contract: recordContract,
    builder_record_product_context: recordProductContext,
    builder_change_direction: changeDirection,
    builder_begin_change: beginChange,
    builder_verify_change: verifyChange,
  }[name];
  if (!handler) throw new Error(`Unknown Builder tool: ${name}.`);
  if (name !== 'builder_verify_change') return handler(args);
  withStore(args.workspacePath, store => {
    const project = store.getProject(args.projectId ?? DEFAULT_PROJECT_ID);
    const task = store.getTask(requiredString(args.taskId, 'taskId'));
    const attempt = store.getAttempt(requiredString(args.attemptId, 'attemptId'));
    if (!project || project.stateRevision !== args.expectedStateRevision) throw new Error('Stale project state before verification');
    if (!task || !attempt || task.projectId !== project.id || attempt.taskId !== task.id) throw new Error('Task/attempt binding invalid before verification');
    if (task.status !== 'running' || attempt.status !== 'running') throw new Error('Only a running change can be verified');
    if (task.goalRevision !== project.goalRevision || task.contractRevision !== project.contractRevision) throw new Error('Stale contract before verification');
    if(task.input?.planId) {
      const aligned=requireAlignedPlan(store,project);
      if(task.input.planId!==aligned.planId || task.input.planDigest!==aligned.planDigest) throw new Error('Replaced product plan before verification');
    }
  }, { readOnly: true });
  const location = projectLocation(args.workspacePath, { create: false });
  const filename = path.join(location.stateRoot, 'verification-operations.sqlite');
  checkDatabaseFile(filename);
  if (existsSync(filename) && lstatSync(filename).isSymbolicLink()) throw new Error('Operation journal cannot be a symlink');
  const journal = new DatabaseSync(filename, { timeout: 5000 });
  const operationId = randomUUID();
  try {
    journal.exec(`PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
        expected_revision INTEGER NOT NULL, status TEXT NOT NULL, error TEXT
      ) STRICT;`);
    journal.prepare('INSERT INTO operations VALUES(?,?,?,?,?,NULL)')
      .run(operationId, requiredString(args.taskId, 'taskId'), requiredString(args.attemptId, 'attemptId'),
        requiredPositiveInteger(args.expectedStateRevision, 'expectedStateRevision'), 'pending');
    try {
      const result = await handler(args);
      journal.prepare('UPDATE operations SET status=? WHERE id=?').run(result.data.status, operationId);
      return result;
    } catch (error) {
      journal.prepare('UPDATE operations SET status=?,error=? WHERE id=?')
        .run('error', error.message, operationId);
      throw error;
    }
  } finally { journal.close(); }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

async function handleRequest(message) {
  const { id, method, params } = message;
  if (method === 'initialize') {
    sendResult(id, {
      protocolVersion: params?.protocolVersion ?? '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: 'Be the accountable product lead. Before EVERY owner-facing progress message, question and final reply, call builder_review_reply with the actual complete draft and honest semantic self-review; revise on needs_revision and send passing sendText unchanged. This read-only wording check works before project creation and is not factual certification or host-wide interception. Default to plain language; only an actual user statement of relevant background permits builder_set_communication_preference for limited technical topics; never infer expertise or authorization. For a new project, explain the first-version outcome, where it will be used, included/excluded scope, order and next checkpoint in everyday language, then get the actual user response before setup, credentials, connections or implementation. Choosing an AI provider is not accepting the product plan. Once aligned, own routine execution without repeated confirmations. Every user-facing reply starts with what it means for the user, not technical labels. Load project context/brief and distinguish checked results, expectations and permissions. Plan responses are assistant-attributed, not external authorization.',
    });
    return;
  }
  if (method === 'ping') {
    sendResult(id, {});
    return;
  }
  if (method === 'tools/list') {
    sendResult(id, { tools: toolDefinitions });
    return;
  }
  if (method === 'tools/call') {
    try {
      const outcome = await callBuilderTool(params?.name, params?.arguments ?? {});
      sendResult(id, {
        isError: outcome.isError === true,
        content: [
          { type: 'text', text: outcome.message },
          // DSH's native MCP projection renders content but not structuredContent.
          // Preserve revision/identity evidence for the model; the user-facing
          // explanation remains first and must not be replaced by this payload.
          ...(RUNTIME_HOST === 'dsh' ? [{ type: 'text', text: JSON.stringify(outcome.data) }] : []),
        ],
        structuredContent: outcome.data,
      });
    } catch (error) {
      sendResult(id, {
        isError: true,
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      });
    }
    return;
  }
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: JsonRpcError.METHOD_NOT_FOUND, message: `Method not found: ${method}` } });
  }
}

export function startStdioServer() {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let queue = Promise.resolve();
  lines.on('line', (line) => {
    if (line.trim().length === 0) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    queue = queue.then(() => handleRequest(message)).catch((error) => {
      if (message.id !== undefined) {
        send({
          jsonrpc: '2.0', id: message.id,
          error: { code: JsonRpcError.INVALID_PARAMS, message: error instanceof Error ? error.message : String(error) },
        });
      }
    });
  });
}

if (process.argv[1] && existsSync(process.argv[1])
    && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  startStdioServer();
}
