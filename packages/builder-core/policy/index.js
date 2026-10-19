'use strict';

const { DatabaseSync } = require('node:sqlite');

const SENSITIVE_POLICY = Object.freeze({
  public_publish: ['public_publish_allowed', 'POLICY_PUBLIC_PUBLISH_DISABLED'],
  new_paid_service: ['new_paid_services_allowed', 'POLICY_NEW_PAID_SERVICE_DISABLED'],
  real_customer_data: ['real_customer_data_allowed', 'POLICY_REAL_CUSTOMER_DATA_DISABLED'],
});

const FINAL_ACTION_STATES = new Set(['confirmed', 'rejected']);
const OUTCOME_STATES = new Set(['confirmed', 'rejected', 'unknown']);
const APPROVAL_FIELDS = Object.freeze([
  'projectId',
  'goalRevision',
  'contractRevision',
  'action',
  'resource',
  'scopeDigest',
]);

function denial(code, reason, extra = {}) {
  return Object.freeze({ allowed: false, code, reason, ...extra });
}

function allowance(extra = {}) {
  return Object.freeze({ allowed: true, code: 'ALLOWED', reason: null, ...extra });
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number`);
  }
  return value;
}

function actor(value, name) {
  if (!value || typeof value !== 'object') {
    throw new TypeError(`${name} must be an actor object`);
  }
  return Object.freeze({
    type: requiredString(value.type, `${name}.type`),
    id: requiredString(value.id, `${name}.id`),
  });
}

function sameActor(left, right) {
  return left.type === right.type && left.id === right.id;
}

function sameIntentIdentity(left, right) {
  return APPROVAL_FIELDS.every((field) => left[field] === right[field])
    && sameActor(left.actor, right.actor);
}

function cloneActionIntent(intent) {
  return Object.freeze({ ...intent, actor: Object.freeze({ ...intent.actor }) });
}

function normalizeUsage(usage) {
  if (!usage || usage.visibility !== 'known') return null;
  const fields = [
    'engineeringAttemptsThisBatch',
    'engineeringAttemptsThisRun',
    'controlModelCallsThisRun',
    'autoRepairsForTask',
    'wallClockSeconds',
  ];
  const normalized = { visibility: 'known' };
  for (const field of fields) {
    normalized[field] = nonNegativeNumber(usage[field], `usage.${field}`);
  }
  if (usage.amount === undefined || usage.amount === null) {
    normalized.amount = null;
  } else {
    normalized.amount = nonNegativeNumber(usage.amount, 'usage.amount');
  }
  normalized.currency = usage.currency ?? null;
  if (normalized.currency !== null) requiredString(normalized.currency, 'usage.currency');
  return Object.freeze(normalized);
}

class HostPolicyEngine {
  #approvalAuthority;
  #approvals = new Map();
  #intents = new Map();
  #intentIdByIdempotencyKey = new Map();
  #now;
  #policy;
  #supportedActions;

  constructor({ policy, approvalAuthority, supportedActions, now = () => Date.now() }) {
    if (!policy || typeof policy !== 'object') {
      throw new TypeError('policy must be an object');
    }
    if ((typeof approvalAuthority !== 'object' || approvalAuthority === null)
      && typeof approvalAuthority !== 'function') {
      throw new TypeError('approvalAuthority must be a host-owned object');
    }
    if (!Array.isArray(supportedActions) || supportedActions.length === 0) {
      throw new TypeError('supportedActions must be a non-empty array');
    }
    if (typeof now !== 'function') throw new TypeError('now must be a function');

    this.#policy = Object.freeze({ ...policy });
    this.#approvalAuthority = approvalAuthority;
    this.#supportedActions = new Set(supportedActions.map((value, index) => (
      requiredString(value, `supportedActions[${index}]`)
    )));
    this.#now = now;
  }

  /**
   * Accepts an approval only through an object-identity capability retained by the
   * Host. An `approved` field in an LLM proposal is never read by this method.
   */
  registerApproval(candidate, authority) {
    if (authority !== this.#approvalAuthority) {
      return denial(
        'APPROVAL_NOT_HOST_ATTESTED',
        'Only the Host approval authority can register an approval.',
      );
    }
    if (!candidate || typeof candidate !== 'object') {
      throw new TypeError('approval must be an object');
    }

    const approvalActor = actor(candidate.actor, 'approval.actor');
    if (approvalActor.type !== 'user') {
      return denial(
        'APPROVAL_ACTOR_NOT_USER',
        'Model and system actors cannot grant user authorization.',
      );
    }

    const expiresAt = Date.parse(requiredString(candidate.expiresAt, 'approval.expiresAt'));
    if (!Number.isFinite(expiresAt)) {
      throw new TypeError('approval.expiresAt must be a valid timestamp');
    }
    const approval = Object.freeze({
      id: requiredString(candidate.id, 'approval.id'),
      projectId: requiredString(candidate.projectId, 'approval.projectId'),
      goalRevision: positiveInteger(candidate.goalRevision, 'approval.goalRevision'),
      contractRevision: positiveInteger(candidate.contractRevision, 'approval.contractRevision'),
      action: requiredString(candidate.action, 'approval.action'),
      resource: requiredString(candidate.resource, 'approval.resource'),
      scopeDigest: requiredString(candidate.scopeDigest, 'approval.scopeDigest'),
      expiresAt,
      actor: approvalActor,
    });

    const existing = this.#approvals.get(approval.id);
    if (existing) {
      if (sameIntentIdentity(existing, approval) && existing.expiresAt === approval.expiresAt) {
        return allowance({ approval: existing, registered: false });
      }
      return denial('APPROVAL_ID_CONFLICT', 'The approval id is already bound to a different scope.');
    }
    this.#approvals.set(approval.id, approval);
    return allowance({ approval, registered: true });
  }

  prepareAction(candidate) {
    if (!candidate || typeof candidate !== 'object') {
      throw new TypeError('action intent must be an object');
    }
    const intent = {
      id: requiredString(candidate.id, 'intent.id'),
      idempotencyKey: requiredString(candidate.idempotencyKey, 'intent.idempotencyKey'),
      projectId: requiredString(candidate.projectId, 'intent.projectId'),
      goalRevision: positiveInteger(candidate.goalRevision, 'intent.goalRevision'),
      contractRevision: positiveInteger(candidate.contractRevision, 'intent.contractRevision'),
      action: requiredString(candidate.action, 'intent.action'),
      resource: requiredString(candidate.resource, 'intent.resource'),
      scopeDigest: requiredString(candidate.scopeDigest, 'intent.scopeDigest'),
      actor: actor(candidate.actor, 'intent.actor'),
      // Sensitivity is derived from the Host action catalog. A proposal cannot
      // downgrade or upgrade its own policy category with a free-form field.
      sensitivity: SENSITIVE_POLICY[candidate.action] ? candidate.action : null,
      // ActionIntent represents an external side effect. Externality is a Host
      // fact and must not be downgraded by a model-authored proposal.
      external: true,
      status: 'prepared',
      dispatchCount: 0,
      outcome: null,
    };
    const existingById = this.#intents.get(intent.id);
    if (existingById) {
      if (existingById.idempotencyKey === intent.idempotencyKey
        && sameIntentIdentity(existingById, intent)
        && existingById.sensitivity === intent.sensitivity) {
        return allowance({ intent: cloneActionIntent(existingById), created: false });
      }
      return denial('ACTION_INTENT_ID_CONFLICT', 'The action intent id is already in use.');
    }

    const existingId = this.#intentIdByIdempotencyKey.get(intent.idempotencyKey);
    if (existingId) {
      const existing = this.#intents.get(existingId);
      if (sameIntentIdentity(existing, intent)
        && existing.sensitivity === intent.sensitivity) {
        return allowance({ intent: cloneActionIntent(existing), created: false });
      }
      return denial(
        'IDEMPOTENCY_KEY_CONFLICT',
        'The idempotency key is already bound to a different external action.',
      );
    }

    this.#intents.set(intent.id, intent);
    this.#intentIdByIdempotencyKey.set(intent.idempotencyKey, intent.id);
    return allowance({ intent: cloneActionIntent(intent), created: true });
  }

  authorizeAction({ intentId, approvalId, usage, usageAuthority }) {
    const intent = this.#intents.get(requiredString(intentId, 'intentId'));
    if (!intent) return denial('ACTION_INTENT_NOT_FOUND', 'The action intent does not exist.');
    if (!this.#supportedActions.has(intent.action)) {
      return denial('ACTION_UNSUPPORTED', `The action is not supported: ${intent.action}.`);
    }

    const sensitiveDenial = this.#checkSensitivePolicy(intent);
    if (sensitiveDenial) return sensitiveDenial;

    if (usageAuthority !== this.#approvalAuthority) {
      return denial('USAGE_NOT_HOST_ATTESTED', 'Only Host-attested usage can authorize an action.');
    }
    const budgetDecision = this.#checkBudget(usage);
    if (!budgetDecision.allowed) return budgetDecision;

    if (this.#policy.external_side_effects_require_scoped_approval !== false) {
      if (typeof approvalId !== 'string' || approvalId.length === 0) {
        return denial('APPROVAL_REQUIRED', 'A Host-attested scoped approval is required.');
      }
      const approvalDecision = this.#checkApproval(intent, approvalId);
      if (!approvalDecision.allowed) return approvalDecision;
    }
    return allowance({ intent: cloneActionIntent(intent) });
  }

  dispatchAction({ intentId, approvalId, usage, usageAuthority }) {
    const intent = this.#intents.get(requiredString(intentId, 'intentId'));
    if (!intent) return denial('ACTION_INTENT_NOT_FOUND', 'The action intent does not exist.');
    if (intent.status === 'unknown') {
      return denial(
        'UNKNOWN_OUTCOME_NO_RETRY',
        'The outcome is unknown; reconcile the existing idempotency key instead of dispatching again.',
        { intent: cloneActionIntent(intent) },
      );
    }
    if (intent.status !== 'prepared') {
      return denial(
        'ACTION_ALREADY_DISPATCHED',
        'This action intent cannot be dispatched a second time.',
        { intent: cloneActionIntent(intent) },
      );
    }

    const decision = this.authorizeAction({ intentId, approvalId, usage, usageAuthority });
    if (!decision.allowed) return Object.freeze({ ...decision, intent: cloneActionIntent(intent) });

    // This is an authorization boundary only. The external adapter performs the
    // actual operation after this durable transition and reports an outcome.
    intent.status = 'dispatched';
    intent.dispatchCount += 1;
    return allowance({ intent: cloneActionIntent(intent) });
  }

  recordOutcome(intentId, outcome) {
    const intent = this.#intents.get(requiredString(intentId, 'intentId'));
    if (!intent) return denial('ACTION_INTENT_NOT_FOUND', 'The action intent does not exist.');
    if (!OUTCOME_STATES.has(outcome)) {
      return denial('ACTION_OUTCOME_UNSUPPORTED', `Unsupported action outcome: ${outcome}.`);
    }
    if (intent.status !== 'dispatched') {
      return denial(
        'ACTION_NOT_DISPATCHED',
        'An outcome can only be recorded for a dispatched action.',
        { intent: cloneActionIntent(intent) },
      );
    }
    intent.status = outcome;
    intent.outcome = outcome;
    return allowance({ intent: cloneActionIntent(intent) });
  }

  reconcileAction({ idempotencyKey, outcome }) {
    const key = requiredString(idempotencyKey, 'idempotencyKey');
    const intentId = this.#intentIdByIdempotencyKey.get(key);
    if (!intentId) return denial('ACTION_INTENT_NOT_FOUND', 'The idempotency key is unknown.');
    const intent = this.#intents.get(intentId);
    if (intent.status !== 'unknown') {
      return denial(
        'ACTION_NOT_RECONCILABLE',
        'Only an unknown action outcome can be reconciled.',
        { intent: cloneActionIntent(intent) },
      );
    }
    if (!FINAL_ACTION_STATES.has(outcome)) {
      return denial(
        'RECONCILIATION_OUTCOME_UNSUPPORTED',
        'Reconciliation must confirm or reject the original dispatch.',
        { intent: cloneActionIntent(intent) },
      );
    }
    intent.status = outcome;
    intent.outcome = outcome;
    return allowance({ intent: cloneActionIntent(intent), reconciled: true });
  }

  getActionIntent(intentId) {
    const intent = this.#intents.get(requiredString(intentId, 'intentId'));
    return intent ? cloneActionIntent(intent) : null;
  }

  exportHostState(authority) {
    if (authority !== this.#approvalAuthority) throw new Error('Host authority required');
    return JSON.parse(JSON.stringify({
      approvals: [...this.#approvals.values()], intents: [...this.#intents.values()],
    }));
  }

  restoreHostState(state, authority) {
    if (authority !== this.#approvalAuthority) throw new Error('Host authority required');
    if (!Array.isArray(state.approvals) || !Array.isArray(state.intents)) {
      throw new Error('Invalid policy journal');
    }
    this.#approvals = new Map(state.approvals.map((entry) => [entry.id, Object.freeze(entry)]));
    this.#intents = new Map(state.intents.map((entry) => [entry.id, entry]));
    this.#intentIdByIdempotencyKey = new Map(state.intents.map((entry) => [entry.idempotencyKey, entry.id]));
  }

  #checkSensitivePolicy(intent) {
    const category = intent.sensitivity ?? intent.action;
    const rule = SENSITIVE_POLICY[category];
    if (!rule) return null;
    const [policyField, code] = rule;
    if (this.#policy[policyField] !== true) {
      return denial(code, `Host policy disables ${category}.`);
    }
    return null;
  }

  #checkBudget(usage) {
    if (!usage || usage.visibility !== 'known') {
      if (this.#policy.unknown_usage_is_zero === true) return allowance();
      return denial('USAGE_UNKNOWN', 'Usage is unknown and cannot be treated as zero.');
    }
    const known = normalizeUsage(usage);
    const limits = [
      ['engineeringAttemptsThisBatch', 'max_engineering_attempts_per_batch'],
      ['engineeringAttemptsThisRun', 'max_engineering_attempts_per_authorized_run'],
      ['controlModelCallsThisRun', 'max_control_model_calls_per_authorized_run'],
      ['autoRepairsForTask', 'max_auto_repairs_per_task'],
      ['wallClockSeconds', 'child_wall_clock_seconds'],
    ];
    for (const [usageField, policyField] of limits) {
      const limit = this.#policy[policyField];
      if (typeof limit === 'number' && known[usageField] > limit) {
        return denial(
          'BUDGET_LIMIT_EXCEEDED',
          `${usageField} exceeds Host limit ${policyField}.`,
          { limit: policyField, observed: known[usageField], maximum: limit },
        );
      }
    }

    if (typeof this.#policy.cost_limit_amount === 'number') {
      if (known.amount === null) {
        return denial('COST_USAGE_UNKNOWN', 'Cost is unknown while a Host cost limit is active.');
      }
      if (known.currency !== this.#policy.cost_limit_currency) {
        return denial('COST_CURRENCY_MISMATCH', 'Usage currency does not match the Host cost limit.');
      }
      if (known.amount > this.#policy.cost_limit_amount) {
        return denial('BUDGET_LIMIT_EXCEEDED', 'Observed cost exceeds the Host cost limit.', {
          limit: 'cost_limit_amount',
          observed: known.amount,
          maximum: this.#policy.cost_limit_amount,
        });
      }
    }
    return allowance();
  }

  #checkApproval(intent, approvalId) {
    const approval = this.#approvals.get(approvalId);
    if (!approval) {
      return denial('APPROVAL_NOT_FOUND', 'No Host-attested approval exists with that id.');
    }
    for (const field of APPROVAL_FIELDS) {
      if (approval[field] !== intent[field]) {
        return denial(
          'APPROVAL_SCOPE_MISMATCH',
          `Approval does not match action field: ${field}.`,
          { mismatch: field },
        );
      }
    }
    if (!sameActor(approval.actor, intent.actor)) {
      return denial('APPROVAL_SCOPE_MISMATCH', 'Approval does not match the bound actor.', {
        mismatch: 'actor',
      });
    }
    if (this.#now() >= approval.expiresAt) {
      return denial('APPROVAL_EXPIRED', 'The scoped approval has expired.');
    }
    return allowance({ approval });
  }
}

// Host-only journal. No external action is performed by this service.
// The returned dispatch transition is committed before a connector may execute.
class DurableHostPolicyEngine {
  #database;
  #engine;
  #authority;
  constructor({ filename, ...options }) {
    this.#authority = options.approvalAuthority;
    this.#engine = new HostPolicyEngine(options);
    this.#database = new DatabaseSync(requiredString(filename, 'filename'), { timeout: 5000 });
    this.#database.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS policy_journal (
        id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, payload TEXT NOT NULL
      ) STRICT;
      INSERT OR IGNORE INTO policy_journal VALUES(1,1,'{"approvals":[],"intents":[]}');
    `);
    // Opening another connection is not a takeover. Dispatched work already
    // rejects repeat dispatch; only its Host observer may record an outcome.
  }
  #operate(operation) {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const row = this.#database.prepare('SELECT * FROM policy_journal WHERE id=1').get();
      if (row.version !== 1) throw new Error('Unsupported policy journal version');
      this.#engine.restoreHostState(JSON.parse(row.payload), this.#authority);
      const result = operation(this.#engine);
      this.#database.prepare('UPDATE policy_journal SET payload=? WHERE id=1')
        .run(JSON.stringify(this.#engine.exportHostState(this.#authority)));
      this.#database.exec('COMMIT');
      return result;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }
  registerApproval(candidate, authority) {
    return this.#operate((engine) => engine.registerApproval(candidate, authority));
  }
  prepareAction(candidate) { return this.#operate((engine) => engine.prepareAction(candidate)); }
  authorizeAction(input) { return this.#operate((engine) => engine.authorizeAction(input)); }
  dispatchAction(input) { return this.#operate((engine) => engine.dispatchAction(input)); }
  recordOutcome(id, outcome) { return this.#operate((engine) => engine.recordOutcome(id, outcome)); }
  reconcileAction(input) { return this.#operate((engine) => engine.reconcileAction(input)); }
  getActionIntent(id) { return this.#operate((engine) => engine.getActionIntent(id)); }
  close() { this.#database.close(); }
}

module.exports = { HostPolicyEngine, DurableHostPolicyEngine };
