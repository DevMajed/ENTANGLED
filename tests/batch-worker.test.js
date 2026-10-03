import test from 'node:test';
import assert from 'node:assert/strict';
import { bellSummary, statistics } from '../src/experiment.js';
import { SPEED_OF_LIGHT } from '../src/physics.js';

// Exercise the actual worker message adapter in Node. Worker scheduling and the
// rendered interface are separate browser checks. postMessage clones its payload.
let response;
globalThis.self = { postMessage: message => { response = structuredClone(message); } };
await import('../src/batch-worker.js');

const settings = { source: 'entangled', state: 'singlet', a: 0, b: 0, visibility: 1 };
function runJob(overrides) {
  response = undefined;
  const job = { id: 7, type: 'batch', settings: { ...settings }, count: 100, seed: 2026, startId: 17, ...overrides };
  self.onmessage({ data: job });
  assert.ok(response, 'Worker must post a response');
  assert.equal(response.id, job.id);
  assert.ok(!response.error, response.error ?? 'No worker error');
  assert.equal(response.seed, job.seed);
  assert.equal(response.count, job.count);
  return response.result;
}
function near(actual, expected, tolerance) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} expected ${expected} ± ${tolerance}`);
}

test('Actual batch worker counts and exports all 100,000 fresh pairs with two linked detector events each', () => {
  const count = 100_000, startId = 17;
  const result = runJob({ count, startId });
  assert.equal(result.total, count);
  assert.equal(result.records.length, count);
  assert.equal(result.events.length, 2 * count);
  assert.equal(Object.values(result.counts).reduce((sum, value) => sum + value, 0), count);
  assert.equal(result.counts['++'], 0);
  assert.equal(result.counts['--'], 0);
  near(statistics(result).aPlus, 0.5, 5 * Math.sqrt(0.25 / count));
  assert.equal(result.last.id, startId + count - 1);
  for (let i = 0; i < count; i++) {
    const record = result.records[i];
    assert.equal(record.id, startId + i);
    assert.equal(record.outcomeA, -record.outcomeB);
    assert.equal(record.events.length, 2);
    assert.equal(record.events[0].pairId, record.id);
    assert.equal(record.events[1].pairId, record.id);
  }
  // The adapter sends ns; the engine must convert them to physical seconds once.
  for (const record of [result.records[0], result.records.at(-1)]) {
    near(record.emittedAt, record.id * 1e-3, 1e-12);
    near(record.emissionTimeNs, record.id * 1e6, 1e-3);
    near(record.timestampA - record.emittedAt, 1.8 / SPEED_OF_LIGHT, 1e-13);
    near(record.events[0].timestampNs, record.timestampA * 1e9, 1e-3);
  }
});

test('Worker Bell jobs independently randomize settings, retain all four datasets and approach the singlet CHSH value', () => {
  const count = 80_000;
  const datasets = runJob({ type: 'bell', count, seed: 401 });
  assert.equal(datasets.length, 4);
  assert.equal(datasets.reduce((total, dataset) => total + dataset.total, 0), count);
  assert.deepEqual(datasets.map(dataset => [dataset.settings.a, dataset.settings.b]), [[0, 22.5], [0, -22.5], [45, 22.5], [45, -22.5]]);
  for (const dataset of datasets) {
    near(dataset.total, count / 4, 5 * Math.sqrt(count * 0.25 * 0.75));
    assert.equal(dataset.records.length, dataset.total);
    assert.equal(dataset.events.length, 2 * dataset.total);
    assert.ok(dataset.records.every(record => record.a === dataset.settings.a && record.b === dataset.settings.b));
  }
  const ids = new Set(datasets.flatMap(dataset => dataset.records.map(record => record.id)));
  assert.equal(ids.size, count, 'Every independent setting trial must consume one fresh pair');
  const summary = bellSummary(datasets);
  near(summary.s, 2 * Math.SQRT2, 0.04);
  summary.values.forEach((value, i) => near(value.e, i < 3 ? -Math.SQRT1_2 : Math.SQRT1_2, 0.03));
  assert.ok(summary.se > 0 && summary.se < 0.02);
  const aliceFirst = datasets[0].total + datasets[1].total;
  const bobFirst = datasets[0].total + datasets[2].total;
  const covariance = datasets[0].total / count - aliceFirst / count * bobFirst / count;
  near(covariance, 0, 0.005);
});

test('Worker QKD maps the attacker fraction into Born measurement; revealed test bits never enter retained candidates', () => {
  const count = 40_000;
  const clean = runJob({ type: 'qkd', count, eve: 0, seed: 1003 });
  const attacked = runJob({ type: 'qkd', count, eve: 1, seed: 1003 });
  assert.equal(clean.pairs, count);
  assert.equal(clean.intercepted, 0);
  assert.equal(clean.qber, 0);
  assert.equal(clean.aliceKey, clean.bobKey);
  assert.equal(attacked.intercepted, count);
  near(attacked.qber, 0.25, 0.03);
  near(attacked.siftedQber, 0.25, 0.02);
  assert.notEqual(attacked.aliceKey, attacked.bobKey);
  for (const result of [clean, attacked]) {
    near(result.siftedCount / count, 0.5, 0.015);
    assert.equal(result.records.length, count);
    assert.equal(result.disclosedCount, Math.ceil(result.siftedCount * 0.2));
    assert.equal(result.retained + result.disclosedCount, result.siftedCount);
    const undisclosed = result.records.filter(record => record.sifted && !record.disclosed);
    assert.equal(undisclosed.length, result.retained);
    assert.equal(result.aliceKey, undisclosed.map(record => record.bitA).join(''));
    assert.equal(result.bobKey, undisclosed.map(record => record.bitB).join(''));
    assert.ok(result.publicSample.every(bit => result.records[bit.id].disclosed));
    assert.ok(result.keyStatus.includes('no secure key established'));
    near(result.records[1].emittedAt, 1e-6, 1e-15);
    near(result.records[1].events[0].timestampNs, (1e-6 + 1.8 / SPEED_OF_LIGHT) * 1e9, 1e-9);
  }
});

test('Worker replay of saved seed and job settings reproduces outcomes and timestamps exactly', () => {
  const job = { count: 321, seed: 229, startId: 100, settings: { ...settings, a: 11, b: -37, visibility: 0.6 } };
  const first = runJob(job);
  const second = runJob(job);
  assert.deepEqual(second, first);
  const different = runJob({ ...job, seed: 230 });
  assert.notDeepEqual(different.records.map(record => record.outcomeKey), first.records.map(record => record.outcomeKey));
  assert.deepEqual(different.records.map(record => record.timestampA), first.records.map(record => record.timestampA));
});

test('Worker angle sweeps retain separate source/noise/basis groups instead of fabricating a curve', () => {
  const datasets = runJob({ type: 'sweep', count: 300, seed: 45, settings: { ...settings, a: 45, source: 'classical', visibility: 0.5 } });
  assert.equal(datasets.length, 19);
  datasets.forEach((dataset, index) => {
    assert.equal(dataset.total, 300);
    assert.equal(dataset.settings.b, index * 10);
    assert.equal(dataset.settings.a, 45);
    assert.equal(dataset.settings.source, 'classical');
    assert.equal(dataset.settings.visibility, 0.5);
    assert.equal(dataset.records.length, 300);
    assert.ok(dataset.records.every(record => record.b === index * 10));
  });
});
