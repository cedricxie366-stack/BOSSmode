'use strict';
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const report = readFileSync('report.md', 'utf8');
const sources = JSON.parse(readFileSync('sources.json', 'utf8'));
assert.ok(report.length >= 100, 'Research note is empty or too short');
assert.ok(Array.isArray(sources) && sources.length > 0, 'Source list is missing');
for (const source of sources) {
  const url = new URL(source.url);
  assert.ok(['https:', 'http:'].includes(url.protocol));
  assert.ok(source.title && source.claim && source.accessedAt);
  assert.ok(Number.isFinite(Date.parse(source.accessedAt)));
  assert.ok(report.includes(source.url), 'Cited source must appear in the report');
}
assert.match(report, /限制|未验证|limitations|uncertainty/iu);
process.stdout.write('Research structure and citation linkage checked; factual validity is not certified.\n');
