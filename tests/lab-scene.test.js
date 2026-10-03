import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { LabScene } from '../src/lab-scene.js';
import { createEmission, measurePair, seededRng } from '../src/physics.js';
import { createMeasurement } from '../src/measurement.js';

// Isolate the playback controller from WebGL: this verifies record timing and
// camera independence, while the actual optical geometry is checked in-browser.
function harness() {
  const lab = Object.create(LabScene.prototype);
  const observed = [];
  const phases = [];
  const noop = () => {};
  Object.assign(lab, {
    _disposed: false, _reducedMotion: false, _cameraFlight: null, _ownedGeometries: new Set(),
    guidedCamera: true, cameraTransition: 1.4, onCameraOverride: noop, worldLabels: [], pbs: {},
    paused: false, speed: 1, elapsed: 0, maxPairs: 36,
    pairs: [], analyzers: {}, scene: new THREE.Scene(),
    materials: { neutral: new THREE.MeshBasicMaterial() },
    glowTexture: new THREE.Texture(),
    splitProgress: 0.72, analyzerProgress: 0.48, measurementProgress: 1,
    onPhase: event => phases.push(event), onMeasurement: record => observed.push(record), onInspect: noop,
    _positionPair: noop,
    container: { clientWidth: 1600, clientHeight: 900 },
    sourcePosition: new THREE.Vector3(-4.5, 1.58, 0),
    camera: { position: new THREE.Vector3(10, 8, 10), aspect: 1, updateProjectionMatrix: noop },
    controls: { target: new THREE.Vector3(), update: noop },
    renderer: { render: noop, setSize: noop },
    sourceGlow: { material: { opacity: 0.36 }, scale: { setScalar: noop } },
    selectionHalo: { visible: false, position: new THREE.Vector3(), material: { opacity: 0 } },
    components: new Map([['source', {
      id: 'source', title: 'Source', description: 'Schematic source',
      target: new THREE.Vector3(-4.5, 1.58, 0), cameraOffset: new THREE.Vector3(2, 1, 2),
    }]]),
    detectors: new Map(), taggerLeds: Array.from({ length: 4 }, () => ({ pulse: 0, color: 0, material: { color: { set: noop } } })),
  });
  for (const arm of ['a', 'b']) for (const port of ['plus', 'minus']) {
    lab.detectors.set(`detector-${arm}-${port}`, {
      pulse: 0, color: 0, arm, outcome: port === 'plus' ? 1 : -1, position: new THREE.Vector3(),
      flash: { material: { opacity: 0 } }, traceMaterial: { opacity: 0 },
      sensor: { material: { emissiveIntensity: 0.2 } }, indicatorMaterial: { color: { set: noop } },
    });
  }
  return { lab, observed, phases };
}

function deferred(id = 1, onDraw = () => {}, rng = seededRng(451)) {
  const emission = createEmission({ id, source: 'entangled', emissionTimeNs: id * 100 });
  return { ...emission, measure() {
    onDraw();
    return measurePair(emission, { a: 0, b: 22.5 }, rng);
  } };
}

test('Playback emits no outcome before absorption, including coherent PBS output propagation', () => {
  const { lab, observed, phases } = harness();
  let draws = 0;
  assert.equal(lab.launchPair(deferred(1, () => draws++), { duration: 3 }), true);
  const pair = lab.pairs[0];
  assert.equal(pair.record.outcomeA, undefined);
  lab._advancePair(pair, 0.71);
  assert.equal(draws, 0);
  lab._advancePair(pair, 0.28);
  assert.equal(draws, 0);
  assert.equal(observed.length, 0);
  assert.equal(pair.measured, false);
  assert.ok(phases.some(event => event.phase === 'amplitudes'));
  lab._advancePair(pair, 0.01);
  assert.equal(draws, 1);
  assert.equal(observed.length, 1);
  assert.equal(pair.record.measure, undefined);
  assert.ok([1, -1].includes(observed[0].outcomeA));
  lab.reset();
});

function timelineHarness() {
  const result = harness(), { lab } = result;
  lab.guidedCamera = false;
  lab.armZ = 2.72; lab.pbsX = 1.85; lab.detectorOffset = 2.9;
  lab.paths = {};
  for (const arm of ['a', 'b']) {
    const sign = arm === 'a' ? -1 : 1;
    const prefix = [lab.sourcePosition.clone(), new THREE.Vector3(-2.47, 1.58, sign * 2.72), new THREE.Vector3(-0.63, 1.58, sign * 2.72), new THREE.Vector3(1.85, 1.58, sign * 2.72)];
    lab.paths[arm] = { prefix, plus: [...prefix, new THREE.Vector3(4.75, 1.58, sign * 2.72)], minus: [...prefix, new THREE.Vector3(1.85, 1.58, sign * 5.62)], prefixLength: 7.71, totalLength: 10.61 };
  }
  lab._buildTimelineVisual();
  return result;
}

test('External timeline seek, rewind, and replay never sample or invoke record callbacks', () => {
  const { lab, observed, phases } = timelineHarness();
  const record = createMeasurement({ a: 0, b: 22.5 }, { seed: 682, id: 1 });
  const before = JSON.stringify(record);
  for (const stageIndex of [0, 4, 6, 8, 9, 2, 4, 6, 8, 9]) {
    lab.setTimelineState({ stageIndex, stageProgress: 0.70, time: stageIndex * 8 + 5.6, record, paused: true,
      detectionsVisible: stageIndex >= 6, detectedArms: stageIndex >= 6 ? ['A', 'B'] : [], replay: true });
    lab.update(0.2);
  }
  assert.equal(observed.length, 0);
  assert.equal(phases.length, 0);
  assert.equal(JSON.stringify(record), before);
});

test('Paused external snapshots freeze wave geometry, pulses, source illumination, and detector state', () => {
  const { lab } = timelineHarness();
  const record = createMeasurement({ a: 45, b: 45 }, { seed: 73 });
  lab.setTimelineState({ stageIndex: 5, stageProgress: 0.56, time: 47.2, record, detectionsVisible: false, paused: true });
  const visual = () => ({
    waves: Object.values(lab.timelineVisual.lines).flatMap(lines => Object.values(lines).map(line => Array.from(line.geometry.attributes.position.array))),
    source: lab.sourceGlow.material.opacity, elapsed: lab.elapsed,
    detectors: [...lab.detectors.values()].map(detector => ({ pulse: detector.pulse, flash: detector.flash.material.opacity, trace: detector.traceMaterial.opacity })),
  });
  const pausedSnapshot = visual();
  for (let i = 0; i < 180; i++) lab.update(1 / 24);
  assert.deepEqual(visual(), pausedSnapshot);
  assert.ok([...lab.detectors.values()].every(detector => detector.lastRecord === undefined));
});

test('Destructive timeline absorption reveals exactly the two model-selected detectors, never earlier', () => {
  const { lab, observed } = timelineHarness();
  const record = createMeasurement({ a: 0, b: 0 }, { seed: 93 });
  lab.setTimelineState({ stageIndex: 6, stageProgress: 0.11, time: 49, record, detectionsVisible: false, paused: true });
  assert.ok([...lab.detectors.values()].every(detector => detector.lastRecord === undefined));
  lab.setTimelineState({ stageIndex: 6, stageProgress: 0.12, time: 49.2, record, detectionsVisible: true, detectedArms: ['A', 'B'], paused: true });
  assert.equal([...lab.detectors.values()].filter(detector => detector.lastRecord).length, 2);
  for (const arm of ['a', 'b']) assert.equal(lab.detectors.get(`detector-${arm}-${record.outcomes[arm] === 1 ? 'plus' : 'minus'}`).lastRecord, record);
  assert.equal(observed.length, 0, 'The director/event store owns committing observations');
});

test('Prepared H/V/D PBS inspector is isolated and restores exact paused pair and camera context', () => {
  const { lab, observed } = timelineHarness();
  const record = createMeasurement({ a: 12, b: 38 }, { seed: 973 });
  const state = { stageIndex: 4, stageProgress: 0.62, time: 37.8, record, detectionsVisible: false, paused: true, replay: false };
  lab.setTimelineState(state);
  const position = lab.camera.position.clone(), target = lab.controls.target.clone();
  const originalWaves = Object.values(lab.timelineVisual.lines.a).map(line => Array.from(line.geometry.attributes.position.array));
  for (const [input, transmitted, reflected] of [['H', 1, 0], ['V', 0, 1], ['D', 0.5, 0.5]]) {
    const example = lab.testPBS(input);
    assert.ok(Math.abs(example.transmittedProbability - transmitted) < 1e-12);
    assert.ok(Math.abs(example.reflectedProbability - reflected) < 1e-12);
    assert.equal(example.contributionToExperiment, 0);
  }
  lab.camera.position.set(50, 50, 50);
  lab.controls.target.set(5, 5, 5);
  assert.equal(lab.closePBSInspector(), true);
  assert.deepEqual(lab.camera.position, position);
  assert.deepEqual(lab.controls.target, target);
  assert.deepEqual(lab.timelineState, state);
  assert.equal(lab.paused, true);
  assert.equal(lab.timelineState.record, record);
  assert.deepEqual(Object.values(lab.timelineVisual.lines.a).map(line => Array.from(line.geometry.attributes.position.array)), originalWaves);
  assert.equal(observed.length, 0);
});

test('Guided camera runs only on stage transitions and remains released until explicitly resumed', () => {
  const { lab } = timelineHarness();
  const shots = [];
  lab._stageCamera = state => shots.push(state.stageIndex);
  lab.guidedCamera = true;
  lab.setTimelineState({ stageIndex: 0, stageProgress: 0, paused: true });
  lab.setTimelineState({ stageIndex: 0, stageProgress: 0.4, paused: true });
  lab.setTimelineState({ stageIndex: 1, stageProgress: 0, paused: true });
  assert.deepEqual(shots, [0, 1]);
  lab._releaseGuidedCamera('manual-orbit');
  lab.setTimelineState({ stageIndex: 2, stageProgress: 0, paused: true });
  assert.deepEqual(shots, [0, 1]);
  lab.resumeGuidedCamera();
  lab.setTimelineState({ stageIndex: 3, stageProgress: 0, paused: true });
  assert.deepEqual(shots, [0, 1, 2, 3]);
});

test('SPAD micro-stages separately show absorption, high-field multiplication, pulse, then quench', () => {
  const { lab, observed } = timelineHarness();
  const line = count => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    return new THREE.Line(geometry, new THREE.LineBasicMaterial({ transparent: true, opacity: 0 }));
  };
  lab.detectorDetail = {
    group: { visible: true }, absorbed: { material: { opacity: 0 } }, incidentPacket: line(48),
    electrons: Array.from({ length: 14 }, () => ({ material: { opacity: 0 }, position: new THREE.Vector3() })),
    signal: line(48), highField: { material: { opacity: 0 } }, quench: { material: { color: new THREE.Color() } },
    fieldArrows: Array.from({ length: 5 }, () => ({ visible: false })),
  };
  lab.detectorDetail.signalGeometry = lab.detectorDetail.signal.geometry;
  const detail = lab.detectorDetail;
  lab._renderDetectorMicro({ detectionsVisible: false, time: 1 }, 0.11);
  assert.equal(detail.incidentPacket.visible, true);
  assert.ok(detail.electrons.every(electron => electron.material.opacity === 0));
  lab._renderDetectorMicro({ detectionsVisible: true, time: 2 }, 0.12);
  assert.equal(detail.incidentPacket.visible, false);
  assert.ok(detail.absorbed.material.opacity > 0);
  lab._renderDetectorMicro({ detectionsVisible: true, time: 3 }, 0.45);
  assert.equal(detail.electrons.filter(electron => electron.material.opacity > 0).length, 14);
  assert.ok(detail.fieldArrows.every(arrow => arrow.visible));
  assert.equal(detail.signal.material.opacity, 0);
  lab._renderDetectorMicro({ detectionsVisible: true, time: 4 }, 0.65);
  assert.equal(detail.signal.material.opacity, 0.9);
  lab._renderDetectorMicro({ detectionsVisible: true, time: 5 }, 0.84);
  assert.ok(detail.electrons.every(electron => electron.material.opacity === 0));
  assert.ok(detail.fieldArrows.every(arrow => !arrow.visible));
  assert.equal(detail.quench.material.color.getHex(), 0x8ee7c0);
  assert.equal(observed.length, 0);

  // A camera shot of Bob cannot move his absorption earlier than model time.
  detail.selectedId = 'detector-b-plus';
  lab._renderDetectorMicro({ detectionsVisible: true, detectedArms: ['A'], time: 6 }, 0.45);
  assert.equal(detail.incidentPacket.visible, true);
  assert.ok(detail.electrons.every(electron => electron.material.opacity === 0));
  assert.ok(detail.fieldArrows.every(arrow => !arrow.visible));
  assert.equal(detail.signal.material.opacity, 0);
  lab._renderDetectorMicro({ detectionsVisible: true, detectedArms: ['A', 'B'], time: 7 }, 0.45);
  assert.equal(detail.incidentPacket.visible, false);
  assert.equal(detail.electrons.filter(electron => electron.material.opacity > 0).length, 14);

  // An unused SPAD also cannot replay the other port's recorded avalanche.
  const record = { outcomeA: -1, outcomeB: -1 };
  lab._renderDetectorMicro({ detectionsVisible: true, detectedArms: ['A', 'B'], record, time: 8 }, 0.65);
  assert.equal(detail.incidentPacket.visible, false);
  assert.ok(detail.electrons.every(electron => electron.material.opacity === 0));
  assert.equal(detail.signal.material.opacity, 0);
});

test('A detector arrival records one pair exactly once and flashes only its actual channels', () => {
  const { lab, observed } = harness();
  let draws = 0;
  lab.launchPair(deferred(2, () => draws++));
  const pair = lab.pairs[0];
  lab._advancePair(pair, 1);
  lab._advancePair(pair, 1);
  assert.equal(draws, 1);
  assert.equal(observed.length, 1);
  for (const arm of ['a', 'b']) {
    const outcome = arm === 'a' ? observed[0].outcomeA : observed[0].outcomeB;
    assert.equal(lab.detectors.get(`detector-${arm}-${outcome === 1 ? 'plus' : 'minus'}`).pulse, 1);
    assert.equal(lab.detectors.get(`detector-${arm}-${outcome === 1 ? 'minus' : 'plus'}`).pulse, 0);
  }
  lab.reset();
});

test('Pause freezes measurement playback; nine 0.12 steps absorb one pair exactly once', () => {
  const { lab, observed } = harness();
  let draws = 0;
  lab.launchPair(deferred(3, () => draws++), { duration: 0.25, paused: true });
  for (let i = 0; i < 200; i++) lab.update(0.1);
  assert.equal(lab.progress, 0);
  assert.equal(draws, 0);
  for (let i = 0; i < 8; i++) lab.step();
  assert.ok(Math.abs(lab.progress - 0.96) < 1e-12);
  assert.equal(draws, 0);
  lab.step();
  assert.equal(draws, 1);
  assert.equal(observed.length, 1);
  assert.equal(lab.activeCount, 0);
  assert.equal(lab.running, false);
  lab.step();
  assert.equal(observed.length, 1);
});

test('Resize, camera bookmarks, and inspection do not draw randomness or record outcomes', () => {
  const { lab, observed } = harness();
  let draws = 0;
  lab.launchPair(deferred(4, () => draws++), { paused: true });
  lab.resize();
  lab.setCameraPreset('top');
  lab.focus('source');
  lab.setReducedMotion(true);
  lab.setPresentation(true);
  for (let i = 0; i < 20; i++) lab.update(0.05);
  assert.equal(draws, 0);
  assert.equal(observed.length, 0);
  assert.equal(lab.progress, 0);
  assert.equal(lab.controls.autoRotate, false);
  assert.equal(lab.camera.aspect, 1600 / 900);
  lab.reset();
});

test('Saved seed reproduces detector outcomes and timestamps under different render frame rates', () => {
  function replay(frameDt) {
    const { lab, observed } = harness();
    const rng = seededRng('identical-seed');
    for (let id = 1; id <= 20; id++) lab.launchPair(deferred(id, () => {}, rng), { duration: 1 });
    for (let i = 0; i < Math.ceil(2 / frameDt); i++) lab.update(frameDt);
    assert.equal(observed.length, 20);
    return observed.map(record => ({ id: record.id, a: record.outcomeA, b: record.outcomeB, events: record.events }));
  }
  assert.deepEqual(replay(1 / 24), replay(1 / 144));
});

test('Reset removes all visual pairs and detector record references without sampling pending photons', () => {
  const { lab, observed } = harness();
  let draws = 0;
  lab.launchPair(deferred(7, () => draws++));
  lab.update(0.1);
  lab.reset();
  assert.equal(lab.activeCount, 0);
  assert.equal(draws, 0);
  assert.equal(observed.length, 0);
  assert.ok([...lab.detectors.values()].every(detector => detector.lastRecord === undefined && detector.pulse === 0));
});
