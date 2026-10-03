import test from 'node:test';
import assert from 'node:assert/strict';
import { createMeasurement, MeasurementStore } from '../src/measurement.js';
import { MeasurementDirector } from '../src/director.js';
import { STAGES, stageCaption } from '../src/stages.js';

test('Ten structured stages contain real targets, cutaways, equations and presenter micro-events', () => {
  assert.equal(STAGES.length, 10);
  assert.ok(STAGES.every(stage => stage.id && stage.headline && stage.caption && stage.details && stage.target && stage.microEvents.length >= 3 && stage.duration > 0));
  assert.equal(STAGES[4].cutaway, 'pbs');
  assert.equal(STAGES[6].cutaway, 'detector');
  assert.ok(stageCaption(STAGES[7], { a: 0, b: 45 }).includes('not guaranteed'));
  assert.ok(Object.isFrozen(STAGES) && Object.isFrozen(STAGES[6].microEvents));
});

test('Pause inside PBS shows coherent branches before destructive absorption or any committed detector record', () => {
  const record = createMeasurement({ a: 0, b: 0 }), store = new MeasurementStore();
  const director = new MeasurementDirector(record, { onCommit: event => store.commit(event) });
  director.goToStage(5);
  director.seek(director.starts[5] + director.durations[5] * 0.5);
  const before = director.state;
  assert.equal(before.phase, 'coherent-polarization-path');
  assert.equal(before.originalPairAvailable, true);
  assert.equal(before.detectionsVisible, false);
  assert.equal(before.recordVisible, false);
  assert.equal(store.total, 0);
  director.pause(); director.update(999);
  assert.equal(director.state.time, before.time);
});

test('Detector micro-steps separate absorption, acceleration, avalanche, pulse, and quench; first absorption destroys original pair availability', () => {
  const record = createMeasurement({ a: 0, b: 0 }, { opticalDelayNs: 50 }), director = new MeasurementDirector(record);
  director.goToStage(6);
  assert.equal(director.state.detectionsVisible, false);
  director.microStep();
  assert.ok(director.state.microLabel.includes('absorption'));
  assert.equal(director.state.phase, 'detection-recorded');
  assert.equal(director.state.originalPairAvailable, false);
  assert.deepEqual(director.state.detectedArms, ['A']);
  assert.equal(director.state.recordVisible, false);
  director.microStep(); assert.ok(director.state.microLabel.includes('accelerates'));
  director.microStep(); assert.ok(director.state.microLabel.includes('avalanche'));
  director.microStep(); assert.ok(director.state.microLabel.includes('pulse'));
  director.microStep(); assert.ok(director.state.microLabel.includes('Quench'));
  director.goToStage(7);
  assert.deepEqual(director.state.detectedArms, ['A', 'B']);
  assert.equal(director.state.jointOutcomeVisible, true);
});

test('Both simultaneous physical detections occur before partner camera shot; readout is later and commits exactly once', () => {
  const record = createMeasurement({ a: 45, b: 45 }), store = new MeasurementStore();
  const director = new MeasurementDirector(record, { onCommit: event => store.commit(event) });
  director.goToStage(6); director.microStep();
  assert.deepEqual(director.state.detectedArms, ['A', 'B']);
  assert.equal(store.total, 0);
  director.goToStage(8);
  assert.equal(director.state.recordVisible, false);
  director.seek(director.starts[8] + director.durations[8]);
  assert.equal(director.state.recordVisible, true);
  assert.deepEqual(director.state.readoutsVisible, ['A', 'B']);
  assert.equal(store.total, 1);
  director.seek(director.duration);
  assert.equal(store.total, 1);
});

test('Replay, backward/forward scrub, loop, speed and presentation controls never resample or double-commit an event', () => {
  const record = createMeasurement({ a: 0, b: 22.5 }, { seed: 555 }), saved = JSON.stringify(record);
  let commits = 0;
  const director = new MeasurementDirector(record, { onCommit: () => commits++ });
  director.seek(director.duration);
  assert.equal(commits, 1);
  director.replay();
  assert.equal(director.state.replay, true);
  assert.equal(director.state.detectionsVisible, false);
  assert.equal(director.state.recordVisible, false);
  director.setSpeed(8); director.setPauseAtStages(false); director.play();
  for (let i = 0; i < 150; i++) director.update(0.1);
  director.seek(1); director.seek(director.duration);
  director.goToStage(8); director.setLoopCurrentStage(true); director.play(); director.update(40);
  director.setLoopCurrentStage(false); director.seek(director.duration);
  assert.equal(commits, 1);
  assert.equal(JSON.stringify(record), saved);
});

test('Different render frame rates reach the same model event, commit, and timestamps', () => {
  const record = createMeasurement({ a: 13, b: -19 }, { seed: 87, delayNs: 18, jitterNs: 0.2 });
  const results = [];
  for (const dt of [1 / 24, 1 / 60, 0.7]) {
    let commits = 0;
    const director = new MeasurementDirector(record, { pauseAtStages: false, paused: false, onCommit: () => commits++ });
    for (let t = 0; t < director.duration + 1; t += dt) director.update(dt);
    results.push({ commits, detections: director.state.detectedArms, timestamps: director.record.readoutTimestampsNs, outcomes: director.record.outcomes });
  }
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[1], results[2]);
  assert.equal(results[0].commits, 1);
});

test('Guided autoplay pauses each stage; Next starts a stage and changing hold duration preserves stage progress', () => {
  const director = new MeasurementDirector(createMeasurement());
  director.play(); director.update(100);
  assert.equal(director.state.paused, true);
  assert.equal(director.state.stageIndex, 0);
  assert.equal(director.state.stageProgress, 1);
  director.nextStage();
  assert.equal(director.state.stageIndex, 1);
  assert.equal(director.state.paused, false);
  director.update(100);
  assert.equal(director.state.stageIndex, 1);
  assert.equal(director.state.paused, true);
  director.goToStage(4); director.seek(director.starts[4] + director.durations[4] / 2);
  director.setStageDuration(4, 20);
  assert.equal(director.state.stageIndex, 4);
  assert.equal(director.state.stageProgress, 0.5);
  assert.throws(() => director.setSpeed(0), /positive/);
  assert.throws(() => director.seek(NaN), /finite/);
});
