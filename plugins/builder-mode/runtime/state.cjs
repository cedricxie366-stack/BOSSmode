'use strict';

const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');

const TASK_STATUSES = new Set([
  'pending', 'ready', 'running', 'candidate', 'verifying', 'accepted',
  'blocked', 'needs_revision', 'interrupted', 'unknown_outcome',
  'superseded', 'cancelled', 'deferred',
]);
const ATTEMPT_STATUSES = new Set([
  'prepared', 'running', 'candidate', 'failed', 'blocked', 'interrupted',
  'unknown_outcome', 'cancel_requested', 'stopped', 'cancelled', 'timed_out',
  'superseded',
]);
const ATTEMPT_TRANSITIONS = new Map([
  ['prepared', new Set(['running', 'candidate', 'failed', 'blocked', 'interrupted', 'unknown_outcome', 'cancel_requested'])],
  ['running', new Set(['candidate', 'failed', 'blocked', 'interrupted', 'unknown_outcome', 'cancel_requested', 'stopped'])],
  ['candidate', new Set(['failed'])],
  ['cancel_requested', new Set(['stopped', 'unknown_outcome'])],
]);
const EVIDENCE_STATUSES = new Set(['passed', 'failed', 'not_run', 'recorded']);
const RULE_STATUSES = new Set(['confirmed', 'assumed']);
const CONTEXT_KINDS = new Set([
  'audience', 'outcome', 'constraint', 'decision', 'assumption', 'open_question', 'research_fact',
]);
const CONTEXT_STATUSES = new Set(['active', 'resolved']);
const CONTEXT_ATTESTATIONS = new Set(['host_attested', 'assistant_attributed', 'research_cited', 'none']);
const CALLBACK_OUTCOMES = new Set([
  'candidate', 'failed', 'blocked', 'interrupted', 'timed_out', 'stopped', 'cancelled',
]);
const RECOVERABLE_ATTEMPT_STATUSES = new Set([
  'prepared', 'running', 'cancel_requested', 'unknown_outcome',
]);
const SCHEMA_VERSION = 5;
const STATE_HOST_AUTHORITIES = new WeakSet();

const SCHEMA_SQL = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS schema_meta (
    schema_version INTEGER PRIMARY KEY,
    installed_at TEXT NOT NULL DEFAULT (datetime('now'))
  ) STRICT;

  CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT PRIMARY KEY,
    goal TEXT NOT NULL,
    goal_revision INTEGER NOT NULL CHECK (goal_revision > 0),
    contract_revision INTEGER NOT NULL CHECK (contract_revision > 0),
    owner_epoch INTEGER NOT NULL CHECK (owner_epoch > 0),
    active_release_id TEXT,
    status TEXT NOT NULL,
    state_revision INTEGER NOT NULL DEFAULT 1 CHECK (state_revision > 0),
    engineering_attempts_batch INTEGER NOT NULL DEFAULT 0 CHECK (engineering_attempts_batch >= 0),
    engineering_attempts_run INTEGER NOT NULL DEFAULT 0 CHECK (engineering_attempts_run >= 0),
    no_progress_cycles INTEGER NOT NULL DEFAULT 0 CHECK (no_progress_cycles >= 0),
    minimal_experiment_scheduled INTEGER NOT NULL DEFAULT 0 CHECK (minimal_experiment_scheduled IN (0, 1)),
    minimal_experiment_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  ) STRICT;

  CREATE TABLE IF NOT EXISTS contract_revisions (
    project_id TEXT NOT NULL,
    contract_revision INTEGER NOT NULL CHECK (contract_revision > 0),
    goal_revision INTEGER NOT NULL CHECK (goal_revision > 0),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (project_id, contract_revision),
    FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS product_rules (
    project_id TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    contract_revision INTEGER NOT NULL,
    text TEXT NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('confirmed', 'assumed')),
    examples_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (project_id, rule_id, contract_revision),
    FOREIGN KEY (project_id, contract_revision)
      REFERENCES contract_revisions(project_id, contract_revision) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS product_context_items (
    project_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    goal_revision INTEGER NOT NULL CHECK (goal_revision > 0),
    contract_revision INTEGER NOT NULL CHECK (contract_revision > 0),
    kind TEXT NOT NULL CHECK (kind IN ('audience', 'outcome', 'constraint', 'decision', 'assumption', 'open_question', 'research_fact')),
    text TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'resolved')),
    source TEXT NOT NULL CHECK (source IN ('user', 'assistant', 'research')),
    source_ref TEXT,
    attestation TEXT NOT NULL CHECK (attestation IN ('host_attested', 'assistant_attributed', 'research_cited', 'none')),
    item_revision INTEGER NOT NULL DEFAULT 1 CHECK (item_revision > 0),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (project_id, item_id, goal_revision, contract_revision),
    FOREIGN KEY (project_id, contract_revision)
      REFERENCES contract_revisions(project_id, contract_revision) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS product_context_item_history (
    project_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    item_revision INTEGER NOT NULL CHECK (item_revision > 0),
    goal_revision INTEGER NOT NULL CHECK (goal_revision > 0),
    contract_revision INTEGER NOT NULL CHECK (contract_revision > 0),
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    status TEXT NOT NULL,
    source TEXT NOT NULL,
    source_ref TEXT,
    attestation TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (project_id, item_id, item_revision),
    FOREIGN KEY (project_id, contract_revision)
      REFERENCES contract_revisions(project_id, contract_revision) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS product_brief_revisions (
    project_id TEXT NOT NULL,
    brief_revision INTEGER NOT NULL CHECK (brief_revision > 0),
    goal_revision INTEGER NOT NULL CHECK (goal_revision > 0),
    contract_revision INTEGER NOT NULL CHECK (contract_revision > 0),
    summary TEXT NOT NULL,
    next_step TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (project_id, brief_revision),
    FOREIGN KEY (project_id, contract_revision)
      REFERENCES contract_revisions(project_id, contract_revision) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    goal_revision INTEGER NOT NULL CHECK (goal_revision > 0),
    contract_revision INTEGER NOT NULL CHECK (contract_revision > 0),
    acceptance_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,
    accepted_attempt_id TEXT,
    allowed_paths_json TEXT NOT NULL DEFAULT '[]',
    prohibited_actions_json TEXT NOT NULL DEFAULT '[]',
    input_json TEXT,
    workspace_path TEXT,
    execution_mode TEXT,
    small INTEGER NOT NULL DEFAULT 0 CHECK (small IN (0, 1)),
    safe INTEGER NOT NULL DEFAULT 0 CHECK (safe IN (0, 1)),
    read_only INTEGER NOT NULL DEFAULT 0 CHECK (read_only IN (0, 1)),
    force_worker INTEGER NOT NULL DEFAULT 0 CHECK (force_worker IN (0, 1)),
    repair_of_task_id TEXT,
    repair_ordinal INTEGER,
    parent_failure_evidence_id TEXT,
    accepted_via_repair_task_id TEXT,
    bounded_experiment INTEGER NOT NULL DEFAULT 0 CHECK (bounded_experiment IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (task_id, goal_revision, contract_revision),
    FOREIGN KEY (project_id, contract_revision)
      REFERENCES contract_revisions(project_id, contract_revision)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS task_dependencies (
    task_id TEXT NOT NULL,
    depends_on_task_id TEXT NOT NULL,
    PRIMARY KEY (task_id, depends_on_task_id),
    CHECK (task_id <> depends_on_task_id),
    FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE,
    FOREIGN KEY (depends_on_task_id) REFERENCES tasks(task_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS run_attempts (
    attempt_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    goal_revision INTEGER NOT NULL CHECK (goal_revision > 0),
    contract_revision INTEGER NOT NULL CHECK (contract_revision > 0),
    provider TEXT NOT NULL,
    native_session_id TEXT,
    native_job_id TEXT,
    workspace_path TEXT NOT NULL,
    input_digest TEXT NOT NULL,
    status TEXT NOT NULL,
    verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
    writer INTEGER NOT NULL DEFAULT 1 CHECK (writer IN (0, 1)),
    work_package_json TEXT,
    execution_ref_json TEXT,
    candidate_json TEXT,
    unconfirmed_active INTEGER NOT NULL DEFAULT 0 CHECK (unconfirmed_active IN (0, 1)),
    failure_reason TEXT,
    error_code TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (attempt_id, task_id, goal_revision, contract_revision),
    FOREIGN KEY (task_id, goal_revision, contract_revision)
      REFERENCES tasks(task_id, goal_revision, contract_revision)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS evidence (
    evidence_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    goal_revision INTEGER NOT NULL CHECK (goal_revision > 0),
    contract_revision INTEGER NOT NULL CHECK (contract_revision > 0),
    kind TEXT NOT NULL,
    digest TEXT NOT NULL,
    location TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'not_run', 'recorded')),
    exit_code INTEGER,
    details_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (evidence_id, attempt_id),
    FOREIGN KEY (attempt_id, task_id, goal_revision, contract_revision)
      REFERENCES run_attempts(attempt_id, task_id, goal_revision, contract_revision)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS attempt_verification_evidence (
    attempt_id TEXT NOT NULL,
    evidence_id TEXT NOT NULL,
    PRIMARY KEY (attempt_id, evidence_id),
    FOREIGN KEY (attempt_id) REFERENCES run_attempts(attempt_id) ON DELETE CASCADE,
    FOREIGN KEY (evidence_id, attempt_id)
      REFERENCES evidence(evidence_id, attempt_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS director_authorizations (
    authorization_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    goal_revision INTEGER NOT NULL CHECK (goal_revision > 0),
    contract_revision INTEGER NOT NULL CHECK (contract_revision > 0),
    authorization_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS controller_epochs (
    project_id TEXT NOT NULL,
    owner_epoch INTEGER NOT NULL CHECK (owner_epoch > 0),
    controller_id TEXT NOT NULL,
    native_session_id TEXT,
    status TEXT NOT NULL CHECK (
      status IN ('claimed', 'reconciling', 'active', 'cancel_requested', 'unknown', 'stopped')
    ),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (project_id, owner_epoch),
    FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS callback_receipts (
    callback_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    owner_epoch INTEGER NOT NULL CHECK (owner_epoch > 0),
    goal_revision INTEGER NOT NULL CHECK (goal_revision > 0),
    contract_revision INTEGER NOT NULL CHECK (contract_revision > 0),
    payload_digest TEXT NOT NULL,
    outcome TEXT NOT NULL,
    disposition TEXT NOT NULL CHECK (disposition IN ('applied', 'stale')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (callback_id, attempt_id),
    FOREIGN KEY (attempt_id) REFERENCES run_attempts(attempt_id),
    FOREIGN KEY (project_id, owner_epoch)
      REFERENCES controller_epochs(project_id, owner_epoch)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS director_events (
    event_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    callback_id TEXT NOT NULL,
    owner_epoch INTEGER NOT NULL CHECK (owner_epoch > 0),
    goal_revision INTEGER NOT NULL CHECK (goal_revision > 0),
    contract_revision INTEGER NOT NULL CHECK (contract_revision > 0),
    type TEXT NOT NULL CHECK (type = 'attempt_terminal'),
    outcome TEXT NOT NULL,
    stale INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (callback_id, attempt_id),
    FOREIGN KEY (callback_id, attempt_id)
      REFERENCES callback_receipts(callback_id, attempt_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS owner_experience_events (
    event_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    goal_revision INTEGER NOT NULL,
    contract_revision INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('update','decision','decision_response')),
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (project_id, contract_revision) REFERENCES contract_revisions(project_id, contract_revision)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_tasks_project_revision
    ON tasks(project_id, goal_revision, contract_revision);
  CREATE INDEX IF NOT EXISTS idx_attempts_task ON run_attempts(task_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_evidence_attempt ON evidence(attempt_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_controller_epochs_project
    ON controller_epochs(project_id, owner_epoch);
  CREATE INDEX IF NOT EXISTS idx_callback_receipts_project
    ON callback_receipts(project_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_director_events_project
    ON director_events(project_id, created_at);

  INSERT OR IGNORE INTO schema_meta(schema_version) VALUES (1);
`;

const DIRECTOR_COLUMN_MIGRATIONS = Object.freeze({
  projects: Object.freeze([
    ['state_revision', 'INTEGER NOT NULL DEFAULT 1 CHECK (state_revision > 0)'],
    ['engineering_attempts_batch', 'INTEGER NOT NULL DEFAULT 0 CHECK (engineering_attempts_batch >= 0)'],
    ['engineering_attempts_run', 'INTEGER NOT NULL DEFAULT 0 CHECK (engineering_attempts_run >= 0)'],
    ['no_progress_cycles', 'INTEGER NOT NULL DEFAULT 0 CHECK (no_progress_cycles >= 0)'],
    ['minimal_experiment_scheduled', 'INTEGER NOT NULL DEFAULT 0 CHECK (minimal_experiment_scheduled IN (0, 1))'],
    ['minimal_experiment_json', 'TEXT'],
  ]),
  tasks: Object.freeze([
    ['allowed_paths_json', "TEXT NOT NULL DEFAULT '[]'"],
    ['prohibited_actions_json', "TEXT NOT NULL DEFAULT '[]'"],
    ['input_json', 'TEXT'],
    ['workspace_path', 'TEXT'],
    ['execution_mode', 'TEXT'],
    ['small', 'INTEGER NOT NULL DEFAULT 0 CHECK (small IN (0, 1))'],
    ['safe', 'INTEGER NOT NULL DEFAULT 0 CHECK (safe IN (0, 1))'],
    ['read_only', 'INTEGER NOT NULL DEFAULT 0 CHECK (read_only IN (0, 1))'],
    ['force_worker', 'INTEGER NOT NULL DEFAULT 0 CHECK (force_worker IN (0, 1))'],
    ['repair_of_task_id', 'TEXT'],
    ['repair_ordinal', 'INTEGER'],
    ['parent_failure_evidence_id', 'TEXT'],
    ['accepted_via_repair_task_id', 'TEXT'],
    ['bounded_experiment', 'INTEGER NOT NULL DEFAULT 0 CHECK (bounded_experiment IN (0, 1))'],
  ]),
  run_attempts: Object.freeze([
    ['writer', 'INTEGER NOT NULL DEFAULT 1 CHECK (writer IN (0, 1))'],
    ['work_package_json', 'TEXT'],
    ['execution_ref_json', 'TEXT'],
    ['candidate_json', 'TEXT'],
    ['unconfirmed_active', 'INTEGER NOT NULL DEFAULT 0 CHECK (unconfirmed_active IN (0, 1))'],
    ['failure_reason', 'TEXT'],
    ['error_code', 'TEXT'],
  ]),
  evidence: Object.freeze([
    ['details_json', 'TEXT'],
  ]),
  product_context_items: Object.freeze([
    ['attestation', "TEXT NOT NULL DEFAULT 'none' CHECK (attestation IN ('host_attested', 'assistant_attributed', 'research_cited', 'none'))"],
    ['item_revision', 'INTEGER NOT NULL DEFAULT 1 CHECK (item_revision > 0)'],
  ]),
});

function ensureDirectorColumns(database) {
  for (const [table, additions] of Object.entries(DIRECTOR_COLUMN_MIGRATIONS)) {
    const existing = new Set(
      database.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name),
    );
    for (const [name, definition] of additions) {
      if (!existing.has(name)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  }
}

function backfillContextHistory(database) {
  database.exec(`
    INSERT OR IGNORE INTO product_context_item_history(
      project_id, item_id, item_revision, goal_revision, contract_revision,
      kind, text, status, source, source_ref, attestation, created_at
    )
    SELECT project_id, item_id, item_revision, goal_revision, contract_revision,
      kind, text, status, source, source_ref, attestation, created_at
    FROM product_context_items
  `);
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function nullableString(value, name) {
  if (value === undefined || value === null) return null;
  return requiredString(value, name);
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function enumValue(value, allowed, name) {
  if (!allowed.has(value)) {
    throw new TypeError(`${name} has an unsupported value: ${value}`);
  }
  return value;
}

function stringArray(value, name) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TypeError(`${name} must be an array of strings`);
  }
  return value;
}

function parseJson(value) {
  return JSON.parse(value);
}

function parseNullableJson(value) {
  return value === null || value === undefined ? null : parseJson(value);
}

function jsonObjectOrNull(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object or null`);
  }
  return value;
}

function createStateHostAuthority() {
  const authority = Object.freeze({ kind: 'builder-state-host-authority' });
  STATE_HOST_AUTHORITIES.add(authority);
  return authority;
}

function booleanValue(value, name, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean`);
  return value;
}

function jsonText(value) {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return value;
}

function projectFromRow(row) {
  if (!row) return null;
  return {
    id: row.project_id,
    goal: row.goal,
    goalRevision: row.goal_revision,
    contractRevision: row.contract_revision,
    ownerEpoch: row.owner_epoch,
    activeReleaseId: row.active_release_id,
    status: row.status,
    stateRevision: row.state_revision,
    minimalExperiment: parseNullableJson(row.minimal_experiment_json),
  };
}

function taskFromRow(row, dependencies = []) {
  if (!row) return null;
  return {
    id: row.task_id,
    projectId: row.project_id,
    goalRevision: row.goal_revision,
    contractRevision: row.contract_revision,
    dependencies,
    acceptance: parseJson(row.acceptance_json),
    status: row.status,
    acceptedAttemptId: row.accepted_attempt_id,
    allowedPaths: parseJson(row.allowed_paths_json),
    prohibitedActions: parseJson(row.prohibited_actions_json),
    input: parseNullableJson(row.input_json),
    workspacePath: row.workspace_path,
    executionMode: row.execution_mode,
    small: row.small === 1,
    safe: row.safe === 1,
    readOnly: row.read_only === 1,
    forceWorker: row.force_worker === 1,
    repairOfTaskId: row.repair_of_task_id,
    repairOrdinal: row.repair_ordinal,
    parentFailureEvidenceId: row.parent_failure_evidence_id,
    acceptedViaRepairTaskId: row.accepted_via_repair_task_id,
    boundedExperiment: row.bounded_experiment === 1,
  };
}

function attemptFromRow(row) {
  if (!row) return null;
  return {
    id: row.attempt_id,
    taskId: row.task_id,
    goalRevision: row.goal_revision,
    contractRevision: row.contract_revision,
    provider: row.provider,
    nativeSessionId: row.native_session_id,
    nativeJobId: row.native_job_id,
    workspacePath: row.workspace_path,
    inputDigest: row.input_digest,
    status: row.status,
    verified: row.verified === 1,
    writer: row.writer === 1,
    workPackage: parseNullableJson(row.work_package_json),
    executionRef: parseNullableJson(row.execution_ref_json),
    candidate: parseNullableJson(row.candidate_json),
    unconfirmedActive: row.unconfirmed_active === 1,
    failureReason: row.failure_reason,
    errorCode: row.error_code,
  };
}

function evidenceFromRow(row) {
  if (!row) return null;
  return {
    id: row.evidence_id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    goalRevision: row.goal_revision,
    contractRevision: row.contract_revision,
    kind: row.kind,
    digest: row.digest,
    location: row.location,
    status: row.status,
    exitCode: row.exit_code,
    details: parseNullableJson(row.details_json),
  };
}

function controllerFromRow(row) {
  if (!row) return null;
  return {
    projectId: row.project_id,
    ownerEpoch: row.owner_epoch,
    controllerId: row.controller_id,
    nativeSessionId: row.native_session_id,
    status: row.status,
  };
}

function callbackReceiptFromRow(row) {
  if (!row) return null;
  return {
    callbackId: row.callback_id,
    attemptId: row.attempt_id,
    projectId: row.project_id,
    ownerEpoch: row.owner_epoch,
    goalRevision: row.goal_revision,
    contractRevision: row.contract_revision,
    payloadDigest: row.payload_digest,
    outcome: row.outcome,
    disposition: row.disposition,
  };
}

function directorEventFromRow(row) {
  if (!row) return null;
  return {
    id: row.event_id,
    projectId: row.project_id,
    attemptId: row.attempt_id,
    callbackId: row.callback_id,
    ownerEpoch: row.owner_epoch,
    goalRevision: row.goal_revision,
    contractRevision: row.contract_revision,
    type: row.type,
    outcome: row.outcome,
    stale: row.stale === 1,
  };
}

class BuilderStateStore {
  constructor(filename = ':memory:', { readOnly = false } = {}) {
    requiredString(filename, 'filename');
    if (typeof readOnly !== 'boolean') throw new TypeError('readOnly must be a boolean');
    this._db = new DatabaseSync(filename, { readOnly, timeout: 5000 });
    this._transactionDepth = 0;
    this._closed = false;
    if (readOnly) {
      const schema = this._db.prepare('SELECT schema_version FROM schema_meta ORDER BY schema_version DESC LIMIT 1').get();
      if (!schema || schema.schema_version !== SCHEMA_VERSION) {
        this._db.close();
        this._closed = true;
        throw new Error(`unsupported read-only schema version: ${schema?.schema_version ?? 'missing'}`);
      }
    } else {
      try {
        const hasSchema = this._db.prepare("SELECT name FROM sqlite_master WHERE name='schema_meta'").get();
        const previous = hasSchema ? this._db.prepare('SELECT MAX(schema_version) AS version FROM schema_meta').get().version : null;
        if (previous > SCHEMA_VERSION) throw new Error(`unsupported future schema version: ${previous}`);
        if (previous && previous < SCHEMA_VERSION && filename !== ':memory:') {
          this.migrationBackupPath = `${filename}.before-v${SCHEMA_VERSION}-${randomUUID()}.sqlite`;
          this._db.prepare('VACUUM INTO ?').run(this.migrationBackupPath);
        }
        this._db.exec('BEGIN IMMEDIATE');
        try {
          this._db.exec(SCHEMA_SQL);
          ensureDirectorColumns(this._db);
          backfillContextHistory(this._db);
          this._db.prepare('INSERT OR IGNORE INTO schema_meta(schema_version) VALUES (?)').run(SCHEMA_VERSION);
          this._db.exec('COMMIT');
        } catch (error) { this._db.exec('ROLLBACK'); throw error; }
        this._db.exec('PRAGMA foreign_keys = ON');
      } catch (error) { this.close(); throw error; }
    }
  }

  close() {
    if (!this._closed) {
      this._db.close();
      this._closed = true;
    }
  }

  recordOwnerEvent({ id, projectId, kind, payload }) {
    requiredString(id, 'event.id');
    enumValue(kind, new Set(['update','decision','decision_response']), 'event.kind');
    jsonObjectOrNull(payload, 'event.payload');
    if (!payload) throw new Error('Owner event payload required');
    const project = this.getProject(projectId);
    if (!project) throw new Error('Project not found');
    return this.transaction(() => {
      this._db.prepare(`INSERT INTO owner_experience_events(event_id,project_id,goal_revision,contract_revision,kind,payload_json)
        VALUES(?,?,?,?,?,?)`).run(id, projectId, project.goalRevision, project.contractRevision, kind, JSON.stringify(payload));
      this._touchProject(projectId);
      return id;
    });
  }

  listOwnerEvents(projectId) {
    return this._db.prepare('SELECT * FROM owner_experience_events WHERE project_id=? ORDER BY rowid').all(projectId).map(row => ({
      id: row.event_id, projectId: row.project_id, goalRevision: row.goal_revision, contractRevision: row.contract_revision,
      kind: row.kind, payload: JSON.parse(row.payload_json), createdAt: row.created_at,
    }));
  }

  transaction(callback) {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');

    if (this._transactionDepth > 0) {
      const savepoint = `nested_${this._transactionDepth++}`;
      this._db.exec(`SAVEPOINT ${savepoint}`);
      try {
        const result = callback(this);
        if (result && typeof result.then === 'function') throw new TypeError('BuilderStateStore transactions must be synchronous');
        this._db.exec(`RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        this._db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
        throw error;
      } finally { this._transactionDepth -= 1; }
    }

    this._db.exec('BEGIN IMMEDIATE');
    this._transactionDepth += 1;
    try {
      const result = callback(this);
      if (result && typeof result.then === 'function') {
        throw new TypeError('BuilderStateStore transactions must be synchronous');
      }
      this._db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this._db.exec('ROLLBACK');
      } catch {
        // Preserve the original operation failure.
      }
      throw error;
    } finally {
      this._transactionDepth -= 1;
    }
  }

  createProject({
    id,
    goal,
    goalRevision = 1,
    contractRevision = 1,
    ownerEpoch = 1,
    activeReleaseId = null,
    status = 'active',
    minimalExperiment = null,
  }) {
    requiredString(id, 'id');
    requiredString(goal, 'goal');
    positiveInteger(goalRevision, 'goalRevision');
    positiveInteger(contractRevision, 'contractRevision');
    positiveInteger(ownerEpoch, 'ownerEpoch');
    nullableString(activeReleaseId, 'activeReleaseId');
    requiredString(status, 'status');
    jsonObjectOrNull(minimalExperiment, 'minimalExperiment');

    return this.transaction(() => {
      this._db.prepare(`
        INSERT INTO projects(
          project_id, goal, goal_revision, contract_revision, owner_epoch,
          active_release_id, status, minimal_experiment_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, goal, goalRevision, contractRevision, ownerEpoch, activeReleaseId, status,
        minimalExperiment === null ? null : JSON.stringify(minimalExperiment),
      );
      this._db.prepare(`
        INSERT INTO contract_revisions(project_id, contract_revision, goal_revision)
        VALUES (?, ?, ?)
      `).run(id, contractRevision, goalRevision);
      return this.getProject(id);
    });
  }

  getProject(id) {
    requiredString(id, 'id');
    return projectFromRow(
      this._db.prepare('SELECT * FROM projects WHERE project_id = ?').get(id),
    );
  }

  getController(projectId, ownerEpoch = null) {
    requiredString(projectId, 'projectId');
    if (ownerEpoch === null) {
      const project = this.getProject(projectId);
      if (!project) return null;
      ownerEpoch = project.ownerEpoch;
    } else {
      positiveInteger(ownerEpoch, 'ownerEpoch');
    }
    return controllerFromRow(this._db.prepare(`
      SELECT * FROM controller_epochs WHERE project_id = ? AND owner_epoch = ?
    `).get(projectId, ownerEpoch));
  }

  listControllerEpochs(projectId) {
    requiredString(projectId, 'projectId');
    return this._db.prepare(`
      SELECT * FROM controller_epochs WHERE project_id = ? ORDER BY owner_epoch
    `).all(projectId).map(controllerFromRow);
  }

  _assertExpectedProject(projectId, expectedOwnerEpoch, expectedRevision) {
    positiveInteger(expectedOwnerEpoch, 'expectedOwnerEpoch');
    positiveInteger(expectedRevision, 'expectedRevision');
    const project = this.getProject(projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
    if (project.ownerEpoch !== expectedOwnerEpoch) {
      throw new Error(
        `stale owner epoch: expected ${expectedOwnerEpoch}, current ${project.ownerEpoch}`,
      );
    }
    if (project.stateRevision !== expectedRevision) {
      throw new Error(
        `stale expectedRevision: expected ${expectedRevision}, current ${project.stateRevision}`,
      );
    }
    return project;
  }

  _assertController(projectId, ownerEpoch, { activeOnly = false } = {}) {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
    if (project.ownerEpoch !== ownerEpoch) {
      throw new Error(`stale owner epoch: expected ${ownerEpoch}, current ${project.ownerEpoch}`);
    }
    const controller = this.getController(projectId, ownerEpoch);
    if (!controller) throw new Error('controller ownership has not been claimed');
    const allowed = activeOnly
      ? new Set(['active'])
      : new Set(['claimed', 'reconciling', 'active']);
    if (!allowed.has(controller.status)) {
      throw new Error(`controller is not current and writable: ${controller.status}`);
    }
    return { project, controller };
  }

  claimController({
    projectId,
    controllerId,
    nativeSessionId = null,
    expectedOwnerEpoch,
    expectedRevision,
  }) {
    requiredString(projectId, 'projectId');
    requiredString(controllerId, 'controllerId');
    nativeSessionId = nullableString(nativeSessionId, 'nativeSessionId');

    return this.transaction(() => {
      const project = this._assertExpectedProject(
        projectId, expectedOwnerEpoch, expectedRevision,
      );
      const existing = this.getController(projectId, project.ownerEpoch);
      let nextEpoch = project.ownerEpoch;
      if (existing) {
        if (existing.status !== 'stopped') {
          throw new Error(
            `controller takeover refused until the current owner is confirmed stopped: ${existing.status}`,
          );
        }
        nextEpoch += 1;
        this._db.prepare(`
          UPDATE projects SET owner_epoch = ? WHERE project_id = ?
        `).run(nextEpoch, projectId);
      }
      this._db.prepare(`
        INSERT INTO controller_epochs(
          project_id, owner_epoch, controller_id, native_session_id, status
        ) VALUES (?, ?, ?, ?, 'claimed')
      `).run(projectId, nextEpoch, controllerId, nativeSessionId);
      this._touchProject(projectId);
      return this.getController(projectId, nextEpoch);
    });
  }

  reconcileController({ projectId, expectedOwnerEpoch, expectedRevision }) {
    requiredString(projectId, 'projectId');
    return this.transaction(() => {
      this._assertExpectedProject(projectId, expectedOwnerEpoch, expectedRevision);
      const { controller } = this._assertController(projectId, expectedOwnerEpoch);
      if (!['claimed', 'reconciling'].includes(controller.status)) {
        throw new Error(`controller cannot reconcile from status: ${controller.status}`);
      }
      this._db.prepare(`
        UPDATE controller_epochs SET status = 'reconciling', updated_at = datetime('now')
        WHERE project_id = ? AND owner_epoch = ?
      `).run(projectId, expectedOwnerEpoch);
      this._touchProject(projectId);
      return this.getController(projectId, expectedOwnerEpoch);
    });
  }

  activateController({ projectId, expectedOwnerEpoch, expectedRevision }) {
    requiredString(projectId, 'projectId');
    return this.transaction(() => {
      this._assertExpectedProject(projectId, expectedOwnerEpoch, expectedRevision);
      const { controller } = this._assertController(projectId, expectedOwnerEpoch);
      if (!['claimed', 'reconciling'].includes(controller.status)) {
        throw new Error(`controller cannot activate from status: ${controller.status}`);
      }
      this._db.prepare(`
        UPDATE controller_epochs SET status = 'active', updated_at = datetime('now')
        WHERE project_id = ? AND owner_epoch = ?
      `).run(projectId, expectedOwnerEpoch);
      this._touchProject(projectId);
      return this.getController(projectId, expectedOwnerEpoch);
    });
  }

  stopController({
    projectId,
    expectedOwnerEpoch,
    expectedRevision,
    confirmedStopped,
  }) {
    requiredString(projectId, 'projectId');
    if (typeof confirmedStopped !== 'boolean') {
      throw new TypeError('confirmedStopped must be a boolean');
    }
    return this.transaction(() => {
      this._assertExpectedProject(projectId, expectedOwnerEpoch, expectedRevision);
      const controller = this.getController(projectId, expectedOwnerEpoch);
      if (!controller) throw new Error('controller ownership has not been claimed');
      if (controller.status === 'stopped') throw new Error('controller is already stopped');
      const status = confirmedStopped ? 'stopped' : 'unknown';
      this._db.prepare(`
        UPDATE controller_epochs SET status = ?, updated_at = datetime('now')
        WHERE project_id = ? AND owner_epoch = ?
      `).run(status, projectId, expectedOwnerEpoch);
      this._touchProject(projectId);
      return this.getController(projectId, expectedOwnerEpoch);
    });
  }

  _touchProject(projectId) {
    const result = this._db.prepare(`
      UPDATE projects
      SET state_revision = state_revision + 1, updated_at = datetime('now')
      WHERE project_id = ?
    `).run(projectId);
    if (result.changes !== 1) throw new Error(`project not found: ${projectId}`);
  }

  createContractRevision({ projectId, revision, goalRevision, activate = false }) {
    requiredString(projectId, 'projectId');
    positiveInteger(revision, 'revision');
    positiveInteger(goalRevision, 'goalRevision');
    if (typeof activate !== 'boolean') throw new TypeError('activate must be a boolean');

    return this.transaction(() => {
      const project = this.getProject(projectId);
      if (!project) throw new Error(`project not found: ${projectId}`);
      if (project.goalRevision !== goalRevision) {
        throw new Error('contract revision goalRevision must match the current project goalRevision');
      }
      if (revision <= project.contractRevision) {
        throw new Error('contract revision must advance monotonically');
      }
      this._db.prepare(`
        INSERT INTO contract_revisions(project_id, contract_revision, goal_revision)
        VALUES (?, ?, ?)
      `).run(projectId, revision, goalRevision);
      if (activate) {
        this._db.prepare(`
          UPDATE projects
          SET contract_revision = ?, updated_at = datetime('now')
          WHERE project_id = ?
        `).run(revision, projectId);
      }
      this._touchProject(projectId);
      return { projectId, revision, goalRevision, active: activate };
    });
  }

  addRule({
    projectId,
    id,
    contractRevision,
    text,
    source,
    status,
    examples = [],
  }) {
    requiredString(projectId, 'projectId');
    requiredString(id, 'id');
    positiveInteger(contractRevision, 'contractRevision');
    requiredString(text, 'text');
    requiredString(source, 'source');
    enumValue(status, RULE_STATUSES, 'status');
    stringArray(examples, 'examples');

    return this.transaction(() => {
      this._db.prepare(`
        INSERT INTO product_rules(
          project_id, rule_id, contract_revision, text, source, status, examples_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(projectId, id, contractRevision, text, source, status, JSON.stringify(examples));
      this._touchProject(projectId);
      return { projectId, id, contractRevision, text, source, status, examples: [...examples] };
    });
  }

  listRules({ projectId, contractRevision }) {
    requiredString(projectId, 'projectId');
    positiveInteger(contractRevision, 'contractRevision');
    return this._db.prepare(`
      SELECT * FROM product_rules
      WHERE project_id = ? AND contract_revision = ?
      ORDER BY rule_id
    `).all(projectId, contractRevision).map((row) => ({
      projectId: row.project_id,
      id: row.rule_id,
      contractRevision: row.contract_revision,
      text: row.text,
      source: row.source,
      status: row.status,
      examples: parseJson(row.examples_json),
    }));
  }

  addContextItem({
    projectId,
    id,
    goalRevision,
    contractRevision,
    kind,
    text,
    status = 'active',
    source,
    sourceRef = null,
    attestation = 'none',
  }) {
    requiredString(projectId, 'projectId');
    requiredString(id, 'id');
    positiveInteger(goalRevision, 'goalRevision');
    positiveInteger(contractRevision, 'contractRevision');
    enumValue(kind, CONTEXT_KINDS, 'kind');
    requiredString(text, 'text');
    enumValue(status, CONTEXT_STATUSES, 'status');
    enumValue(source, new Set(['user', 'assistant', 'research']), 'source');
    sourceRef = nullableString(sourceRef, 'sourceRef');
    enumValue(attestation, CONTEXT_ATTESTATIONS, 'attestation');
    if (kind === 'decision' && (source !== 'user' || !['host_attested', 'assistant_attributed'].includes(attestation))) {
      throw new Error('decision items require user source with explicit attestation quality');
    }
    if (kind === 'assumption' && (source !== 'assistant' || attestation !== 'none')) {
      throw new Error('assumption items must remain assistant-sourced and unattested');
    }
    if (kind === 'research_fact' && (source !== 'research' || attestation !== 'research_cited' || sourceRef === null)) {
      throw new Error('research facts require a cited research source');
    }
    if (source === 'user' && attestation === 'none') {
      throw new Error('user-attributed context must disclose its attestation quality');
    }
    return this.transaction(() => {
      const contract = this._db.prepare(`
        SELECT goal_revision FROM contract_revisions
        WHERE project_id = ? AND contract_revision = ?
      `).get(projectId, contractRevision);
      if (!contract || contract.goal_revision !== goalRevision) {
        throw new Error('context item revision must match an existing product contract');
      }
      const latest = this._db.prepare(`
        SELECT MAX(item_revision) AS revision FROM product_context_item_history
        WHERE project_id = ? AND item_id = ?
      `).get(projectId, id).revision;
      const itemRevision = (latest ?? 0) + 1;
      this._db.prepare(`
        INSERT INTO product_context_item_history(
          project_id, item_id, item_revision, goal_revision, contract_revision,
          kind, text, status, source, source_ref, attestation
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        projectId, id, itemRevision, goalRevision, contractRevision,
        kind, text, status, source, sourceRef, attestation,
      );
      this._db.prepare(`
        INSERT INTO product_context_items(
          project_id, item_id, goal_revision, contract_revision,
          kind, text, status, source, source_ref, attestation, item_revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, item_id, goal_revision, contract_revision) DO UPDATE SET
          kind = excluded.kind,
          text = excluded.text,
          status = excluded.status,
          source = excluded.source,
          source_ref = excluded.source_ref,
          attestation = excluded.attestation,
          item_revision = excluded.item_revision
      `).run(
        projectId, id, goalRevision, contractRevision,
        kind, text, status, source, sourceRef, attestation, itemRevision,
      );
      this._touchProject(projectId);
      return {
        projectId, id, itemRevision, goalRevision, contractRevision,
        kind, text, status, source, sourceRef, attestation,
      };
    });
  }

  listContextItems({ projectId, goalRevision, contractRevision }) {
    requiredString(projectId, 'projectId');
    positiveInteger(goalRevision, 'goalRevision');
    positiveInteger(contractRevision, 'contractRevision');
    return this._db.prepare(`
      SELECT * FROM product_context_items
      WHERE project_id = ? AND goal_revision = ? AND contract_revision = ?
      ORDER BY kind, item_id
    `).all(projectId, goalRevision, contractRevision).map((row) => ({
      projectId: row.project_id,
      id: row.item_id,
      itemRevision: row.item_revision,
      goalRevision: row.goal_revision,
      contractRevision: row.contract_revision,
      kind: row.kind,
      text: row.text,
      status: row.status,
      source: row.source,
      sourceRef: row.source_ref,
      attestation: row.attestation,
    }));
  }

  listContextItemHistory({ projectId, id }) {
    requiredString(projectId, 'projectId');
    requiredString(id, 'id');
    return this._db.prepare(`
      SELECT * FROM product_context_item_history
      WHERE project_id = ? AND item_id = ? ORDER BY item_revision
    `).all(projectId, id).map((row) => ({
      projectId: row.project_id,
      id: row.item_id,
      itemRevision: row.item_revision,
      goalRevision: row.goal_revision,
      contractRevision: row.contract_revision,
      kind: row.kind,
      text: row.text,
      status: row.status,
      source: row.source,
      sourceRef: row.source_ref,
      attestation: row.attestation,
    }));
  }

  addProductBrief({
    projectId,
    briefRevision,
    goalRevision,
    contractRevision,
    summary,
    nextStep = null,
  }) {
    requiredString(projectId, 'projectId');
    positiveInteger(briefRevision, 'briefRevision');
    positiveInteger(goalRevision, 'goalRevision');
    positiveInteger(contractRevision, 'contractRevision');
    requiredString(summary, 'summary');
    nextStep = nullableString(nextStep, 'nextStep');
    return this.transaction(() => {
      const contract = this._db.prepare(`
        SELECT goal_revision FROM contract_revisions
        WHERE project_id = ? AND contract_revision = ?
      `).get(projectId, contractRevision);
      if (!contract || contract.goal_revision !== goalRevision) {
        throw new Error('product brief revision must match an existing contract');
      }
      const latest = this._db.prepare(`
        SELECT MAX(brief_revision) AS revision FROM product_brief_revisions WHERE project_id = ?
      `).get(projectId).revision;
      if (latest !== null && briefRevision <= latest) {
        throw new Error('brief revision must advance monotonically');
      }
      this._db.prepare(`
        INSERT INTO product_brief_revisions(
          project_id, brief_revision, goal_revision, contract_revision, summary, next_step
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(projectId, briefRevision, goalRevision, contractRevision, summary, nextStep);
      this._touchProject(projectId);
      return { projectId, briefRevision, goalRevision, contractRevision, summary, nextStep };
    });
  }

  getLatestProductBrief({ projectId, goalRevision = null, contractRevision = null }) {
    requiredString(projectId, 'projectId');
    if (goalRevision !== null) positiveInteger(goalRevision, 'goalRevision');
    if (contractRevision !== null) positiveInteger(contractRevision, 'contractRevision');
    const clauses = ['project_id = ?'];
    const values = [projectId];
    if (goalRevision !== null) {
      clauses.push('goal_revision = ?');
      values.push(goalRevision);
    }
    if (contractRevision !== null) {
      clauses.push('contract_revision = ?');
      values.push(contractRevision);
    }
    const row = this._db.prepare(`
      SELECT * FROM product_brief_revisions
      WHERE ${clauses.join(' AND ')} ORDER BY brief_revision DESC LIMIT 1
    `).get(...values);
    if (!row) return null;
    return {
      projectId: row.project_id,
      briefRevision: row.brief_revision,
      goalRevision: row.goal_revision,
      contractRevision: row.contract_revision,
      summary: row.summary,
      nextStep: row.next_step,
    };
  }

  reviseProjectGoal({
    projectId, expectedRevision, goal, decision, briefSummary, nextStep = null, authority,
  }) {
    requiredString(projectId, 'projectId');
    positiveInteger(expectedRevision, 'expectedRevision');
    requiredString(goal, 'goal');
    requiredString(decision, 'decision');
    requiredString(briefSummary, 'briefSummary');
    nextStep = nullableString(nextStep, 'nextStep');
    if (!authority || !STATE_HOST_AUTHORITIES.has(authority)) {
      throw new Error('goal direction changes require the Host-owned state authority');
    }
    return this.transaction(() => {
      const project = this.getProject(projectId);
      if (!project) throw new Error(`project not found: ${projectId}`);
      if (project.stateRevision !== expectedRevision) {
        throw new Error(`stale expectedRevision: expected ${expectedRevision}, current ${project.stateRevision}`);
      }
      if (project.goal === goal) throw new Error('new goal must differ from the current goal');
      const goalRevision = project.goalRevision + 1;
      const contractRevision = project.contractRevision + 1;
      this._db.prepare(`
        INSERT INTO contract_revisions(project_id, contract_revision, goal_revision)
        VALUES (?, ?, ?)
      `).run(projectId, contractRevision, goalRevision);
      this._db.prepare(`
        UPDATE tasks SET status = 'superseded', updated_at = datetime('now')
        WHERE project_id = ? AND status NOT IN ('accepted', 'cancelled', 'superseded')
      `).run(projectId);
      this._db.prepare(`
        UPDATE run_attempts SET status = 'superseded',
          unconfirmed_active = CASE
            WHEN status IN ('prepared', 'running', 'cancel_requested', 'unknown_outcome')
              OR unconfirmed_active = 1 THEN 1 ELSE 0 END,
          updated_at = datetime('now')
        WHERE task_id IN (
          SELECT task_id FROM tasks WHERE project_id = ? AND status = 'superseded'
        )
          AND status NOT IN ('cancelled', 'superseded')
      `).run(projectId);
      this._db.prepare(`
        UPDATE projects SET goal = ?, goal_revision = ?, contract_revision = ?
        WHERE project_id = ?
      `).run(goal, goalRevision, contractRevision, projectId);
      this.addContextItem({
        projectId,
        id: `direction-${goalRevision}`,
        goalRevision,
        contractRevision,
        kind: 'decision',
        text: decision,
        status: 'active',
        source: 'user',
        sourceRef: 'current-user-request-unattested',
        attestation: 'assistant_attributed',
      });
      const latestBrief = this._db.prepare(`
        SELECT MAX(brief_revision) AS revision FROM product_brief_revisions WHERE project_id = ?
      `).get(projectId).revision;
      this._db.prepare(`
        INSERT INTO product_brief_revisions(
          project_id, brief_revision, goal_revision, contract_revision, summary, next_step
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(projectId, (latestBrief ?? 0) + 1, goalRevision, contractRevision, briefSummary, nextStep);
      this._touchProject(projectId);
      return this.readSnapshot(projectId);
    });
  }

  createTask({
    id,
    projectId,
    goalRevision,
    contractRevision,
    dependencies = [],
    acceptance = [],
    status = 'pending',
    allowedPaths = [],
    prohibitedActions = [],
    input = null,
    workspacePath = null,
    executionMode = null,
    small = false,
    safe = false,
    readOnly = false,
    forceWorker = false,
    repairOfTaskId = null,
    repairOrdinal = null,
    parentFailureEvidenceId = null,
    boundedExperiment = false,
  }) {
    requiredString(id, 'id');
    requiredString(projectId, 'projectId');
    positiveInteger(goalRevision, 'goalRevision');
    positiveInteger(contractRevision, 'contractRevision');
    stringArray(dependencies, 'dependencies');
    stringArray(acceptance, 'acceptance');
    stringArray(allowedPaths, 'allowedPaths');
    stringArray(prohibitedActions, 'prohibitedActions');
    jsonObjectOrNull(input, 'input');
    workspacePath = nullableString(workspacePath, 'workspacePath');
    executionMode = nullableString(executionMode, 'executionMode');
    small = booleanValue(small, 'small');
    safe = booleanValue(safe, 'safe');
    readOnly = booleanValue(readOnly, 'readOnly');
    forceWorker = booleanValue(forceWorker, 'forceWorker');
    repairOfTaskId = nullableString(repairOfTaskId, 'repairOfTaskId');
    if (repairOrdinal !== null) positiveInteger(repairOrdinal, 'repairOrdinal');
    parentFailureEvidenceId = nullableString(parentFailureEvidenceId, 'parentFailureEvidenceId');
    boundedExperiment = booleanValue(boundedExperiment, 'boundedExperiment');
    enumValue(status, TASK_STATUSES, 'status');
    if (status === 'accepted') {
      throw new Error('tasks must be accepted through acceptTask');
    }
    if (new Set(dependencies).size !== dependencies.length) {
      throw new Error('dependencies must not contain duplicates');
    }

    return this.transaction(() => {
      const contract = this._db.prepare(`
        SELECT goal_revision FROM contract_revisions
        WHERE project_id = ? AND contract_revision = ?
      `).get(projectId, contractRevision);
      if (!contract) {
        throw new Error(`contract revision not found: ${projectId}@${contractRevision}`);
      }
      if (contract.goal_revision !== goalRevision) {
        throw new Error('task goalRevision does not match its contract revision');
      }

      this._db.prepare(`
        INSERT INTO tasks(
          task_id, project_id, goal_revision, contract_revision, acceptance_json, status,
          allowed_paths_json, prohibited_actions_json, input_json, workspace_path,
          execution_mode, small, safe, read_only, force_worker, repair_of_task_id,
          repair_ordinal, parent_failure_evidence_id, bounded_experiment
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, projectId, goalRevision, contractRevision, JSON.stringify(acceptance), status,
        JSON.stringify(allowedPaths), JSON.stringify(prohibitedActions),
        input === null ? null : JSON.stringify(input), workspacePath, executionMode,
        Number(small), Number(safe), Number(readOnly), Number(forceWorker), repairOfTaskId,
        repairOrdinal, parentFailureEvidenceId, Number(boundedExperiment),
      );

      const insertDependency = this._db.prepare(`
        INSERT INTO task_dependencies(task_id, depends_on_task_id) VALUES (?, ?)
      `);
      for (const dependency of dependencies) {
        requiredString(dependency, 'dependency');
        const row = this._db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(dependency);
        if (!row || row.project_id !== projectId) {
          throw new Error(`dependency must belong to the same project: ${dependency}`);
        }
        if (row.goal_revision !== goalRevision || row.contract_revision !== contractRevision) {
          throw new Error(`dependency revision does not match task revision: ${dependency}`);
        }
        insertDependency.run(id, dependency);
      }
      this._touchProject(projectId);
      return this.getTask(id);
    });
  }

  getTask(id) {
    requiredString(id, 'id');
    const row = this._db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(id);
    if (!row) return null;
    const dependencies = this._db.prepare(`
      SELECT depends_on_task_id FROM task_dependencies
      WHERE task_id = ? ORDER BY depends_on_task_id
    `).all(id).map((item) => item.depends_on_task_id);
    return taskFromRow(row, dependencies);
  }

  setTaskStatus(id, status) {
    requiredString(id, 'id');
    enumValue(status, TASK_STATUSES, 'status');
    if (status === 'accepted') {
      throw new Error('tasks must be accepted through acceptTask');
    }
    return this.transaction(() => {
      const task = this.getTask(id);
      if (!task) throw new Error(`task not found: ${id}`);
      this._db.prepare(`
        UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE task_id = ?
      `).run(status, id);
      this._touchProject(task.projectId);
      return this.getTask(id);
    });
  }

  createAttempt({
    id,
    taskId,
    goalRevision,
    contractRevision,
    provider,
    nativeSessionId = null,
    nativeJobId = null,
    workspacePath,
    inputDigest,
    status = 'prepared',
    writer = true,
    workPackage = null,
    executionRef = null,
    candidate = null,
    unconfirmedActive = false,
    failureReason = null,
    errorCode = null,
  }) {
    requiredString(id, 'id');
    requiredString(taskId, 'taskId');
    positiveInteger(goalRevision, 'goalRevision');
    positiveInteger(contractRevision, 'contractRevision');
    requiredString(provider, 'provider');
    nativeSessionId = nullableString(nativeSessionId, 'nativeSessionId');
    nativeJobId = nullableString(nativeJobId, 'nativeJobId');
    requiredString(workspacePath, 'workspacePath');
    requiredString(inputDigest, 'inputDigest');
    enumValue(status, ATTEMPT_STATUSES, 'status');
    writer = booleanValue(writer, 'writer', true);
    jsonObjectOrNull(workPackage, 'workPackage');
    jsonObjectOrNull(executionRef, 'executionRef');
    jsonObjectOrNull(candidate, 'candidate');
    unconfirmedActive = booleanValue(unconfirmedActive, 'unconfirmedActive');
    failureReason = nullableString(failureReason, 'failureReason');
    errorCode = nullableString(errorCode, 'errorCode');

    const task = this.getTask(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    if (task.goalRevision !== goalRevision || task.contractRevision !== contractRevision) {
      throw new Error('attempt revision does not match its task');
    }
    return this.transaction(() => {
      this._db.prepare(`
        INSERT INTO run_attempts(
          attempt_id, task_id, goal_revision, contract_revision, provider,
          native_session_id, native_job_id, workspace_path, input_digest, status,
          writer, work_package_json, execution_ref_json, candidate_json,
          unconfirmed_active, failure_reason, error_code
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, taskId, goalRevision, contractRevision, provider,
        nativeSessionId, nativeJobId, workspacePath, inputDigest, status,
        Number(writer), workPackage === null ? null : JSON.stringify(workPackage),
        executionRef === null ? null : JSON.stringify(executionRef),
        candidate === null ? null : JSON.stringify(candidate), Number(unconfirmedActive),
        failureReason, errorCode,
      );
      this._touchProject(task.projectId);
      return this.getAttempt(id);
    });
  }

  getAttempt(id) {
    requiredString(id, 'id');
    return attemptFromRow(
      this._db.prepare('SELECT * FROM run_attempts WHERE attempt_id = ?').get(id),
    );
  }

  listAttempts(taskId) {
    requiredString(taskId, 'taskId');
    return this._db.prepare(`
      SELECT * FROM run_attempts WHERE task_id = ? ORDER BY rowid
    `).all(taskId).map(attemptFromRow);
  }

  listRecoverableAttempts(projectId) {
    requiredString(projectId, 'projectId');
    return this._db.prepare(`
      SELECT a.* FROM run_attempts a
      JOIN tasks t ON t.task_id = a.task_id
      WHERE t.project_id = ?
        AND (a.status IN ('prepared', 'running', 'cancel_requested', 'unknown_outcome')
          OR a.unconfirmed_active = 1)
      ORDER BY a.rowid
    `).all(projectId).map(attemptFromRow);
  }

  _attemptInProject(projectId, attemptId) {
    requiredString(attemptId, 'attemptId');
    const row = this._db.prepare(`
      SELECT a.* FROM run_attempts a
      JOIN tasks t ON t.task_id = a.task_id
      WHERE t.project_id = ? AND a.attempt_id = ?
    `).get(projectId, attemptId);
    if (!row) throw new Error(`attempt not found in project: ${attemptId}`);
    return attemptFromRow(row);
  }

  createOwnedAttempt({ projectId, expectedOwnerEpoch, expectedRevision, attempt }) {
    requiredString(projectId, 'projectId');
    if (!attempt || typeof attempt !== 'object') throw new TypeError('attempt must be an object');
    return this.transaction(() => {
      this._assertExpectedProject(projectId, expectedOwnerEpoch, expectedRevision);
      this._assertController(projectId, expectedOwnerEpoch, { activeOnly: true });
      if (attempt.writer !== false) {
        const activeWriter = this._db.prepare(`
          SELECT a.attempt_id, a.status FROM run_attempts a
          JOIN tasks t ON t.task_id = a.task_id
          WHERE t.project_id = ? AND a.writer = 1
            AND (a.status IN ('prepared', 'running', 'cancel_requested', 'unknown_outcome')
              OR a.unconfirmed_active = 1)
          LIMIT 1
        `).get(projectId);
        if (activeWriter) {
          throw new Error(
            `new writer refused until attempt is confirmed stopped: ${activeWriter.attempt_id}`,
          );
        }
      }
      const task = this.getTask(attempt.taskId);
      if (!task || task.projectId !== projectId) {
        throw new Error(`task not found in project: ${attempt.taskId}`);
      }
      const project = this.getProject(projectId);
      if (
        attempt.goalRevision !== project.goalRevision
        || attempt.contractRevision !== project.contractRevision
      ) {
        throw new Error('attempt revision does not match current project');
      }
      return this.createAttempt(attempt);
    });
  }

  applyOwned({ projectId, expectedOwnerEpoch, operation }) {
    requiredString(projectId, 'projectId');
    if (!operation || typeof operation !== 'object') {
      throw new TypeError('operation must be an object');
    }
    if (operation.projectId !== projectId) throw new Error('operation project does not match');
    return this.transaction(() => {
      this._assertExpectedProject(projectId, expectedOwnerEpoch, operation.expectedRevision);
      this._assertController(projectId, expectedOwnerEpoch, { activeOnly: true });
      return this.apply(operation);
    });
  }

  requestAttemptCancel({ projectId, attemptId, expectedOwnerEpoch, expectedRevision }) {
    requiredString(projectId, 'projectId');
    return this.transaction(() => {
      const project = this._assertExpectedProject(
        projectId, expectedOwnerEpoch, expectedRevision,
      );
      this._assertController(projectId, expectedOwnerEpoch);
      const attempt = this._attemptInProject(projectId, attemptId);
      if (!RECOVERABLE_ATTEMPT_STATUSES.has(attempt.status) && !attempt.unconfirmedActive) {
        throw new Error(`attempt is not active: ${attempt.status}`);
      }
      this._db.prepare(`
        UPDATE run_attempts SET status = 'cancel_requested', unconfirmed_active = 1,
          updated_at = datetime('now') WHERE attempt_id = ?
      `).run(attempt.id);
      this._touchProject(projectId);
      return this.getAttempt(attempt.id);
    });
  }

  markAttemptUnknown({
    projectId,
    attemptId,
    expectedOwnerEpoch,
    expectedRevision,
    reason = null,
  }) {
    requiredString(projectId, 'projectId');
    reason = nullableString(reason, 'reason');
    return this.transaction(() => {
      const project = this._assertExpectedProject(
        projectId, expectedOwnerEpoch, expectedRevision,
      );
      this._assertController(projectId, expectedOwnerEpoch);
      const attempt = this._attemptInProject(projectId, attemptId);
      if (!RECOVERABLE_ATTEMPT_STATUSES.has(attempt.status) && !attempt.unconfirmedActive) {
        throw new Error(`attempt is not active: ${attempt.status}`);
      }
      const stale = attempt.goalRevision !== project.goalRevision
        || attempt.contractRevision !== project.contractRevision;
      this._db.prepare(`
        UPDATE run_attempts SET status = ?, unconfirmed_active = 1,
          failure_reason = ?, updated_at = datetime('now') WHERE attempt_id = ?
      `).run(stale ? 'superseded' : 'unknown_outcome', reason, attempt.id);
      if (!stale) {
        this._db.prepare(`
          UPDATE tasks SET status = 'unknown_outcome', updated_at = datetime('now')
          WHERE task_id = ?
        `).run(attempt.taskId);
      }
      this._touchProject(projectId);
      return this.getAttempt(attempt.id);
    });
  }

  confirmAttemptStopped({ projectId, attemptId, expectedOwnerEpoch, expectedRevision }) {
    requiredString(projectId, 'projectId');
    return this.transaction(() => {
      const project = this._assertExpectedProject(
        projectId, expectedOwnerEpoch, expectedRevision,
      );
      this._assertController(projectId, expectedOwnerEpoch);
      const attempt = this._attemptInProject(projectId, attemptId);
      if (!RECOVERABLE_ATTEMPT_STATUSES.has(attempt.status) && !attempt.unconfirmedActive) {
        throw new Error(`attempt is not active: ${attempt.status}`);
      }
      const stale = attempt.goalRevision !== project.goalRevision
        || attempt.contractRevision !== project.contractRevision;
      this._db.prepare(`
        UPDATE run_attempts SET status = ?, unconfirmed_active = 0,
          updated_at = datetime('now') WHERE attempt_id = ?
      `).run(stale ? 'superseded' : 'stopped', attempt.id);
      if (!stale) {
        this._db.prepare(`
          UPDATE tasks SET status = 'interrupted', updated_at = datetime('now')
          WHERE task_id = ?
        `).run(attempt.taskId);
      }
      this._touchProject(projectId);
      return this.getAttempt(attempt.id);
    });
  }

  getCallbackReceipt(callbackId, attemptId) {
    requiredString(callbackId, 'callbackId');
    requiredString(attemptId, 'attemptId');
    return callbackReceiptFromRow(this._db.prepare(`
      SELECT * FROM callback_receipts WHERE callback_id = ? AND attempt_id = ?
    `).get(callbackId, attemptId));
  }

  listCallbackReceipts(projectId) {
    requiredString(projectId, 'projectId');
    return this._db.prepare(`
      SELECT * FROM callback_receipts WHERE project_id = ? ORDER BY rowid
    `).all(projectId).map(callbackReceiptFromRow);
  }

  listDirectorEvents(projectId) {
    requiredString(projectId, 'projectId');
    return this._db.prepare(`
      SELECT * FROM director_events WHERE project_id = ? ORDER BY rowid
    `).all(projectId).map(directorEventFromRow);
  }

  recordRecoveryCallback({
    projectId,
    callbackId,
    attemptId,
    payloadDigest,
    outcome,
    goalRevision,
    contractRevision,
    expectedOwnerEpoch,
    expectedRevision,
  }) {
    requiredString(projectId, 'projectId');
    requiredString(callbackId, 'callbackId');
    requiredString(attemptId, 'attemptId');
    requiredString(payloadDigest, 'payloadDigest');
    enumValue(outcome, CALLBACK_OUTCOMES, 'outcome');
    positiveInteger(goalRevision, 'goalRevision');
    positiveInteger(contractRevision, 'contractRevision');

    return this.transaction(() => {
      const receipt = this.getCallbackReceipt(callbackId, attemptId);
      if (receipt) {
        if (
          receipt.payloadDigest !== payloadDigest
          || receipt.projectId !== projectId
          || receipt.goalRevision !== goalRevision
          || receipt.contractRevision !== contractRevision
          || receipt.outcome !== outcome
        ) {
          throw new Error('callback conflicts with the stored receipt');
        }
        return { duplicate: true, receipt, event: this._directorEventForCallback(callbackId, attemptId) };
      }
      const project = this._assertExpectedProject(
        projectId, expectedOwnerEpoch, expectedRevision,
      );
      this._assertController(projectId, expectedOwnerEpoch);
      const attempt = this._attemptInProject(projectId, attemptId);
      if (
        attempt.goalRevision !== goalRevision
        || attempt.contractRevision !== contractRevision
      ) {
        throw new Error('callback revision does not match its attempt');
      }
      const stale = goalRevision !== project.goalRevision
        || contractRevision !== project.contractRevision;
      const disposition = stale ? 'stale' : 'applied';
      this._db.prepare(`
        INSERT INTO callback_receipts(
          callback_id, attempt_id, project_id, owner_epoch, goal_revision,
          contract_revision, payload_digest, outcome, disposition
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        callbackId, attemptId, projectId, expectedOwnerEpoch, goalRevision,
        contractRevision, payloadDigest, outcome, disposition,
      );
      const eventId = `${callbackId.length}:${callbackId}${attemptId}`;
      this._db.prepare(`
        INSERT INTO director_events(
          event_id, project_id, attempt_id, callback_id, owner_epoch,
          goal_revision, contract_revision, type, outcome, stale
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'attempt_terminal', ?, ?)
      `).run(
        eventId, projectId, attemptId, callbackId, expectedOwnerEpoch,
        goalRevision, contractRevision, outcome, Number(stale),
      );

      if (stale) {
        this._db.prepare(`
          UPDATE run_attempts SET status = 'superseded', unconfirmed_active = 0,
            updated_at = datetime('now') WHERE attempt_id = ?
        `).run(attemptId);
      } else {
        const taskStatus = outcome === 'candidate'
          ? 'candidate'
          : outcome === 'blocked'
            ? 'blocked'
            : ['stopped', 'cancelled', 'interrupted'].includes(outcome)
              ? 'interrupted'
              : 'needs_revision';
        this._db.prepare(`
          UPDATE run_attempts SET status = ?, unconfirmed_active = 0,
            updated_at = datetime('now') WHERE attempt_id = ?
        `).run(outcome, attemptId);
        this._db.prepare(`
          UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE task_id = ?
        `).run(taskStatus, attempt.taskId);
      }
      this._touchProject(projectId);
      const stored = this.getCallbackReceipt(callbackId, attemptId);
      return { duplicate: false, receipt: stored, event: this._directorEventForCallback(callbackId, attemptId) };
    });
  }

  _directorEventForCallback(callbackId, attemptId) {
    return directorEventFromRow(this._db.prepare(`
      SELECT * FROM director_events WHERE callback_id = ? AND attempt_id = ?
    `).get(callbackId, attemptId));
  }

  changeProjectDirection({
    projectId,
    goal,
    goalRevision,
    contractRevision,
    expectedOwnerEpoch,
    expectedRevision,
  }) {
    requiredString(projectId, 'projectId');
    requiredString(goal, 'goal');
    positiveInteger(goalRevision, 'goalRevision');
    positiveInteger(contractRevision, 'contractRevision');
    return this.transaction(() => {
      const project = this._assertExpectedProject(
        projectId, expectedOwnerEpoch, expectedRevision,
      );
      this._assertController(projectId, expectedOwnerEpoch, { activeOnly: true });
      if (goalRevision < project.goalRevision || contractRevision <= project.contractRevision) {
        throw new Error('goal/contract revisions must advance monotonically');
      }
      if (goal !== project.goal && goalRevision <= project.goalRevision) {
        throw new Error('a changed goal must advance goalRevision');
      }
      this._db.prepare(`
        INSERT INTO contract_revisions(project_id, contract_revision, goal_revision)
        VALUES (?, ?, ?)
      `).run(projectId, contractRevision, goalRevision);
      this._db.prepare(`
        UPDATE tasks SET status = 'superseded', updated_at = datetime('now')
        WHERE project_id = ?
      `).run(projectId);
      this._db.prepare(`
        UPDATE run_attempts SET status = 'superseded',
          unconfirmed_active = CASE
            WHEN status IN ('prepared', 'running', 'cancel_requested', 'unknown_outcome')
              OR unconfirmed_active = 1 THEN 1 ELSE 0 END,
          updated_at = datetime('now')
        WHERE task_id IN (SELECT task_id FROM tasks WHERE project_id = ?)
      `).run(projectId);
      this._db.prepare(`
        UPDATE projects SET goal = ?, goal_revision = ?, contract_revision = ?
        WHERE project_id = ?
      `).run(goal, goalRevision, contractRevision, projectId);
      this._touchProject(projectId);
      return this.readSnapshot(projectId);
    });
  }

  setAttemptStatus(id, status) {
    requiredString(id, 'id');
    enumValue(status, ATTEMPT_STATUSES, 'status');
    const attempt = this.getAttempt(id);
    if (!attempt) throw new Error(`attempt not found: ${id}`);
    if (attempt.status === status) return attempt;
    const allowed = ATTEMPT_TRANSITIONS.get(attempt.status);
    if (!allowed?.has(status)) {
      throw new Error(`attempt status is terminal or transition is invalid: ${attempt.status} -> ${status}`);
    }
    return this.transaction(() => {
      const result = this._db.prepare(`
        UPDATE run_attempts SET status = ?, updated_at = datetime('now') WHERE attempt_id = ?
      `).run(status, id);
      if (result.changes !== 1) throw new Error(`attempt update failed: ${id}`);
      const task = this.getTask(attempt.taskId);
      this._touchProject(task.projectId);
      return this.getAttempt(id);
    });
  }

  addEvidence({
    id,
    taskId,
    attemptId,
    goalRevision,
    contractRevision,
    kind,
    digest,
    location,
    status,
    exitCode = null,
    details = null,
  }) {
    requiredString(id, 'id');
    requiredString(taskId, 'taskId');
    requiredString(attemptId, 'attemptId');
    positiveInteger(goalRevision, 'goalRevision');
    positiveInteger(contractRevision, 'contractRevision');
    requiredString(kind, 'kind');
    requiredString(digest, 'digest');
    requiredString(location, 'location');
    enumValue(status, EVIDENCE_STATUSES, 'status');
    if (exitCode !== null && !Number.isSafeInteger(exitCode)) {
      throw new TypeError('exitCode must be an integer or null');
    }
    jsonObjectOrNull(details, 'details');

    const attempt = this.getAttempt(attemptId);
    if (!attempt) throw new Error(`attempt not found: ${attemptId}`);
    if (
      attempt.taskId !== taskId ||
      attempt.goalRevision !== goalRevision ||
      attempt.contractRevision !== contractRevision
    ) {
      throw new Error('evidence binding does not match its attempt');
    }

    return this.transaction(() => {
      this._db.prepare(`
        INSERT INTO evidence(
          evidence_id, task_id, attempt_id, goal_revision, contract_revision,
          kind, digest, location, status, exit_code, details_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, taskId, attemptId, goalRevision, contractRevision,
        kind, digest, location, status, exitCode,
        details === null ? null : JSON.stringify(details),
      );
      const task = this.getTask(taskId);
      this._touchProject(task.projectId);
      return this.getEvidence(id);
    });
  }

  getEvidence(id) {
    requiredString(id, 'id');
    return evidenceFromRow(
      this._db.prepare('SELECT * FROM evidence WHERE evidence_id = ?').get(id),
    );
  }

  listEvidence(attemptId) {
    requiredString(attemptId, 'attemptId');
    return this._db.prepare(`
      SELECT * FROM evidence WHERE attempt_id = ? ORDER BY rowid
    `).all(attemptId).map(evidenceFromRow);
  }

  verifyAttempt({ attemptId, evidenceIds }) {
    requiredString(attemptId, 'attemptId');
    stringArray(evidenceIds, 'evidenceIds');
    if (evidenceIds.length === 0) throw new Error('verification requires evidence');
    if (new Set(evidenceIds).size !== evidenceIds.length) {
      throw new Error('evidenceIds must not contain duplicates');
    }

    return this.transaction(() => {
      const attempt = this.getAttempt(attemptId);
      if (!attempt) throw new Error(`attempt not found: ${attemptId}`);
      if (attempt.status !== 'candidate') {
        throw new Error('only a candidate attempt can be verified');
      }

      const link = this._db.prepare(`
        INSERT INTO attempt_verification_evidence(attempt_id, evidence_id) VALUES (?, ?)
      `);
      for (const evidenceId of evidenceIds) {
        const evidence = this.getEvidence(evidenceId);
        if (!evidence || evidence.attemptId !== attemptId) {
          throw new Error(`evidence is not bound to attempt ${attemptId}: ${evidenceId}`);
        }
        if (
          evidence.taskId !== attempt.taskId ||
          evidence.goalRevision !== attempt.goalRevision ||
          evidence.contractRevision !== attempt.contractRevision
        ) {
          throw new Error(`evidence revision does not match attempt: ${evidenceId}`);
        }
        if (evidence.status !== 'passed') {
          throw new Error(`verification evidence did not pass: ${evidenceId}`);
        }
        link.run(attemptId, evidenceId);
      }
      this._db.prepare(`
        UPDATE run_attempts SET verified = 1, updated_at = datetime('now')
        WHERE attempt_id = ?
      `).run(attemptId);
      const task = this.getTask(attempt.taskId);
      this._touchProject(task.projectId);
      return this.getAttempt(attemptId);
    });
  }

  acceptTask({ taskId, attemptId }) {
    requiredString(taskId, 'taskId');
    requiredString(attemptId, 'attemptId');

    return this.transaction(() => {
      const task = this.getTask(taskId);
      if (!task) throw new Error(`task not found: ${taskId}`);
      if (!['candidate', 'verifying'].includes(task.status)) {
        throw new Error('only a candidate or verifying task can be accepted');
      }

      const project = this.getProject(task.projectId);
      if (
        !project ||
        project.goalRevision !== task.goalRevision ||
        project.contractRevision !== task.contractRevision
      ) {
        throw new Error('task revision is stale and cannot be accepted for the current product');
      }

      const attempt = this.getAttempt(attemptId);
      if (!attempt || attempt.taskId !== taskId) {
        throw new Error('accepted attempt must be bound to the task');
      }
      if (
        attempt.goalRevision !== task.goalRevision ||
        attempt.contractRevision !== task.contractRevision
      ) {
        throw new Error('accepted attempt revision does not match the task');
      }
      if (attempt.status !== 'candidate' || !attempt.verified) {
        throw new Error('accepted attempt must be a verified candidate');
      }

      const verificationEvidence = this._db.prepare(`
        SELECT COUNT(*) AS count
        FROM attempt_verification_evidence ave
        JOIN evidence e ON e.evidence_id = ave.evidence_id
        WHERE ave.attempt_id = ?
          AND e.task_id = ?
          AND e.goal_revision = ?
          AND e.contract_revision = ?
          AND e.status = 'passed'
      `).get(attemptId, taskId, task.goalRevision, task.contractRevision);
      if (verificationEvidence.count < 1) {
        throw new Error('accepted attempt requires bound passing verification evidence');
      }

      for (const dependencyId of task.dependencies) {
        const dependency = this.getTask(dependencyId);
        if (
          !dependency || dependency.status !== 'accepted' ||
          dependency.goalRevision !== task.goalRevision ||
          dependency.contractRevision !== task.contractRevision
        ) {
          throw new Error(`task dependency is not accepted for this revision: ${dependencyId}`);
        }
      }

      this._db.prepare(`
        UPDATE tasks
        SET status = 'accepted', accepted_attempt_id = ?, updated_at = datetime('now')
        WHERE task_id = ?
      `).run(attemptId, taskId);
      this._touchProject(task.projectId);
      return this.getTask(taskId);
    });
  }

  readSnapshot(projectId) {
    requiredString(projectId, 'projectId');
    const projectRow = this._db.prepare('SELECT * FROM projects WHERE project_id = ?').get(projectId);
    if (!projectRow) throw new Error(`project not found: ${projectId}`);
    const tasks = this._db.prepare(`
      SELECT * FROM tasks WHERE project_id = ? ORDER BY task_id
    `).all(projectId).map((row) => {
      const dependencies = this._db.prepare(`
        SELECT depends_on_task_id FROM task_dependencies
        WHERE task_id = ? ORDER BY depends_on_task_id
      `).all(row.task_id).map((item) => item.depends_on_task_id);
      const task = taskFromRow(row, dependencies);
      return {
        ...task,
        applicability: row.goal_revision === projectRow.goal_revision
          && row.contract_revision === projectRow.contract_revision ? 'current' : 'historical',
      };
    });
    const attempts = this._db.prepare(`
      SELECT a.* FROM run_attempts a
      JOIN tasks t ON t.task_id = a.task_id
      WHERE t.project_id = ? ORDER BY a.rowid
    `).all(projectId).map((row) => ({
      ...attemptFromRow(row),
      applicability: row.goal_revision === projectRow.goal_revision
        && row.contract_revision === projectRow.contract_revision ? 'current' : 'historical',
    }));
    const evidence = this._db.prepare(`
      SELECT e.* FROM evidence e
      JOIN tasks t ON t.task_id = e.task_id
      WHERE t.project_id = ? ORDER BY e.rowid
    `).all(projectId).map((row) => ({
      ...evidenceFromRow(row),
      applicability: row.goal_revision === projectRow.goal_revision
        && row.contract_revision === projectRow.contract_revision ? 'current' : 'historical',
    }));
    const authorizations = this._db.prepare(`
      SELECT authorization_json FROM director_authorizations
      WHERE project_id = ? ORDER BY rowid
    `).all(projectId).map((row) => parseJson(row.authorization_json));
    const controllers = this.listControllerEpochs(projectId);
    const callbackReceipts = this.listCallbackReceipts(projectId);
    const directorEvents = this.listDirectorEvents(projectId);
    const contextItems = this.listContextItems({
      projectId,
      goalRevision: projectRow.goal_revision,
      contractRevision: projectRow.contract_revision,
    });
    return {
      revision: projectRow.state_revision,
      project: projectFromRow(projectRow),
      tasks,
      attempts,
      evidence,
      contextItems,
      brief: this.getLatestProductBrief({
        projectId,
        goalRevision: projectRow.goal_revision,
        contractRevision: projectRow.contract_revision,
      }),
      authorizations,
      recovery: {
        controller: controllers.at(-1) ?? null,
        controllerEpochs: controllers,
        callbackReceipts,
        directorEvents,
      },
      usage: {
        engineeringAttemptsThisBatch: projectRow.engineering_attempts_batch,
        engineeringAttemptsThisRun: projectRow.engineering_attempts_run,
      },
      control: {
        noProgressCycles: projectRow.no_progress_cycles,
        minimalExperimentScheduled: projectRow.minimal_experiment_scheduled === 1,
      },
    };
  }

  _directorTask(projectId, taskId) {
    requiredString(taskId, 'taskId');
    const task = this.getTask(taskId);
    if (!task || task.projectId !== projectId) throw new Error(`task not found in project: ${taskId}`);
    return task;
  }

  _directorAttempt(projectId, attemptId) {
    requiredString(attemptId, 'attemptId');
    const row = this._db.prepare(`
      SELECT a.* FROM run_attempts a
      JOIN tasks t ON t.task_id = a.task_id
      WHERE a.attempt_id = ? AND t.project_id = ?
    `).get(attemptId, projectId);
    if (!row) throw new Error(`attempt not found in project: ${attemptId}`);
    return attemptFromRow(row);
  }

  _assertCurrent(record, project, name) {
    if (
      record.goalRevision !== project.goalRevision
      || record.contractRevision !== project.contractRevision
    ) {
      throw new Error(`${name} revision is stale`);
    }
  }

  _assertDependenciesAccepted(task) {
    for (const dependencyId of task.dependencies) {
      const dependency = this.getTask(dependencyId);
      if (
        !dependency
        || dependency.projectId !== task.projectId
        || dependency.status !== 'accepted'
        || dependency.goalRevision !== task.goalRevision
        || dependency.contractRevision !== task.contractRevision
      ) {
        throw new Error(`task dependency is not accepted for this revision: ${dependencyId}`);
      }
    }
  }

  _insertDirectorTask(project, candidate) {
    if (!candidate || typeof candidate !== 'object') throw new TypeError('operation.task must be an object');
    const id = requiredString(candidate.id, 'operation.task.id');
    const goalRevision = positiveInteger(candidate.goalRevision, 'operation.task.goalRevision');
    const contractRevision = positiveInteger(
      candidate.contractRevision, 'operation.task.contractRevision',
    );
    if (goalRevision !== project.goalRevision || contractRevision !== project.contractRevision) {
      throw new Error('operation task revision does not match current project');
    }
    const dependencies = candidate.dependencies ?? [];
    const acceptance = candidate.acceptance ?? [];
    const allowedPaths = candidate.allowedPaths ?? [];
    const prohibitedActions = candidate.prohibitedActions ?? [];
    stringArray(dependencies, 'operation.task.dependencies');
    stringArray(acceptance, 'operation.task.acceptance');
    stringArray(allowedPaths, 'operation.task.allowedPaths');
    stringArray(prohibitedActions, 'operation.task.prohibitedActions');
    enumValue(candidate.status, TASK_STATUSES, 'operation.task.status');
    if (candidate.status === 'accepted') throw new Error('director tasks cannot start accepted');
    if (new Set(dependencies).size !== dependencies.length) {
      throw new Error('dependencies must not contain duplicates');
    }
    for (const dependencyId of dependencies) {
      const dependency = this._directorTask(project.id, dependencyId);
      this._assertCurrent(dependency, project, 'dependency');
    }
    if (candidate.repairOfTaskId) {
      const parent = this._directorTask(project.id, candidate.repairOfTaskId);
      this._assertCurrent(parent, project, 'repair parent');
      positiveInteger(candidate.repairOrdinal, 'operation.task.repairOrdinal');
      const failure = this.getEvidence(
        requiredString(
          candidate.parentFailureEvidenceId,
          'operation.task.parentFailureEvidenceId',
        ),
      );
      if (!failure || failure.status !== 'failed') {
        throw new Error('repair task requires stored failed parent evidence');
      }
      const failedTask = this._directorTask(project.id, failure.taskId);
      if (failedTask.id !== parent.id && failedTask.repairOfTaskId !== parent.id) {
        throw new Error('repair failure evidence is not in the parent repair chain');
      }
      this._assertCurrent(failure, project, 'repair failure evidence');
    }
    this._db.prepare(`
      INSERT INTO tasks(
        task_id, project_id, goal_revision, contract_revision, acceptance_json, status,
        allowed_paths_json, prohibited_actions_json, input_json, workspace_path,
        execution_mode, small, safe, read_only, force_worker, repair_of_task_id,
        repair_ordinal, parent_failure_evidence_id, bounded_experiment
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, project.id, goalRevision, contractRevision, JSON.stringify(acceptance), candidate.status,
      JSON.stringify(allowedPaths), JSON.stringify(prohibitedActions), jsonText(candidate.input),
      candidate.workspacePath ?? null, candidate.executionMode ?? null,
      Number(candidate.small === true), Number(candidate.safe === true),
      Number(candidate.readOnly === true), Number(candidate.forceWorker === true),
      candidate.repairOfTaskId ?? null, candidate.repairOrdinal ?? null,
      candidate.parentFailureEvidenceId ?? null, Number(candidate.boundedExperiment === true),
    );
    const insert = this._db.prepare(`
      INSERT INTO task_dependencies(task_id, depends_on_task_id) VALUES (?, ?)
    `);
    for (const dependencyId of dependencies) insert.run(id, dependencyId);
    return this.getTask(id);
  }

  _insertDirectorEvidence(project, candidate) {
    if (!candidate || typeof candidate !== 'object') {
      throw new TypeError('operation.evidence must be an object');
    }
    const attempt = this._directorAttempt(project.id, candidate.attemptId);
    const task = this._directorTask(project.id, candidate.taskId);
    this._assertCurrent(attempt, project, 'evidence attempt');
    this._assertCurrent(task, project, 'evidence task');
    if (attempt.taskId !== task.id) throw new Error('evidence task does not match attempt');
    if (
      candidate.goalRevision !== project.goalRevision
      || candidate.contractRevision !== project.contractRevision
    ) {
      throw new Error('evidence revision does not match current project');
    }
    const status = enumValue(candidate.status, EVIDENCE_STATUSES, 'operation.evidence.status');
    const exitCode = candidate.exitCode ?? null;
    if (exitCode !== null && !Number.isSafeInteger(exitCode)) {
      throw new TypeError('operation.evidence.exitCode must be an integer or null');
    }
    this._db.prepare(`
      INSERT INTO evidence(
        evidence_id, task_id, attempt_id, goal_revision, contract_revision,
        kind, digest, location, status, exit_code, details_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      requiredString(candidate.id, 'operation.evidence.id'), task.id, attempt.id,
      project.goalRevision, project.contractRevision,
      requiredString(candidate.kind, 'operation.evidence.kind'),
      requiredString(candidate.digest, 'operation.evidence.digest'),
      requiredString(candidate.location, 'operation.evidence.location'),
      status, exitCode, jsonText(candidate.details),
    );
    return this.getEvidence(candidate.id);
  }

  _assertVerifiedCandidate(project, taskId, attemptId, evidenceId) {
    const task = this._directorTask(project.id, taskId);
    const attempt = this._directorAttempt(project.id, attemptId);
    this._assertCurrent(task, project, 'accepted task');
    this._assertCurrent(attempt, project, 'accepted attempt');
    if (!['candidate', 'verifying'].includes(task.status)) {
      throw new Error('only a candidate or verifying task can be accepted');
    }
    if (attempt.taskId !== task.id || attempt.status !== 'candidate' || !attempt.verified) {
      throw new Error('accepted attempt must be a verified candidate bound to the task');
    }
    const evidence = this.getEvidence(requiredString(evidenceId, 'evidenceId'));
    if (
      !evidence
      || evidence.attemptId !== attempt.id
      || evidence.taskId !== task.id
      || evidence.status !== 'passed'
      || evidence.goalRevision !== project.goalRevision
      || evidence.contractRevision !== project.contractRevision
    ) {
      throw new Error('accepted attempt requires bound passing verification evidence');
    }
    const linked = this._db.prepare(`
      SELECT 1 AS present FROM attempt_verification_evidence
      WHERE attempt_id = ? AND evidence_id = ?
    `).get(attempt.id, evidence.id);
    if (!linked) throw new Error('passing verification evidence is not bound to attempt');
    this._assertDependenciesAccepted(task);
    return { task, attempt, evidence };
  }

  apply(operation) {
    if (!operation || typeof operation !== 'object') throw new TypeError('operation must be an object');
    const type = requiredString(operation.type, 'operation.type');
    const projectId = requiredString(operation.projectId, 'operation.projectId');
    const expectedRevision = positiveInteger(operation.expectedRevision, 'operation.expectedRevision');
    const goalRevision = positiveInteger(operation.goalRevision, 'operation.goalRevision');
    const contractRevision = positiveInteger(
      operation.contractRevision, 'operation.contractRevision',
    );

    return this.transaction(() => {
      const project = this.getProject(projectId);
      if (!project) throw new Error(`project not found: ${projectId}`);
      if (project.stateRevision !== expectedRevision) {
        throw new Error(
          `stale expectedRevision: expected ${expectedRevision}, current ${project.stateRevision}`,
        );
      }
      if (project.goalRevision !== goalRevision || project.contractRevision !== contractRevision) {
        throw new Error('operation revision does not match current project');
      }

      switch (type) {
        case 'supersede_attempt': {
          const attempt = this._directorAttempt(projectId, operation.attemptId);
          if (
            attempt.goalRevision === project.goalRevision
            && attempt.contractRevision === project.contractRevision
          ) {
            throw new Error('cannot supersede a current-revision attempt');
          }
          this._db.prepare(`
            UPDATE run_attempts
            SET status = 'superseded', unconfirmed_active = ?, updated_at = datetime('now')
            WHERE attempt_id = ?
          `).run(Number(operation.requiresReconciliation === true), attempt.id);
          break;
        }
        case 'record_superseded_terminal': {
          const attempt = this._directorAttempt(projectId, operation.attemptId);
          if (attempt.status !== 'superseded' || attempt.unconfirmedActive !== true) {
            throw new Error('only an unconfirmed superseded attempt can record a terminal result');
          }
          this._db.prepare(`
            UPDATE run_attempts
            SET status = 'superseded', unconfirmed_active = 0, updated_at = datetime('now')
            WHERE attempt_id = ?
          `).run(attempt.id);
          break;
        }
        case 'supersede_task': {
          const task = this._directorTask(projectId, operation.taskId);
          if (
            task.goalRevision === project.goalRevision
            && task.contractRevision === project.contractRevision
          ) {
            throw new Error('cannot supersede a current-revision task');
          }
          this._db.prepare(`
            UPDATE tasks SET status = 'superseded', updated_at = datetime('now')
            WHERE task_id = ?
          `).run(task.id);
          break;
        }
        case 'block_task_dependencies': {
          const task = this._directorTask(projectId, operation.taskId);
          if (task.dependencies.every((id) => {
            const dependency = this.getTask(id);
            return dependency?.status === 'accepted'
              && dependency.goalRevision === project.goalRevision
              && dependency.contractRevision === project.contractRevision;
          })) {
            throw new Error('cannot block a task whose dependencies are accepted');
          }
          this._db.prepare(`
            UPDATE tasks SET status = 'pending', updated_at = datetime('now') WHERE task_id = ?
          `).run(task.id);
          break;
        }
        case 'create_attempt': {
          const candidate = operation.attempt;
          if (!candidate || typeof candidate !== 'object') {
            throw new TypeError('operation.attempt must be an object');
          }
          const task = this._directorTask(projectId, candidate.taskId);
          this._assertCurrent(task, project, 'attempt task');
          if (candidate.goalRevision !== goalRevision || candidate.contractRevision !== contractRevision) {
            throw new Error('attempt revision does not match current project');
          }
          const workspacePath = candidate.workspacePath
            ?? candidate.workPackage?.workspacePath
            ?? `director://direct/${candidate.id}`;
          this._db.prepare(`
            INSERT INTO run_attempts(
              attempt_id, task_id, goal_revision, contract_revision, provider,
              workspace_path, input_digest, status, writer, work_package_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)
          `).run(
            requiredString(candidate.id, 'operation.attempt.id'), task.id,
            goalRevision, contractRevision,
            requiredString(candidate.provider, 'operation.attempt.provider'),
            requiredString(workspacePath, 'operation.attempt.workspacePath'),
            requiredString(candidate.inputDigest, 'operation.attempt.inputDigest'),
            Number(candidate.writer !== false), jsonText(candidate.workPackage),
          );
          break;
        }
        case 'start_attempt': {
          const attempt = this._directorAttempt(projectId, operation.attemptId);
          const task = this._directorTask(projectId, operation.taskId);
          this._assertCurrent(attempt, project, 'attempt');
          this._assertCurrent(task, project, 'task');
          if (attempt.taskId !== task.id || attempt.status !== 'prepared' || task.status !== 'ready') {
            throw new Error('only a prepared attempt for a ready task can start');
          }
          this._assertDependenciesAccepted(task);
          this._db.prepare(`
            UPDATE run_attempts SET status = 'running', updated_at = datetime('now')
            WHERE attempt_id = ?
          `).run(attempt.id);
          this._db.prepare(`
            UPDATE tasks SET status = 'running', updated_at = datetime('now') WHERE task_id = ?
          `).run(task.id);
          this._db.prepare(`
            UPDATE projects SET
              engineering_attempts_batch = engineering_attempts_batch + 1,
              engineering_attempts_run = engineering_attempts_run + 1
            WHERE project_id = ?
          `).run(projectId);
          break;
        }
        case 'record_dispatch': {
          const attempt = this._directorAttempt(projectId, operation.attemptId);
          if (attempt.status !== 'running') throw new Error('only a running attempt can record dispatch');
          jsonObjectOrNull(operation.executionRef, 'operation.executionRef');
          this._db.prepare(`
            UPDATE run_attempts SET execution_ref_json = ?, native_session_id = ?,
              native_job_id = ?, updated_at = datetime('now') WHERE attempt_id = ?
          `).run(
            jsonText(operation.executionRef), operation.executionRef?.nativeSessionId ?? null,
            operation.executionRef?.nativeJobId ?? null, attempt.id,
          );
          break;
        }
        case 'mark_unknown_outcome': {
          const attempt = this._directorAttempt(projectId, operation.attemptId);
          const task = this._directorTask(projectId, operation.taskId);
          if (attempt.taskId !== task.id) throw new Error('attempt does not belong to task');
          this._db.prepare(`
            UPDATE run_attempts SET status = 'unknown_outcome', unconfirmed_active = 1,
              failure_reason = ?, error_code = ?, updated_at = datetime('now')
            WHERE attempt_id = ?
          `).run(operation.reason ?? null, operation.errorCode ?? null, attempt.id);
          this._db.prepare(`
            UPDATE tasks SET status = 'unknown_outcome', updated_at = datetime('now')
            WHERE task_id = ?
          `).run(task.id);
          break;
        }
        case 'record_attempt_stopped': {
          const attempt = this._directorAttempt(projectId, operation.attemptId);
          const task = this._directorTask(projectId, operation.taskId);
          if (attempt.taskId !== task.id) throw new Error('attempt does not belong to task');
          enumValue(operation.status, ATTEMPT_STATUSES, 'operation.status');
          this._db.prepare(`
            UPDATE run_attempts SET status = ?, unconfirmed_active = 0,
              updated_at = datetime('now') WHERE attempt_id = ?
          `).run(operation.status, attempt.id);
          this._db.prepare(`
            UPDATE tasks SET status = 'interrupted', updated_at = datetime('now')
            WHERE task_id = ?
          `).run(task.id);
          break;
        }
        case 'record_attempt_failure': {
          const attempt = this._directorAttempt(projectId, operation.attemptId);
          const task = this._directorTask(projectId, operation.taskId);
          if (attempt.taskId !== task.id) throw new Error('attempt does not belong to task');
          const status = enumValue(operation.status, ATTEMPT_STATUSES, 'operation.status');
          if (!['failed', 'blocked', 'timed_out'].includes(status)) {
            throw new Error('attempt failure status must be failed, blocked, or timed_out');
          }
          this._insertDirectorEvidence(project, operation.evidence);
          this._db.prepare(`
            UPDATE run_attempts SET status = ?, unconfirmed_active = 0,
              failure_reason = ?, error_code = ?, updated_at = datetime('now')
            WHERE attempt_id = ?
          `).run(
            status, operation.evidence?.details?.reason ?? null,
            operation.evidence?.details?.errorCode ?? null, attempt.id,
          );
          this._db.prepare(`
            UPDATE tasks SET status = 'needs_revision', updated_at = datetime('now')
            WHERE task_id = ?
          `).run(task.id);
          break;
        }
        case 'create_repair_task':
          this._insertDirectorTask(project, operation.task);
          break;
        case 'record_candidate': {
          const attempt = this._directorAttempt(projectId, operation.attemptId);
          const task = this._directorTask(projectId, operation.taskId);
          if (attempt.taskId !== task.id || attempt.status !== 'running') {
            throw new Error('candidate must come from the running task attempt');
          }
          jsonObjectOrNull(operation.candidate, 'operation.candidate');
          this._db.prepare(`
            UPDATE run_attempts SET status = 'candidate', candidate_json = ?,
              unconfirmed_active = 0, updated_at = datetime('now') WHERE attempt_id = ?
          `).run(jsonText(operation.candidate), attempt.id);
          this._db.prepare(`
            UPDATE tasks SET status = 'candidate', updated_at = datetime('now') WHERE task_id = ?
          `).run(task.id);
          break;
        }
        case 'record_verification': {
          const attempt = this._directorAttempt(projectId, operation.attemptId);
          const task = this._directorTask(projectId, operation.taskId);
          if (attempt.taskId !== task.id || attempt.status !== 'candidate') {
            throw new Error('verification must be bound to a candidate attempt');
          }
          const evidence = this._insertDirectorEvidence(project, operation.evidence);
          if (evidence.status === 'passed') {
            this._db.prepare(`
              INSERT INTO attempt_verification_evidence(attempt_id, evidence_id) VALUES (?, ?)
            `).run(attempt.id, evidence.id);
            this._db.prepare(`
              UPDATE run_attempts SET verified = 1, updated_at = datetime('now')
              WHERE attempt_id = ?
            `).run(attempt.id);
            this._db.prepare(`
              UPDATE tasks SET status = 'verifying', updated_at = datetime('now')
              WHERE task_id = ?
            `).run(task.id);
          } else {
            this._db.prepare(`
              UPDATE tasks SET status = 'needs_revision', updated_at = datetime('now')
              WHERE task_id = ?
            `).run(task.id);
          }
          break;
        }
        case 'accept_task': {
          const verified = this._assertVerifiedCandidate(
            project, operation.taskId, operation.attemptId, operation.evidenceId,
          );
          this._db.prepare(`
            UPDATE tasks SET status = 'accepted', accepted_attempt_id = ?,
              updated_at = datetime('now') WHERE task_id = ?
          `).run(verified.attempt.id, verified.task.id);
          break;
        }
        case 'accept_repair': {
          const verified = this._assertVerifiedCandidate(
            project, operation.repairTaskId, operation.attemptId, operation.evidenceId,
          );
          const parent = this._directorTask(projectId, operation.parentTaskId);
          this._assertCurrent(parent, project, 'repair parent');
          if (verified.task.repairOfTaskId !== parent.id) {
            throw new Error('repair task is not bound to the parent task');
          }
          this._assertDependenciesAccepted(parent);
          this._db.prepare(`
            UPDATE tasks SET status = 'accepted', accepted_attempt_id = ?,
              updated_at = datetime('now') WHERE task_id = ?
          `).run(verified.attempt.id, verified.task.id);
          this._db.prepare(`
            UPDATE tasks SET status = 'accepted', accepted_attempt_id = ?,
              accepted_via_repair_task_id = ?, updated_at = datetime('now')
            WHERE task_id = ?
          `).run(verified.attempt.id, verified.task.id, parent.id);
          break;
        }
        case 'ready_task': {
          const task = this._directorTask(projectId, operation.taskId);
          this._assertCurrent(task, project, 'ready task');
          if (task.status !== 'pending') throw new Error('only a pending task can become ready');
          this._assertDependenciesAccepted(task);
          this._db.prepare(`
            UPDATE tasks SET status = 'ready', updated_at = datetime('now') WHERE task_id = ?
          `).run(task.id);
          break;
        }
        case 'mark_task_needs_revision': {
          const task = this._directorTask(projectId, operation.taskId);
          this._db.prepare(`
            UPDATE tasks SET status = 'needs_revision', updated_at = datetime('now')
            WHERE task_id = ?
          `).run(task.id);
          break;
        }
        case 'record_director_cycle':
          this._db.prepare(`
            UPDATE projects SET no_progress_cycles = ? WHERE project_id = ?
          `).run(
            nonNegativeInteger(operation.noProgressCycles, 'operation.noProgressCycles'), projectId,
          );
          break;
        case 'schedule_minimal_experiment': {
          const row = this._db.prepare(`
            SELECT minimal_experiment_scheduled FROM projects WHERE project_id = ?
          `).get(projectId);
          if (row.minimal_experiment_scheduled === 1) {
            throw new Error('minimal experiment is already scheduled');
          }
          this._insertDirectorTask(project, operation.task);
          this._db.prepare(`
            UPDATE projects SET minimal_experiment_scheduled = 1 WHERE project_id = ?
          `).run(projectId);
          break;
        }
        default:
          throw new Error(`unsupported director operation: ${type}`);
      }

      this._touchProject(projectId);
      return this.readSnapshot(projectId);
    });
  }

  schemaColumns() {
    const tables = this._db.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all();
    return Object.fromEntries(tables.map(({ name }) => [
      name,
      this._db.prepare(`PRAGMA table_info(${name})`).all().map((column) => column.name),
    ]));
  }

  schemaVersion() {
    return this._db.prepare('SELECT MAX(schema_version) AS version FROM schema_meta').get().version;
  }
}

module.exports = { BuilderStateStore, SCHEMA_SQL, SCHEMA_VERSION, createStateHostAuthority };
