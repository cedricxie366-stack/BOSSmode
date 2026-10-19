'use strict';
const assert = require('node:assert/strict');
const { readFileSync, statSync } = require('node:fs');
const { isAbsolute } = require('node:path');

function validatePlan(plan) {
  assert.ok(plan && typeof plan === 'object' && !Array.isArray(plan), 'acceptancePlan required');
  assert.ok(JSON.stringify(plan).length <= 65536, 'Plan too large');
  assert.ok(Object.keys(plan).every(k => ['checks', 'reviewCriteria'].includes(k)), 'Unsupported plan field');
  assert.ok(Array.isArray(plan.checks) && plan.checks.length > 0 && plan.checks.length <= 40, '1-40 checks required');
  const ids = new Set();
  for (const check of plan.checks) {
    assert.ok(check && typeof check.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(check.id) && !ids.has(check.id), 'Invalid or duplicate check id');
    ids.add(check.id);
    assert.ok(Object.keys(check).every(k => ['id','kind','path','minBytes','maxBytes','value','fields'].includes(k)), 'Unsupported check field');
    assert.ok(['file', 'text_contains', 'json_fields'].includes(check.kind), 'Unsupported check kind');
    assert.ok(typeof check.path === 'string' && !isAbsolute(check.path) && !check.path.includes('\\')
      && check.path.split('/').every(p => p && p !== '.' && p !== '..'), 'Unsafe check path');
    for (const key of ['minBytes', 'maxBytes']) if (check[key] !== undefined) {
      assert.ok(Number.isSafeInteger(check[key]) && check[key] >= 0 && check[key] <= 1048576, 'Invalid byte limit');
    }
    assert.ok((check.minBytes ?? 1) <= (check.maxBytes ?? 1048576), 'Contradictory byte limits');
    if (check.kind === 'text_contains') assert.ok(typeof check.value === 'string' && check.value.length > 0 && check.value.length <= 8192, 'Literal text required');
    if (check.kind === 'json_fields') {
      assert.ok(check.fields && typeof check.fields === 'object' && !Array.isArray(check.fields) && Object.keys(check.fields).length > 0, 'JSON fields required');
      assert.ok(Object.values(check.fields).every(type => ['string','number','boolean','object','array'].includes(type)), 'Unsupported JSON type');
    }
  }
  assert.ok(Array.isArray(plan.reviewCriteria) && plan.reviewCriteria.length > 0 && plan.reviewCriteria.length <= 20, 'Review criteria required');
  for (const item of plan.reviewCriteria) {
    assert.ok(item && typeof item.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(item.id) && !ids.has(item.id), 'Invalid review id');
    ids.add(item.id);
    assert.ok(typeof item.text === 'string' && item.text.trim() && item.text.length <= 2000, 'Review criterion text required');
    assert.ok(Object.keys(item).every(k => ['id','text'].includes(k)), 'Unsupported review criterion field');
  }
  return JSON.parse(JSON.stringify(plan));
}

function checkPlan(plan) {
  validatePlan(plan);
  for (const check of plan.checks) {
    const stat = statSync(check.path);
    assert.ok(stat.isFile() && stat.size >= (check.minBytes ?? 1) && stat.size <= (check.maxBytes ?? 1048576), `File size/type check failed: ${check.id}`);
    if (check.kind === 'file') continue;
    const content = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(check.path));
    if (check.kind === 'text_contains') assert.ok(content.includes(check.value), `Required literal missing: ${check.id}`);
    if (check.kind === 'json_fields') {
      const data = JSON.parse(content);
      assert.ok(data && typeof data === 'object' && !Array.isArray(data), 'JSON root must be object');
      for (const [field, type] of Object.entries(check.fields)) {
        assert.ok(Object.hasOwn(data, field), `Missing JSON field: ${field}`);
        const value = data[field];
        const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
        assert.equal(actual, type, `JSON type mismatch: ${field}`);
      }
    }
  }
}
module.exports = { validatePlan, checkPlan };
if (require.main === module) {
  checkPlan(JSON.parse(process.env.BUILDER_ACCEPTANCE_PLAN));
  process.stdout.write('Frozen data checks passed. Semantic quality remains subject to review.\n');
}
