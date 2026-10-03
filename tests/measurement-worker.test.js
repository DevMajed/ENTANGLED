import test from 'node:test';
import assert from 'node:assert/strict';
let outputs = [];
globalThis.self = { postMessage: message => outputs.push(message.result ? structuredClone(message) : message) };
await import('../src/measurement-worker.js');

test('New worker completes100k model events, timestamp-matches all ideal pairs, and reports progress without creating visuals', () => {
  outputs = [];
  const job = { id: 22, count: 100_000, settings: { source: 'entangled', state: 'singlet', a: 45, b: 45, visibility: 1 },
    seed: 881, startId: 1, runId: 'worker-run', timing: { sourceRate: 1_000, delayNs: 12, jitterNs: 0, windowNs: 4 } };
  self.onmessage({ data: job });
  const message = outputs.at(-1);
  assert.equal(message.id, 22);
  assert.ok(!message.error, message.error);
  const result = message.result;
  assert.equal(result.total, 100_000);
  assert.equal(result.records.length, 100_000);
  assert.equal(result.events.length, 200_000);
  assert.equal(result.coincidences.matches.length, 100_000);
  assert.equal(result.coincidences.ambiguous.length, 0);
  assert.equal(result.counts['++'], 0);
  assert.equal(result.counts['--'], 0);
  assert.equal(result.counts['+-'] + result.counts['-+'], 100_000);
  assert.equal(new Set(result.records.map(record => record.commitId)).size, 100_000);
  assert.ok(outputs.slice(0, -1).every(message => message.id === 22 && message.progress > 0 && message.progress <= job.count));
  assert.equal(outputs.at(-2).progress, job.count);
  assert.equal(outputs.at(-2).fraction, 1);
  assert.ok(message.elapsedMs > 0);
  // Batch payload shares one coherent model instead of allocating a matrix per pair.
  assert.equal(result.records[0].polarizationPathState, result.records[99_999].polarizationPathState);
  assert.equal(result.records[0].settings, result.records[99_999].settings);
  assert.equal(result.timing.histogram.length, 1);
});

test('New worker rejects an invalid job rather than returning fabricated measurements', () => {
  outputs = [];
  self.onmessage({ data: { id: 23, count: -1, settings: {}, seed: 1, runId: 'bad', timing: {} } });
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].id, 23);
  assert.ok(outputs[0].error.includes('positive integer'));
});
