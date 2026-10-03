import test from 'node:test';
import assert from 'node:assert/strict';
import { jointProbabilities, densityMatrix } from '../src/physics.js';
import { singlePBSIsometry, coherentPBSState, traceOutPath, normSquared, createMeasurement,
  timestampMatcher, MeasurementStore, measurementStatistics, runMeasurements } from '../src/measurement.js';

function near(actual, expected, tolerance = 1e-12) { assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} expected ${expected} ± ${tolerance}`); }

test('Ideal PBS is an explicit coherent norm-preserving isometry, including relative reflection phase', () => {
  const h = singlePBSIsometry([1, 0]);
  assert.deepEqual(h.map(value => value.re), [1, 0, 0, 0]);
  const v = singlePBSIsometry([0, 1]);
  assert.deepEqual(v.map(value => value.re), [0, 0, 0, 1]);
  const diagonal = singlePBSIsometry([Math.SQRT1_2, Math.SQRT1_2], Math.PI / 2);
  near(normSquared(diagonal), 1);
  near(diagonal[0].re, Math.SQRT1_2);
  near(diagonal[3].im, Math.SQRT1_2);
  assert.ok(diagonal[0].re !== 0 && diagonal[3].im !== 0, 'D remains amplitudes in both modes, not a sampled route');
});

test('HWP-plus-PBS pair map preserves singlet coherence and norm across analyzer angles', () => {
  for (const a of [-90, -22.5, 0, 17, 45, 89]) for (const b of [-45, 0, 22.5, 45, 90]) {
    const state = coherentPBSState({ a, b });
    near(state.norm, 1);
    assert.equal(state.kind, 'coherent-pure-state');
    const indices = { '++': 0, '+-': 3, '-+': 12, '--': 15 }, p = jointProbabilities({ a, b });
    for (const key of Object.keys(indices)) {
      const amplitude = state.amplitudes[indices[key]];
      near(amplitude.re ** 2 + amplitude.im ** 2, p[key]);
    }
    near(state.branchWeights.a.transmitted, 0.5);
    near(state.branchWeights.b.reflected, 0.5);
  }
  const state = coherentPBSState({ a: 0, b: 0 });
  near(state.amplitudes[3].re, Math.SQRT1_2);
  near(state.amplitudes[12].re, -Math.SQRT1_2);
  const source = densityMatrix();
  near(source[1][2].re, -0.5);
  near(state.amplitudes[3].re * state.amplitudes[12].re, -0.5);
  const ignoredPath = traceOutPath(state);
  near(ignoredPath[1][1].re, 0.5);
  near(ignoredPath[2][2].re, 0.5);
  near(ignoredPath[1][2].re, 0);
});

test('Classical mixture and depolarization remain density mixtures rather than counterfeit coherent singlets', () => {
  for (const source of ['entangled', 'classical']) for (const visibility of [0, 0.6, 1]) {
    const state = coherentPBSState({ source, visibility, a: 31, b: -18 });
    near(state.norm, 1);
    if (source === 'classical' || visibility < 1) assert.equal(state.amplitudes, null);
    const probabilities = jointProbabilities({ source, visibility, a: 31, b: -18 });
    for (const [key, index] of Object.entries({ '++': 0, '+-': 3, '-+': 12, '--': 15 })) {
      const weight = state.components.reduce((total, component) => total + component.weight * normSquared([component.amplitudes[index]]), 0);
      near(weight, probabilities[key]);
    }
  }
  assert.deepEqual(coherentPBSState({ source: 'correlated', state: 'phi+' }), coherentPBSState({ source: 'classical', state: 'phiPlus' }));
  assert.deepEqual(coherentPBSState({ source: 'quantum', state: 'psi-' }), coherentPBSState({ source: 'entangled', state: 'singlet' }));
  assert.throws(() => coherentPBSState({}, { phase: NaN }), /finite/);
});

test('Immutable measurement captures settings, outcome, exactly two detector events and distinct model/readout times', () => {
  const settings = { a: 0, b: 0 }, record = createMeasurement(settings, { seed: 92, id: 2, runId: 'demo', delayNs: 12 });
  settings.a = 45;
  assert.equal(record.settings.a, 0);
  assert.equal(record.commitId, 'demo:2');
  assert.equal(record.outcomeA, -record.outcomeB);
  assert.equal(record.events.length, 2);
  assert.deepEqual(record.events.map(event => event.arm), ['A', 'B']);
  assert.equal(new Set(record.events.map(event => event.channel)).size, 2);
  assert.ok(record.modelReadoutTimesNs.a > record.modelDetectionTimesNs.a);
  assert.ok(record.modelReadoutTimesNs.b > record.modelDetectionTimesNs.b);
  near(record.readoutTimestampsNs.b - record.readoutTimestampsNs.a, 12, 1e-7);
  assert.ok(Object.isFrozen(record) && Object.isFrozen(record.settings) && Object.isFrozen(record.events[0]));
  assert.throws(() => { record.outcomeA = 17; }, TypeError);
});

test('Electronic delay and independently simulated jitter shift timestamps without changing polarization outcomes or absorption', () => {
  for (let id = 1; id < 101; id++) {
    const options = { seed: 781, id, runId: 'timing' };
    const ideal = createMeasurement({ a: 0, b: 22.5 }, { ...options, delayNs: 0 });
    const delayed = createMeasurement({ a: 0, b: 22.5 }, { ...options, delayNs: 100 });
    const noisy = createMeasurement({ a: 0, b: 22.5 }, { ...options, delayNs: 100, jitterNs: 2 });
    assert.deepEqual(ideal.outcomes, delayed.outcomes);
    assert.deepEqual(ideal.outcomes, noisy.outcomes);
    assert.deepEqual(ideal.modelDetectionTimesNs, delayed.modelDetectionTimesNs);
    assert.deepEqual(delayed.modelDetectionTimesNs, noisy.modelDetectionTimesNs);
    near(delayed.readoutTimestampsNs.b - ideal.readoutTimestampsNs.b, 100, 1e-7);
    assert.notDeepEqual(delayed.readoutTimestampsNs, noisy.readoutTimestampsNs);
  }
});

test('Timestamp matcher uses observed channels/times, inclusive full-width convention, and no ground-truth IDs', () => {
  const events = [
    { channel: 'A+', timestampNs: 100, debugPairId: 'wrong-1' },
    { channel: 'B-', timestampNs: 116, debugPairId: 'wrong-2' },
    { channel: 'A-', timestampNs: 1_000, debugPairId: 'same' },
    { channel: 'B+', timestampNs: 1_008, debugPairId: 'different' },
  ];
  const result = timestampMatcher(events.reverse(), { delayNs: 12, windowNs: 8 });
  assert.equal(result.matches.length, 2); // +4 and -4 ns lie on the total-width boundary.
  assert.deepEqual(result.matches.map(match => match.outcomeKey), ['+-', '-+']);
  assert.equal(result.usesDebugPairIds, false);
  const changedIds = events.map((event, i) => ({ ...event, debugPairId: 77, pairId: 123 + i }));
  assert.deepEqual(timestampMatcher(changedIds, { delayNs: 12, windowNs: 8 }).matches.map(match => [match.a.channel, match.b.channel, match.deltaTimeNs]),
    result.matches.map(match => [match.a.channel, match.b.channel, match.deltaTimeNs]));
  const outside = timestampMatcher([{ channel: 'A+', timestampNs: 0 }, { channel: 'B-', timestampNs: 16.01 }], { delayNs: 12, windowNs: 8 });
  assert.equal(outside.matches.length, 0);
  assert.equal(outside.unmatchedA.length, 1);
  assert.equal(outside.unmatchedB.length, 1);
});

test('Timestamp ambiguity and invalid channels are reported, not secretly truth-paired or removed', () => {
  const result = timestampMatcher([
    { channel: 'A+', timestampNs: 0, pairId: 1 }, { channel: 'A-', timestampNs: 1, pairId: 2 },
    { channel: 'B-', timestampNs: 12, pairId: 1 }, { channel: 'B+', timestampNs: 13, pairId: 2 },
    { channel: 'SOURCE', timestampNs: 1 },
  ], { delayNs: 12, windowNs: 8 });
  assert.equal(result.matches.length, 0);
  assert.equal(result.ambiguous.length, 2);
  assert.equal(result.unmatchedB.length, 2);
  assert.equal(result.invalid.length, 1);
});

test('Unique commits survive replay/deduplication, partition run/settings, and reset independently of layout', () => {
  const store = new MeasurementStore();
  const first = createMeasurement({ a: 0, b: 0 }, { id: 1, runId: 'run-a' });
  assert.equal(store.commit(first), true);
  assert.equal(store.commit(first), false);
  store.commit(createMeasurement({ a: 45, b: 45 }, { id: 2, runId: 'run-a' }));
  store.commit(createMeasurement({ a: 0, b: 0 }, { id: 1, runId: 'run-b' }));
  assert.equal(store.total, 3);
  assert.equal(store.groups.size, 3);
  assert.equal(measurementStatistics([...store.groups.values()][0]).correlation, -1);
  assert.equal(measurementStatistics(null).correlation, null);
  const batch = runMeasurements({ a: 0, b: 45 }, { count: 200, runId: 'batch', seed: 41 });
  assert.equal(store.commitBatch(batch), 200);
  assert.equal(store.commitBatch(batch), 0);
  assert.equal(store.total, 203);
  assert.equal(first.a, 0);
  const workerClonedRecord = structuredClone(createMeasurement({ a: 0, b: 0 }, { id: 3, runId: 'from-worker' }));
  assert.equal(Object.isFrozen(workerClonedRecord), false);
  store.commit(workerClonedRecord);
  assert.ok(Object.isFrozen(workerClonedRecord.settings));
  assert.throws(() => { workerClonedRecord.settings.a = 90; }, TypeError);
  store.reset();
  assert.equal(store.total, 0);
  assert.equal(store.groups.size, 0);
});

test('Fixed-seed measurement runs follow analytic frequencies at 5σ and preserve sharp honest zero-jitter timing', () => {
  const count = 30_000, settings = { a: 13, b: 51 }, batch = runMeasurements(settings, { count, seed: 213, runId: 'frequencies' });
  const p = jointProbabilities(settings);
  for (const key of Object.keys(p)) near(batch.counts[key] / count, p[key], 5 * Math.sqrt(p[key] * (1 - p[key]) / count));
  assert.equal(batch.coincidences.matches.length, count);
  assert.equal(batch.coincidences.ambiguous.length, 0);
  assert.deepEqual(batch.matchedCounts, batch.counts);
  assert.equal(batch.timing.histogram.length, 1);
  assert.equal(batch.timing.histogram[0].count, count);
  near(batch.timing.histogram[0].deltaTimeNs, 12, 1e-6);
  const repeated = runMeasurements(settings, { count: 20, seed: 213, runId: 'frequencies' });
  assert.deepEqual(repeated.records, batch.records.slice(0, 20));
});
