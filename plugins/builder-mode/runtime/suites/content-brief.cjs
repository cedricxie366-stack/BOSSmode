'use strict';
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const brief = JSON.parse(readFileSync('brief.json', 'utf8'));
const content = readFileSync('content.md', 'utf8');
for (const key of ['audience', 'objective', 'format', 'constraints']) {
  assert.ok(typeof brief[key] === 'string' && brief[key].trim(), 'Missing brief field ' + key);
}
assert.ok(content.trim().length >= 80, 'Content draft is empty or too short');
assert.ok(Array.isArray(brief.reviewQuestions) && brief.reviewQuestions.length > 0);
process.stdout.write('Content/brief completeness checked; taste and business effectiveness require review.\n');
