import assert from 'node:assert/strict';
import { financeV3BenchmarkCases } from '../benchmarks/finance-v3-cases';

assert.ok(financeV3BenchmarkCases.length >= 30, 'benchmark corpus should cover at least 30 scenarios');

const ids = financeV3BenchmarkCases.map((item) => item.id);
assert.equal(new Set(ids).size, ids.length, 'benchmark case ids must be unique');

const critical = financeV3BenchmarkCases.filter((item) => item.critical);
assert.ok(critical.length >= 5, 'critical regression family is too small');

const resultSetCases = financeV3BenchmarkCases.filter((item) => item.family === 'result_set');
assert.ok(resultSetCases.length >= 8, 'result-set follow-up coverage is too small');

const explicitSearchCases = financeV3BenchmarkCases.filter((item) => item.family === 'search');
assert.ok(explicitSearchCases.length >= 2, 'explicit-search coverage is too small');
for (const item of explicitSearchCases) {
  assert.equal(item.expected_tool?.tool, 'search_transactions');
  assert.equal(item.expected_tool?.explicit_search, true);
  assert.ok(item.expected_tool?.query, `search case ${item.id} must declare its query`);
}

for (const item of financeV3BenchmarkCases.filter((entry) => entry.family !== 'search')) {
  assert.notEqual(item.expected_tool?.tool, 'search_transactions', `non-search case ${item.id} must not expect full-text search`);
}

const requiredCriticalIds = [
  'summary-last-month-1',
  'summary-this-month-to-date',
  'summary-explicit-august',
  'group-last-month-4',
  'result-set-start-1',
  'explicit-search',
  'ordinary-intent-must-not-search-1'
];
for (const id of requiredCriticalIds) {
  assert.ok(financeV3BenchmarkCases.some((item) => item.id === id && item.critical), `missing critical regression ${id}`);
}

assert.ok(financeV3BenchmarkCases.some((item) => item.expected_kind === 'clarification'), 'must benchmark clarification behavior');
assert.ok(financeV3BenchmarkCases.some((item) => item.expected_kind === 'non_finance'), 'must benchmark non-finance behavior');
assert.ok(financeV3BenchmarkCases.some((item) => item.family === 'compare'), 'must benchmark period comparison');
assert.ok(financeV3BenchmarkCases.some((item) => item.truth?.kind === 'result_set_description'), 'must benchmark result-set earliest/latest facts');

console.log('finance-v3-benchmark-contract.test.ts: PASS');
