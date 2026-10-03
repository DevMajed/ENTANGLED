import test from 'node:test';
import assert from 'node:assert/strict';
import { jointProbabilities, expectedCorrelation, seededRng, samplePair, createEmission, measurePair,
  ExperimentStatistics, correlation, runBell, simulateNoSignaling, runQKD, SPEED_OF_LIGHT,
  densityMatrix, measurementProjector, bornJointProbabilities, conditionalState,
  nonselectiveMeasurement, localMarginals, sampleSequential, halfWavePlateJones, analyzerAngleFromHWP } from '../src/physics.js';

function near(actual, expected, tolerance = 1e-12) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} expected within ${tolerance} of ${expected}`);
}

test('Born probabilities normalize, stay positive and give unbiased local marginals across bases and noise', () => {
  for (const source of ['entangled', 'classical']) for (const state of ['phiPlus', 'singlet'])
    for (const a of [-180, 0, 12.3, 45, 87, 180]) for (const b of [-22.5, 0, 37, 90]) for (const visibility of [0, 0.6, 1]) {
      const p = jointProbabilities({ source, state, a, b, visibility });
      near(Object.values(p).reduce((total, value) => total + value, 0), 1);
      assert.ok(Object.values(p).every(value => value >= 0 && value <= 1));
      near(p['++'] + p['+-'], 0.5);
      near(p['++'] + p['-+'], 0.5);
    }
});

test('Singlet equal bases anticorrelate perfectly; 90-degree bases correlate; 45-degree bases are independent', () => {
  for (const angle of [0, 15, 45, 89]) {
    assert.deepEqual(jointProbabilities({ a: angle, b: angle }), { '++': 0, '+-': 0.5, '-+': 0.5, '--': 0 });
    near(expectedCorrelation({ a: angle, b: angle + 90 }), 1);
    const p = jointProbabilities({ a: angle, b: angle + 45 });
    Object.values(p).forEach(value => near(value, 0.25));
  }
});

test('Ordinary HV/VH mixture differs in diagonal basis and satisfies its density-matrix probabilities', () => {
  near(expectedCorrelation({ source: 'classical', a: 45, b: 45 }), 0);
  near(expectedCorrelation({ source: 'entangled', a: 45, b: 45 }), -1);
  near(expectedCorrelation({ source: 'classical', a: 0, b: 0 }), -1);
  for (const a of [0, 18, 43, 90]) for (const b of [0, 22.5, 77]) {
    const cA = Math.cos(a * Math.PI / 180) ** 2;
    const cB = Math.cos(b * Math.PI / 180) ** 2;
    const p = jointProbabilities({ source: 'classical', a, b });
    near(p['++'], 0.5 * (cA * (1 - cB) + (1 - cA) * cB));
  }
});

test('Optional Phi+ reverses the default singlet correlations', () => {
  assert.deepEqual(jointProbabilities({ state: 'singlet', a: 38, b: 38 }), { '++': 0, '+-': 0.5, '-+': 0.5, '--': 0 });
  near(expectedCorrelation({ state: 'singlet', a: 0, b: 22.5 }), -Math.SQRT1_2);
  near(expectedCorrelation({ state: 'phiPlus', a: 0, b: 22.5 }), Math.SQRT1_2);
});

test('Emission has no pre-assigned outcomes; measurement uses arrival settings, and detector records are consistent', () => {
  const emission = createEmission({ id: 123, emittedAt: 0.25, a: 0, b: 0 });
  assert.ok(!('outcomes' in emission));
  assert.ok(!('outcomeA' in emission));
  assert.ok(!('polarization' in emission));
  const record = measurePair(emission, { a: 45, b: 45, flightTime: { a: 4e-9, b: 9e-9 } }, () => 0.6);
  assert.equal(record.id, 123);
  assert.equal(record.outcomeA, -1);
  assert.equal(record.outcomeB, 1);
  assert.deepEqual(record.outcomes, { a: -1, b: 1 });
  assert.equal(record.a, 45);
  assert.equal(record.detectors.a, 'A-');
  assert.equal(record.detectors.b, 'B+');
  near(record.timestampA, 0.25 + 4e-9);
  near(record.timestampB, 0.25 + 9e-9);
  assert.equal(record.events.length, 2);
  assert.ok(record.events.every(event => event.pairId === 123 && event.timestamp > emission.emittedAt));
  assert.equal(record.detectorModel, 'ideal');
  near(samplePair({}, () => 0).timestampA, 1.8 / SPEED_OF_LIGHT);
});

test('Seeded randomness reproduces records exactly and samples all four outcomes without forced alternation', () => {
  const first = seededRng('lab-42'), second = seededRng('lab-42');
  const records = Array.from({ length: 100 }, (_, id) => samplePair({ id, a: 0, b: 45 }, first));
  assert.deepEqual(records, Array.from({ length: 100 }, (_, id) => samplePair({ id, a: 0, b: 45 }, second)));
  assert.equal(new Set(records.map(record => record.outcomeKey)).size, 4);
  assert.ok(records.some((record, i) => i && record.outcomeKey === records[i - 1].outcomeKey));
});

test('100,000 samples follow all four specified quantum probabilities and produce detector-linked statistics', () => {
  const settings = { a: 17, b: 50 };
  const p = jointProbabilities(settings);
  const stats = new ExperimentStatistics();
  const rng = seededRng(991);
  for (let id = 0; id < 100_000; id++) stats.add(samplePair({ ...settings, id }, rng));
  const snapshot = stats.snapshot();
  for (const key of Object.keys(p)) near(snapshot.counts[key] / snapshot.total, p[key], 0.004);
  const marginalTolerance = 5 * Math.sqrt(0.25 / snapshot.total);
  near(snapshot.aPlusFraction, 0.5, marginalTolerance);
  near(snapshot.bPlusFraction, 0.5, marginalTolerance);
  near(snapshot.correlation, expectedCorrelation(settings), 5 * Math.sqrt((1 - expectedCorrelation(settings) ** 2) / snapshot.total));
  assert.equal(Object.values(snapshot.detectors).reduce((sum, value) => sum + value, 0), 2 * snapshot.total);
  assert.equal(snapshot.settings.length, 1);
  assert.equal(correlation({ '++': 4, '+-': 1, '-+': 1, '--': 4 }), 0.6);
  stats.reset();
  assert.equal(stats.snapshot().total, 0);
  assert.equal(stats.snapshot().correlation, null);
});

test('Randomized-setting CHSH has exact singlet signs, is near 2√2, and ~√2 for ordinary source', () => {
  const bell = runBell({ pairs: 160_000, seed: 7 });
  near(bell.S, 2 * Math.SQRT2, 0.025);
  near(bell.expectedS, 2 * Math.SQRT2);
  bell.bins.forEach((bin, i) => near(bin.expectedCorrelation, i < 3 ? -Math.SQRT1_2 : Math.SQRT1_2));
  assert.ok(bell.significantViolation);
  assert.ok(bell.bins.every(bin => bin.total > 38_000 && bin.total < 42_000));
  assert.equal(bell.bins.reduce((sum, bin) => sum + bin.total, 0), bell.pairs);
  const ordinary = runBell({ source: 'classical', pairs: 160_000, seed: 8 });
  near(ordinary.S, Math.SQRT2, 0.03);
  assert.ok(!ordinary.violation);
  const noisy = runBell({ visibility: 0.5, pairs: 160_000, seed: 9 });
  near(noisy.S, Math.SQRT2, 0.03);
});

test('Ordinary mixture analytically never violates CHSH across many independently chosen angles', () => {
  const rng = seededRng(27);
  for (let i = 0; i < 1_000; i++) {
    const a = [rng() * 180, rng() * 180], b = [rng() * 180, rng() * 180];
    const E = (i, j) => expectedCorrelation({ source: 'classical', a: a[i], b: b[j] });
    assert.ok(Math.abs(E(0, 0) + E(0, 1) + E(1, 0) - E(1, 1)) <= 2 + 1e-12);
  }
});

test('No instant messaging: Bob marginals remain unbiased for Alice encoding choices, while compared correlations differ', () => {
  const result = simulateNoSignaling({ pairsPerMessage: 100_000, senderAngles: [0, 45], receiverAngle: 0, seed: 333 });
  for (const group of result.groups) {
    near(group.receiverPlusFraction, 0.5, 0.005);
    near(group.expectedReceiverPlusFraction, 0.5);
    assert.equal(group.receiverPreview.length, 96);
  }
  near(result.difference, 0, 0.008);
  near(result.groups[0].correlation, -1);
  near(result.groups[1].correlation, 0, 0.012);
  near(result.groups[0].conditionalBPlusGivenAPlus, 0);
  near(result.groups[1].conditionalBPlusGivenAPlus, 0.5, 0.01);
  assert.ok(result.classicalComparisonRequired);
});

test('Ideal BBM92 independently chooses bases, discards ~half, and discards disclosed bits from retained candidates', () => {
  const qkd = runQKD({ pairs: 20_000, seed: 44 });
  near(qkd.sifted / qkd.pairs, 0.5, 0.015);
  assert.equal(qkd.qber, 0);
  assert.equal(qkd.aliceKey, qkd.bobKey);
  assert.equal(qkd.retained + qkd.disclosed, qkd.sifted);
  assert.equal(qkd.aliceKey.length, qkd.retained);
  assert.equal(qkd.records.filter(record => record.disclosed).length, qkd.disclosed);
  assert.ok(qkd.publicSample.every(bit => qkd.records[bit.id].disclosed));
  assert.ok(qkd.keyStatus.includes('no secure key'));
  const singlet = runQKD({ state: 'singlet', pairs: 2_000, seed: 1 });
  assert.equal(singlet.qber, 0);
  assert.equal(singlet.aliceKey, singlet.bobKey);
});

test('BBM92 full intercept/resend introduces ~25% errors through measurement, and partial attack scales', () => {
  const attacked = runQKD({ pairs: 50_000, eve: true, seed: 993, retainRecords: false });
  assert.equal(attacked.intercepted, 50_000);
  near(attacked.qber, 0.25, 0.02);
  near(attacked.siftedQber, 0.25, 0.015);
  assert.notEqual(attacked.aliceKey, attacked.bobKey);
  const partial = runQKD({ pairs: 50_000, interceptProbability: 0.5, seed: 994, retainRecords: false });
  near(partial.qber, 0.125, 0.02);
});

test('Invalid inputs fail explicitly instead of producing NaN or unphysical probabilities', () => {
  assert.throws(() => jointProbabilities({ a: NaN }), /finite/);
  assert.throws(() => jointProbabilities({ visibility: 1.1 }), /between/);
  assert.throws(() => jointProbabilities({ source: 'fake' }), /Unknown/);
  assert.throws(() => jointProbabilities({ state: 'fake' }), /Unknown/);
  assert.throws(() => samplePair({}, () => 1), /rng/);
  assert.throws(() => samplePair({ flightTime: -1 }), /negative/);
  assert.throws(() => runBell({ pairs: 0 }), /positive/);
  assert.throws(() => runQKD({ bases: [0, 90] }), /unbiased/);
  assert.throws(() => new ExperimentStatistics().add({ outcomeA: 0, outcomeB: 1 }), /outcomes/);
});

test('Optimized analytic engine equals explicit density-matrix Born projectors over sources, bases and depolarization', () => {
  for (const source of ['entangled', 'classical']) for (const state of ['singlet', 'phiPlus'])
    for (const visibility of [0, 0.3, 1]) for (const a of [-45, 0, 21, 45, 90]) for (const b of [-22.5, 0, 45, 76]) {
      const settings = { source, state, visibility, a, b };
      const reference = bornJointProbabilities(densityMatrix(settings), a, b);
      const optimized = jointProbabilities(settings);
      for (const key of Object.keys(reference)) near(optimized[key], reference[key]);
    }
});

test('Born reference supports complex coherences, preserving phase-sensitive probabilities', () => {
  // |psi> = (|HV> + i|VH>)/sqrt2 has imaginary HV/VH coherences.
  const rho = [[0, 0, 0, 0], [0, 0.5, { re: 0, im: -0.5 }, 0], [0, { re: 0, im: 0.5 }, 0.5, 0], [0, 0, 0, 0]];
  const diagonal = bornJointProbabilities(rho, 45, 45);
  Object.values(diagonal).forEach(value => near(value, 0.25));
  const conditional = conditionalState(rho, 'A', 45, 1);
  near(conditional.probability, 0.5);
  near(localMarginals(conditional.rho, 'B', 45)['+'], 0.5);
  assert.ok(conditional.rho.some(row => row.some(value => Math.abs(value.im) > 0.01)));
});

test('Unread remote measurements preserve local singlet marginals; selected results predict conditional anticorrelation', () => {
  const rho = densityMatrix();
  for (const firstArm of ['A', 'B']) for (const firstAngle of [-30, 0, 12.3, 45, 90]) {
    const otherArm = firstArm === 'A' ? 'B' : 'A';
    const unread = nonselectiveMeasurement(rho, firstArm, firstAngle);
    for (const otherAngle of [0, 22.5, 45, 87]) {
      near(localMarginals(unread, otherArm, otherAngle)['+'], 0.5);
      near(localMarginals(unread, otherArm, otherAngle)['-'], 0.5);
    }
    const selected = conditionalState(rho, firstArm, firstAngle, 1);
    near(selected.probability, 0.5);
    near(localMarginals(selected.rho, otherArm, firstAngle)['+'], 0);
    near(localMarginals(selected.rho, otherArm, firstAngle)['-'], 1);
  }
});

test('Alice-first and Bob-first seeded sequential projector sampling both match the joint Born distribution (5σ tolerance)', () => {
  const settings = { a: 18, b: 49, visibility: 0.8 };
  const reference = jointProbabilities(settings);
  const n = 12_000;
  for (const order of ['A-first', 'B-first']) {
    const rng = seededRng(order);
    const counts = { '++': 0, '+-': 0, '-+': 0, '--': 0 };
    for (let i = 0; i < n; i++) counts[sampleSequential(settings, order, rng).outcomeKey]++;
    for (const key of Object.keys(reference)) near(counts[key] / n, reference[key], 5 * Math.sqrt(reference[key] * (1 - reference[key]) / n));
  }
});

test('Half-wave plate at 22.5 degrees implements 45-degree analysis at the fixed H/V PBS', () => {
  near(analyzerAngleFromHWP(22.5), 45);
  for (const phi of [-11.25, 0, 22.5, 45]) {
    const jones = halfWavePlateJones(phi);
    const projector = measurementProjector(2 * phi, 1);
    // U† |H><H| U is the incoming + analyzer projector.
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) near(jones[0][i].re * jones[0][j].re, projector[i][j].re);
  }
});

test('Depolarization scales E and CHSH; completely mixed source is independent uniform', () => {
  for (const v of [0, 0.25, 0.6, 1]) {
    near(expectedCorrelation({ a: 17, b: 32, visibility: v }), v * expectedCorrelation({ a: 17, b: 32 }));
    near(runBell({ pairs: 20, visibility: v }).expectedS, 2 * Math.SQRT2 * v);
  }
  assert.deepEqual(jointProbabilities({ a: 71, b: -12, visibility: 0 }), { '++': 0.25, '+-': 0.25, '-+': 0.25, '--': 0.25 });
});

test('Finite Bell samples are never clipped; empty or one-trial bins cannot claim significance', () => {
  const tooFew = runBell({ pairs: 1, seed: 1 });
  assert.equal(tooFew.S, null);
  assert.equal(tooFew.standardError, null);
  assert.equal(tooFew.significantViolation, false);
  let foundAboveQuantumExpectation = false;
  for (let seed = 0; seed < 100; seed++) {
    const finite = runBell({ pairs: 12, seed });
    if (finite.S !== null && finite.S > 2 * Math.SQRT2) foundAboveQuantumExpectation = true;
    if (finite.bins.some(bin => bin.total < 2)) assert.equal(finite.significantViolation, false);
  }
  assert.ok(foundAboveQuantumExpectation, 'Actual finite-count fluctuations must remain visible');
});

test('Changing a setting stores a new group and does not relabel already measured records', () => {
  const stats = new ExperimentStatistics(), rng = seededRng(13);
  const first = samplePair({ id: 1, a: 0, b: 0 }, rng);
  const frozenRecord = structuredClone(first);
  stats.add(first);
  stats.add(samplePair({ id: 2, a: 45, b: 45 }, rng));
  stats.add(samplePair({ id: 3, a: 45, b: 45, source: 'classical' }, rng));
  stats.add(samplePair({ id: 4, a: 45, b: 45, visibility: 0.5 }, rng));
  assert.equal(stats.snapshot().settings.length, 4);
  assert.deepEqual(first, frozenRecord);
  stats.reset();
  assert.deepEqual(stats.snapshot().counts, { '++': 0, '+-': 0, '-+': 0, '--': 0 });
  assert.equal(stats.snapshot().settings.length, 0);
});

test('Prepared source state and emission instant remain fixed while arrival analyzer settings can change', () => {
  const emission = createEmission({ id: 99, emissionTimeNs: 123_000_000, source: 'entangled', state: 'singlet', visibility: 1 });
  const record = measurePair(emission, { a: 45, b: 45, source: 'classical', state: 'phiPlus', visibility: 0, emittedAt: 999 }, () => 0.1);
  assert.equal(record.source, 'entangled');
  assert.equal(record.state, 'singlet');
  assert.equal(record.visibility, 1);
  assert.equal(record.id, 99);
  assert.equal(record.emittedAt, 0.123);
  assert.equal(record.emissionTimeNs, 123_000_000);
  assert.equal(record.a, 45);
  assert.equal(record.b, 45);
  assert.equal(record.outcomeA, -record.outcomeB);
  assert.throws(() => createEmission({ emittedAt: 1, emissionTimeNs: 1 }), /same instant/);
});

test('Reference matrix inputs reject nonfinite entries; classical BBM92 follows its HV/VH convention for any optional Bell flag', () => {
  const bad = densityMatrix();
  bad[0][0] = NaN;
  assert.throws(() => bornJointProbabilities(bad, 0, 0), /finite/);
  const qkd = runQKD({ source: 'classical', state: 'phiPlus', pairs: 20_000, seed: 42, retainRecords: false });
  near(qkd.siftedQber, qkd.expectedQber, 0.02);
});
