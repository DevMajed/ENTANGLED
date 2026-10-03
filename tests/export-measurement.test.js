import test from 'node:test';
import assert from 'node:assert/strict';
import { createMeasurementExport } from '../src/export.js';
import { createMeasurement, MeasurementStore, runMeasurements } from '../src/measurement.js';

test('measurement export preserves committed runs, captured bases, per-record seeds and replay deduplication', () => {
  const store = new MeasurementStore();
  const queued = { source: 'entangled', a: 0, b: 0 };
  const first = createMeasurement(queued, { seed: 27, id: 1, runId: 'same-bases' });
  const second = createMeasurement(queued, { seed: 91, id: 2, runId: 'same-bases' });
  assert.equal(store.commit(first), true);
  assert.equal(store.commit(first), false); // A rewind/replay is still the same measured pair.
  store.commit(second);
  queued.a = 45; queued.b = 45;
  const third = createMeasurement(queued, { seed: 44, id: 3, runId: 'rotated-bases' });
  store.commit(third);
  queued.b = 0; // Queued future settings never alter captured records or theoretical data.

  const exported = JSON.parse(JSON.stringify(createMeasurementExport({ store, seed: 12 })));
  assert.equal(exported.format, 'ENTANGLED/2');
  assert.equal(exported.groups.total, 3);
  assert.equal(exported.groups.groups.length, 2);
  const [hv, da] = exported.groups.groups;
  assert.deepEqual([hv.settings.a, hv.settings.b], [0, 0]);
  assert.deepEqual([da.settings.a, da.settings.b], [45, 45]);
  assert.deepEqual(hv.records.map(record => record.seed), [27, 91]);
  assert.deepEqual(hv.records.map(record => record.commitId), [first.commitId, second.commitId]);
  assert.deepEqual(hv.counts, store.snapshot().groups[0].counts);
  assert.deepEqual(hv.jointProbabilities, first.jointProbabilities);
  assert.deepEqual(da.polarizationPathState, JSON.parse(JSON.stringify(third.polarizationPathState)));
  assert.equal(hv.records[0].settings, undefined);
  assert.deepEqual(exported.recordSchema.inheritedFromGroup, ['settings', 'jointProbabilities', 'polarizationPathState']);
  for (const key of ['bellDatasets', 'qkdResult', 'signalRuns', 'sweepData']) assert.equal(Object.hasOwn(exported, key), false);
});

test('all detector events and absolute-time aliases keep explicit seconds versus nanoseconds', () => {
  const store = new MeasurementStore();
  const record = createMeasurement({ a: 12, b: 39 }, { seed: 8, id: 71, runId: 'timing',
    emissionTimeNs: 2_000_000, delayNs: -17, opticalDelayNs: 3, jitterNs: .2, readoutLatencyNs: 33, windowNs: 8 });
  store.commit(record);
  const exported = JSON.parse(JSON.stringify(createMeasurementExport({ store, seed: 8, timing: record.timing })));
  const actual = exported.groups.groups[0].records[0];
  assert.equal(exported.units.emittedAt, 'seconds');
  assert.equal(exported.units.modelDetectionTimes, 'nanoseconds');
  assert.equal(exported.units.readoutTimestamps, 'nanoseconds');
  for (const key of exported.units.secondsFields) assert.equal(actual[key], record[key]);
  assert.equal(actual.emittedAt * 1e9, actual.emissionTimeNs);
  for (const side of ['a', 'b']) {
    assert.equal(actual[`timestamp${side.toUpperCase()}`], actual.readoutTimestampsNs[side] / 1e9);
    assert.equal(actual.absorptionTimesNs[side], actual.modelDetectionTimesNs[side]);
  }
  assert.deepEqual(actual.events, record.events);
  assert.deepEqual(actual.timing, record.timing);
  assert.deepEqual(actual.detectors, record.detectors);
  assert.deepEqual(actual.outcomes, record.outcomes);
  assert.ok(exported.units.nanosecondsFields.includes('events[].timestampNs'));
  assert.ok(exported.units.nanosecondsFields.includes('events[].modelDetectionTimeNs'));
  assert.match(exported.units.coincidenceWindow, /Total width W/);
});

test('export is a detached snapshot including caption edits and panel layout, without changing the store', () => {
  const store = new MeasurementStore();
  const record = createMeasurement({}, { id: 1, seed: 70 }); store.commit(record);
  const timing = { delayNs: 12, sourceRate: 1_000 };
  const captionOverrides = { pbs: { headline: 'My caption', captions: ['First.', 'Second.'], hold: 4 } };
  const layout = { version: 1, allHidden: true, panels: { caption: { x: 503, y: 105, locked: true, visible: true } } };
  const before = JSON.stringify(store.snapshot());
  const exported = createMeasurementExport({ store, seed: 70, timing, captionOverrides, layout });
  assert.equal(JSON.stringify(store.snapshot()), before);
  assert.deepEqual(exported.captionOverrides, captionOverrides);
  assert.deepEqual(exported.layout, layout);
  timing.delayNs = 90; captionOverrides.pbs.captions[0] = 'Changed later'; layout.panels.caption.x = 0;
  store.commit(createMeasurement({}, { id: 2, seed: 70 }));
  assert.equal(exported.groups.total, 1);
  assert.equal(exported.timing.delayNs, 12);
  assert.equal(exported.captionOverrides.pbs.captions[0], 'First.');
  assert.equal(exported.layout.panels.caption.x, 503);
  exported.groups.groups[0].records[0].events[0].timestampNs = -999;
  exported.groups.groups[0].polarizationPathState.components[0].amplitudes[0].re = 999;
  assert.deepEqual(store.snapshot().groups[0].records[0], record);
});

test('large logs serialize shared coherent state once per group while keeping every measured pair', () => {
  const batch = runMeasurements({ a: 17, b: 59, visibility: .85 }, { count: 1_000, seed: 26, runId: 'large-log' });
  const store = new MeasurementStore(); store.commitBatch(batch);
  const exported = createMeasurementExport({ store, seed: 26 });
  const text = JSON.stringify(exported);
  assert.equal(exported.groups.groups[0].records.length, 1_000);
  assert.equal((text.match(/"polarizationPathState":/g) ?? []).length, 1);
  assert.equal((text.match(/"settings":/g) ?? []).length, 1);
  for (let i = 0; i < 1_000; i++) {
    const record = exported.groups.groups[0].records[i];
    assert.equal(record.commitId, batch.records[i].commitId);
    assert.deepEqual(record.events, batch.records[i].events);
    assert.equal(Object.hasOwn(record, 'jointProbabilities'), false);
    assert.equal(Object.hasOwn(record, 'polarizationPathState'), false);
  }
  // A white-noise state has several 16-component vectors; repeating those scales badly.
  assert.ok(text.length < JSON.stringify(store.snapshot()).length / 2);
});
