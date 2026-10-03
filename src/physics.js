/**
 * Rendering-independent polarization experiment. Angles are laboratory degrees;
 * outcomes are eigenvalues of the selected analyzer (+1 transmitted, -1 reflected).
 * A quantum emission carries a two-photon state, never pre-assigned H/V outcomes.
 */
export const SPEED_OF_LIGHT = 299_792_458;
export const OUTCOME_KEYS = Object.freeze(['++', '+-', '-+', '--']);
export const BELL_DEFAULTS = Object.freeze({ a: [0, 45], b: [22.5, -22.5] });
const DEG = Math.PI / 180;

function finite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return value;
}
function fraction(value, name) {
  finite(value, name);
  if (value < 0 || value > 1) throw new RangeError(`${name} must be between 0 and 1`);
  return value;
}
function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}
function emissionSeconds(settings) {
  const fromSeconds = settings.emittedAt === undefined ? null : finite(settings.emittedAt, 'emittedAt');
  const fromNanoseconds = settings.emissionTimeNs === undefined ? null : finite(settings.emissionTimeNs, 'emissionTimeNs') / 1e9;
  if (fromSeconds !== null && fromNanoseconds !== null && Math.abs(fromSeconds - fromNanoseconds) > Math.max(1e-15, Math.abs(fromSeconds) * Number.EPSILON * 2)) {
    throw new RangeError('emittedAt seconds and emissionTimeNs must describe the same instant');
  }
  return fromSeconds ?? fromNanoseconds ?? 0;
}
function canonicalSource(source = 'entangled') {
  if (['entangled', 'quantum'].includes(source)) return 'entangled';
  if (['classical', 'correlated', 'ordinary'].includes(source)) return 'classical';
  throw new RangeError(`Unknown source: ${source}`);
}
function canonicalState(state = 'singlet') {
  if (['phiPlus', 'phi+', 'Phi+', 'Φ+'].includes(state)) return 'phiPlus';
  if (['singlet', 'psiMinus', 'psi-', 'Ψ−'].includes(state)) return 'singlet';
  throw new RangeError(`Unknown state: ${state}`);
}
function normalize(settings = {}) {
  return {
    source: canonicalSource(settings.source),
    state: canonicalState(settings.state),
    a: finite(settings.a ?? 0, 'a'),
    b: finite(settings.b ?? 0, 'b'),
    visibility: fraction(settings.visibility ?? 1, 'visibility'),
  };
}
/** Shared canonical boundary for rendering-independent models; angles remain degrees in records. */
export function normalizeSettings(settings = {}) { return normalize(settings); }
function random(rng) {
  const value = rng();
  if (!Number.isFinite(value) || value < 0 || value >= 1) throw new RangeError('rng must return a number in [0, 1)');
  return value;
}

/** Mulberry32, reproducible for the same number or string seed. Not cryptographic. */
export function seededRng(seed = 1) {
  let value;
  if (typeof seed === 'string') {
    value = 2166136261;
    for (let i = 0; i < seed.length; i++) value = Math.imul(value ^ seed.charCodeAt(i), 16777619);
  } else {
    finite(seed, 'seed');
    value = seed >>> 0;
  }
  return () => {
    value = (value + 0x6D2B79F5) >>> 0;
    let t = Math.imul(value ^ (value >>> 15), 1 | value);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Born-rule probabilities in the order ++, +-, -+, --.
 * Singlet: E = -cos 2(a-b); optional Phi+: E = cos 2(a-b).
 * Ordinary correlated source is rho = (|HV><HV| + |VH><VH|)/2,
 * for which E = -cos(2a) cos(2b). White noise mixes I/4 with weight 1-v.
 */
export function jointProbabilities(settings = {}) {
  const s = normalize(settings);
  let e = s.source === 'classical'
    ? -Math.cos(2 * s.a * DEG) * Math.cos(2 * s.b * DEG)
    : Math.cos(2 * (s.a - s.b) * DEG) * (s.state === 'singlet' ? -1 : 1);
  e = Math.max(-1, Math.min(1, e * s.visibility));
  return { '++': (1 + e) / 4, '+-': (1 - e) / 4, '-+': (1 - e) / 4, '--': (1 + e) / 4 };
}

export function expectedCorrelation(settings = {}) {
  const p = jointProbabilities(settings);
  return p['++'] + p['--'] - p['+-'] - p['-+'];
}

// Complex matrix reference implementation. Numbers or {re,im} entries are accepted.
// The fast analytic sampler below is independently tested against these projectors.
const C = (re = 0, im = 0) => ({ re, im });
const asComplex = value => typeof value === 'number' ? C(finite(value, 'matrix entry')) : C(finite(value.re, 'matrix real part'), finite(value.im, 'matrix imaginary part'));
const cAdd = (a, b) => C(a.re + b.re, a.im + b.im);
const cMul = (a, b) => C(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
const cScale = (value, scalar) => C(value.re * scalar, value.im * scalar);
function matrix(size, entry = () => C()) {
  return Array.from({ length: size }, (_, i) => Array.from({ length: size }, (_, j) => entry(i, j)));
}
function identity(size) { return matrix(size, (i, j) => C(i === j ? 1 : 0)); }
function checkedMatrix(value, size) {
  if (!Array.isArray(value) || value.length !== size || value.some(row => !Array.isArray(row) || row.length !== size)) throw new TypeError(`matrix must be ${size} by ${size}`);
  return value.map(row => row.map(asComplex));
}
function multiply(left, right) {
  return matrix(left.length, (i, j) => left[i].reduce((sum, value, k) => cAdd(sum, cMul(value, right[k][j])), C()));
}
function tensor(left, right) {
  const m = right.length;
  return matrix(left.length * m, (i, j) => cMul(left[Math.floor(i / m)][Math.floor(j / m)], right[i % m][j % m]));
}
function trace(value) { return value.reduce((sum, row, i) => cAdd(sum, row[i]), C()); }
function probability(value) {
  const z = trace(value);
  if (Math.abs(z.im) > 1e-10 || z.re < -1e-10 || z.re > 1 + 1e-10) throw new RangeError('Born probability is not real and within [0, 1]');
  return Math.max(0, Math.min(1, z.re));
}
function operator(arm, angle, outcome) {
  if (!['A', 'B', 'a', 'b'].includes(arm)) throw new RangeError('arm must be A or B');
  const p = measurementProjector(angle, outcome);
  return arm.toUpperCase() === 'A' ? tensor(p, identity(2)) : tensor(identity(2), p);
}

/** Joint density matrix in basis HH, HV, VH, VV. Every entry is {re,im}. */
export function densityMatrix(settings = {}) {
  const s = normalize(settings);
  let rho;
  if (s.source === 'classical') {
    rho = matrix(4, (i, j) => C(i === j && (i === 1 || i === 2) ? 0.5 : 0));
  } else {
    const ket = s.state === 'singlet' ? [0, Math.SQRT1_2, -Math.SQRT1_2, 0] : [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
    rho = matrix(4, (i, j) => C(ket[i] * ket[j]));
  }
  return matrix(4, (i, j) => cAdd(cScale(rho[i][j], s.visibility), C(i === j ? (1 - s.visibility) / 4 : 0)));
}

/** Linear polarization projector |outcome_theta><outcome_theta|. */
export function measurementProjector(angle, outcome = 1) {
  finite(angle, 'angle');
  if (![1, -1].includes(outcome)) throw new RangeError('outcome must be +1 or -1');
  const theta = angle * DEG;
  const ket = outcome === 1 ? [Math.cos(theta), Math.sin(theta)] : [-Math.sin(theta), Math.cos(theta)];
  return matrix(2, (i, j) => C(ket[i] * ket[j]));
}

/** General two-qubit Born calculation, including complex coherences. */
export function bornJointProbabilities(inputRho, a, b) {
  const rho = checkedMatrix(inputRho, 4);
  const result = {};
  for (const x of [1, -1]) for (const y of [1, -1]) {
    const key = `${x === 1 ? '+' : '-'}${y === 1 ? '+' : '-'}`;
    result[key] = probability(multiply(rho, tensor(measurementProjector(a, x), measurementProjector(b, y))));
  }
  return result;
}

/** Apply a recorded local outcome, normalize, and return its probability. */
export function conditionalState(inputRho, arm, angle, outcome) {
  const rho = checkedMatrix(inputRho, 4);
  const p = operator(arm, angle, outcome);
  const projected = multiply(multiply(p, rho), p);
  const weight = probability(projected);
  return { probability: weight, rho: weight < 1e-15 ? null : projected.map(row => row.map(value => cScale(value, 1 / weight))) };
}

/** Unread local measurement: sum both outcomes, rather than postselecting one. */
export function nonselectiveMeasurement(inputRho, arm, angle) {
  const rho = checkedMatrix(inputRho, 4);
  const plus = operator(arm, angle, 1), minus = operator(arm, angle, -1);
  const projectedPlus = multiply(multiply(plus, rho), plus);
  const projectedMinus = multiply(multiply(minus, rho), minus);
  return matrix(4, (i, j) => cAdd(projectedPlus[i][j], projectedMinus[i][j]));
}

/** What one observer can predict locally, without the other arm's records. */
export function localMarginals(inputRho, arm, angle) {
  const rho = checkedMatrix(inputRho, 4);
  return { '+': probability(multiply(rho, operator(arm, angle, 1))), '-': probability(multiply(rho, operator(arm, angle, -1))) };
}

/** Fast-axis Jones convention: J(phi) = [[cos 2phi,sin 2phi],[sin 2phi,-cos 2phi]]. */
export function halfWavePlateJones(fastAxisDegrees) {
  finite(fastAxisDegrees, 'fastAxisDegrees');
  const c = Math.cos(2 * fastAxisDegrees * DEG), s = Math.sin(2 * fastAxisDegrees * DEG);
  return [[C(c), C(s)], [C(s), C(-c)]];
}
export function analyzerAngleFromHWP(fastAxisDegrees) {
  return 2 * finite(fastAxisDegrees, 'fastAxisDegrees');
}

/** Sequential projective sampling, useful for stepwise educational displays. */
export function sampleSequential(settings = {}, order = 'A-first', rng = Math.random) {
  if (!['A-first', 'B-first'].includes(order)) throw new RangeError('order must be A-first or B-first');
  const s = normalize(settings);
  const rho = densityMatrix(s);
  const firstArm = order === 'A-first' ? 'A' : 'B';
  const secondArm = firstArm === 'A' ? 'B' : 'A';
  const firstAngle = firstArm === 'A' ? s.a : s.b;
  const secondAngle = secondArm === 'A' ? s.a : s.b;
  const firstOutcome = random(rng) < localMarginals(rho, firstArm, firstAngle)['+'] ? 1 : -1;
  const first = conditionalState(rho, firstArm, firstAngle, firstOutcome);
  const secondPlus = localMarginals(first.rho, secondArm, secondAngle)['+'];
  const secondOutcome = random(rng) < secondPlus ? 1 : -1;
  const a = firstArm === 'A' ? firstOutcome : secondOutcome;
  const b = firstArm === 'B' ? firstOutcome : secondOutcome;
  return { ...buildRecord(settings, s, { a, b, key: `${a === 1 ? '+' : '-'}${b === 1 ? '+' : '-'}` }),
    order, firstArm, firstOutcome, firstProbability: first.probability,
    conditionalSecondPlus: secondPlus,
  };
}

function drawOutcomes(probabilities, rng) {
  const u = random(rng);
  let cumulative = 0;
  for (let i = 0; i < OUTCOME_KEYS.length; i++) {
    cumulative += probabilities[OUTCOME_KEYS[i]];
    if (u < cumulative || i === 3) return { a: i < 2 ? 1 : -1, b: i % 2 === 0 ? 1 : -1, key: OUTCOME_KEYS[i] };
  }
}

/** Prepare a record with no outcome fields and without drawing any randomness. */
export function createEmission(settings = {}) {
  const s = normalize(settings);
  return Object.freeze({
    id: settings.id ?? 0,
    emittedAt: emissionSeconds(settings),
    emissionTimeNs: emissionSeconds(settings) * 1e9,
    source: s.source,
    state: s.state,
    visibility: s.visibility,
    quantumState: s.source === 'entangled' ? s.state : 'HV/VH density mixture',
  });
}

function buildRecord(settings, s, outcomes) {
  const emittedAt = emissionSeconds(settings);
  const defaultFlightTime = 1.8 / SPEED_OF_LIGHT;
  const timing = settings.flightTime ?? defaultFlightTime;
  const flightA = finite(typeof timing === 'number' ? timing : timing.a ?? defaultFlightTime, 'flightTime.a');
  const flightB = finite(typeof timing === 'number' ? timing : timing.b ?? defaultFlightTime, 'flightTime.b');
  if (flightA < 0 || flightB < 0) throw new RangeError('flight times cannot be negative');
  const timestampA = emittedAt + flightA;
  const timestampB = emittedAt + flightB;
  const detectorA = `A${outcomes.a === 1 ? '+' : '-'}`;
  const detectorB = `B${outcomes.b === 1 ? '+' : '-'}`;
  const id = settings.id ?? 0;
  const events = [
    { pairId: id, arm: 'A', detector: detectorA, outcome: outcomes.a, timestamp: timestampA, timestampNs: timestampA * 1e9 },
    { pairId: id, arm: 'B', detector: detectorB, outcome: outcomes.b, timestamp: timestampB, timestampNs: timestampB * 1e9 },
  ].sort((left, right) => left.timestamp - right.timestamp);
  return {
    id, ...s, settings: { ...s }, emittedAt, emissionTimeNs: emittedAt * 1e9,
    outcomeA: outcomes.a, outcomeB: outcomes.b,
    aOutcome: outcomes.a, bOutcome: outcomes.b,
    outcomes: { a: outcomes.a, b: outcomes.b },
    outcomeKey: outcomes.key,
    detectors: { a: detectorA, b: detectorB },
    timestampA, timestampB, timestamps: { a: timestampA * 1e9, b: timestampB * 1e9 },
    events, detectorModel: 'ideal',
  };
}

/** One recorded joint detection. Call at detector absorption, not when preparing an emission. */
export function samplePair(settings = {}, rng = Math.random) {
  const s = normalize(settings);
  return buildRecord(settings, s, drawOutcomes(jointProbabilities(s), rng));
}

/** Detect a prepared emission in the selected analysis bases; the PBS alone records no outcome. */
export function measurePair(emission, measurementSettings = {}, rng = Math.random) {
  if (!emission || typeof emission !== 'object') throw new TypeError('emission must be a prepared record');
  return samplePair({ ...measurementSettings, source: emission.source, state: emission.state,
    visibility: emission.visibility, id: emission.id, emittedAt: emission.emittedAt,
    emissionTimeNs: emission.emissionTimeNs }, rng);
}

/** E from observed joint counts; returns null before any measurements. */
export function correlation(counts) {
  const total = OUTCOME_KEYS.reduce((sum, key) => sum + (counts[key] ?? 0), 0);
  if (total === 0) return null;
  return ((counts['++'] ?? 0) + (counts['--'] ?? 0) - (counts['+-'] ?? 0) - (counts['-+'] ?? 0)) / total;
}

/** Stateful counting utility independent of rendering; records can be exported verbatim. */
export class ExperimentStatistics {
  constructor() { this.reset(); }
  reset() {
    this.total = 0;
    this.counts = { '++': 0, '+-': 0, '-+': 0, '--': 0 };
    this.detectors = { 'A+': 0, 'A-': 0, 'B+': 0, 'B-': 0 };
    this.bySetting = new Map();
  }
  add(record) {
    const a = record.outcomeA ?? record.outcomes?.a;
    const b = record.outcomeB ?? record.outcomes?.b;
    if (![1, -1].includes(a) || ![1, -1].includes(b)) throw new RangeError('record must contain ±1 outcomes');
    const key = `${a === 1 ? '+' : '-'}${b === 1 ? '+' : '-'}`;
    this.total++;
    this.counts[key]++;
    this.detectors[`A${a === 1 ? '+' : '-'}`]++;
    this.detectors[`B${b === 1 ? '+' : '-'}`]++;
    const settingKey = `${record.source}:${record.state}:${record.visibility}:${record.a}:${record.b}`;
    if (!this.bySetting.has(settingKey)) this.bySetting.set(settingKey, { settings: { ...record.settings }, counts: { '++': 0, '+-': 0, '-+': 0, '--': 0 }, total: 0 });
    const group = this.bySetting.get(settingKey);
    group.counts[key]++;
    group.total++;
    return this;
  }
  snapshot() {
    return { total: this.total, counts: { ...this.counts }, detectors: { ...this.detectors }, correlation: correlation(this.counts),
      aPlusFraction: this.total ? this.detectors['A+'] / this.total : null,
      bPlusFraction: this.total ? this.detectors['B+'] / this.total : null,
      settings: [...this.bySetting.values()].map(group => ({ ...group, counts: { ...group.counts }, correlation: correlation(group.counts) })) };
  }
}

/**
 * Independent random setting choices per pair. Four coincidence bins give
 * S = |E(a0,b0)+E(a0,b1)+E(a1,b0)-E(a1,b1)|. No selected or fabricated counts.
 */
export function runBell(options = {}, rng = seededRng(options.seed ?? 2026)) {
  const a = options.a ?? [...BELL_DEFAULTS.a];
  const b = options.b ?? [...BELL_DEFAULTS.b];
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 2 || b.length !== 2) throw new RangeError('Bell test needs two angles on each arm');
  a.forEach(angle => finite(angle, 'Bell a'));
  b.forEach(angle => finite(angle, 'Bell b'));
  const pairs = positiveInteger(options.pairs ?? 4 * (options.pairsPerSetting ?? 10_000), 'pairs');
  const base = normalize({ ...options, a: a[0], b: b[0] });
  const bins = [0, 1, 2, 3].map(index => {
    const i = Math.floor(index / 2), j = index % 2;
    const settings = { ...base, a: a[i], b: b[j] };
    return { i, j, a: a[i], b: b[j], settings, probabilities: jointProbabilities(settings), counts: { '++': 0, '+-': 0, '-+': 0, '--': 0 }, total: 0 };
  });
  for (let n = 0; n < pairs; n++) {
    const i = random(rng) < 0.5 ? 0 : 1;
    const j = random(rng) < 0.5 ? 0 : 1;
    const bin = bins[i * 2 + j];
    bin.counts[drawOutcomes(bin.probabilities, rng).key]++;
    bin.total++;
  }
  const correlations = bins.map(bin => correlation(bin.counts));
  const complete = correlations.every(value => value !== null);
  const signedS = complete ? correlations[0] + correlations[1] + correlations[2] - correlations[3] : null;
  const sufficientForUncertainty = bins.every(bin => bin.total >= 2);
  const standardError = complete && sufficientForUncertainty ? Math.sqrt(bins.reduce((sum, bin, index) => sum + (1 - correlations[index] ** 2) / (bin.total - 1), 0)) : null;
  const expected = bins.map(bin => expectedCorrelation(bin.settings));
  return { source: base.source, state: base.state, visibility: base.visibility, pairs, a: [...a], b: [...b],
    bins: bins.map((bin, index) => ({ ...bin, correlation: correlations[index], expectedCorrelation: expected[index] })),
    correlations, signedS, S: signedS === null ? null : Math.abs(signedS),
    expectedS: Math.abs(expected[0] + expected[1] + expected[2] - expected[3]),
    standardError, uncertaintyMethod: 'Approximate independent-bin normal standard error; sample variance divided by n',
    sufficientForUncertainty, classicalBound: 2, quantumBound: 2 * Math.SQRT2,
    violation: signedS !== null && Math.abs(signedS) > 2,
    significantViolation: signedS !== null && standardError !== null && Math.abs(signedS) - 3 * standardError > 2,
  };
}

/**
 * Sender encodes intended bits by choosing a measurement basis; receiver's local
 * stream remains unbiased. Joint/conditional counts become useful only after
 * classical comparison. No outcome postselection enters receiver statistics.
 */
export function simulateNoSignaling(options = {}, rng = seededRng(options.seed ?? 429)) {
  const pairsPerMessage = positiveInteger(options.pairsPerMessage ?? options.pairs ?? 10_000, 'pairsPerMessage');
  const senderAngles = options.senderAngles ?? [0, 45];
  if (!Array.isArray(senderAngles) || senderAngles.length !== 2) throw new RangeError('senderAngles must contain two angles');
  const receiverAngle = finite(options.receiverAngle ?? options.b ?? 0, 'receiverAngle');
  const groups = senderAngles.map((angle, message) => {
    const settings = normalize({ ...options, a: angle, b: receiverAngle });
    const p = jointProbabilities(settings);
    const counts = { '++': 0, '+-': 0, '-+': 0, '--': 0 };
    let preview = '';
    for (let i = 0; i < pairsPerMessage; i++) {
      const outcomes = drawOutcomes(p, rng);
      counts[outcomes.key]++;
      if (i < 96) preview += outcomes.b === 1 ? '0' : '1';
    }
    const receiverPlus = counts['++'] + counts['-+'];
    return { message, senderAngle: settings.a, receiverAngle, total: pairsPerMessage, counts,
      receiverPlus, receiverMinus: pairsPerMessage - receiverPlus, receiverPlusFraction: receiverPlus / pairsPerMessage,
      expectedReceiverPlusFraction: p['++'] + p['-+'], correlation: correlation(counts), receiverPreview: preview,
      conditionalBPlusGivenAPlus: (counts['++'] + counts['+-']) ? counts['++'] / (counts['++'] + counts['+-']) : null,
    };
  });
  return { groups, pairs: 2 * pairsPerMessage, receiverAngle,
    difference: groups[0].receiverPlusFraction - groups[1].receiverPlusFraction,
    standardError: Math.sqrt(0.5 / pairsPerMessage),
    expectedDifference: 0, classicalComparisonRequired: true,
  };
}

/**
 * Educational BBM92 sifting and parameter estimation. Eve's attack really
 * measures Bob's arm and resends that eigenstate; errors follow sequential
 * Born-rule sampling. This does not implement authentication, reconciliation,
 * privacy amplification or a production secure-key protocol.
 */
export function runQKD(options = {}, rng = seededRng(options.seed ?? 1992)) {
  const pairs = positiveInteger(options.pairs ?? 2_000, 'pairs');
  const bases = options.bases ?? [0, 45];
  if (!Array.isArray(bases) || bases.length !== 2) throw new RangeError('QKD requires two bases');
  bases.forEach(angle => finite(angle, 'basis'));
  if (Math.abs(Math.cos(2 * (bases[0] - bases[1]) * DEG)) > 1e-12) throw new RangeError('QKD bases must be mutually unbiased (45 degrees apart)');
  const s = normalize(options);
  const interceptProbability = fraction(options.interceptProbability ?? (options.eve ? 1 : 0), 'interceptProbability');
  const sampleFraction = fraction(options.sampleFraction ?? 0.25, 'sampleFraction');
  const records = [];
  const sifted = [];
  let intercepted = 0;
  for (let n = 0; n < pairs; n++) {
    const basisA = random(rng) < 0.5 ? 0 : 1;
    const basisB = random(rng) < 0.5 ? 0 : 1;
    const a = bases[basisA], b = bases[basisB];
    const attacked = interceptProbability > 0 && random(rng) < interceptProbability;
    let outcomes, eveBasis = null, eveOutcome = null;
    if (attacked) {
      intercepted++;
      eveBasis = random(rng) < 0.5 ? 0 : 1;
      const e = bases[eveBasis];
      const initial = drawOutcomes(jointProbabilities({ ...s, a, b: e }), rng);
      eveOutcome = initial.b;
      const pBobPlus = (1 + eveOutcome * Math.cos(2 * (b - e) * DEG)) / 2;
      const bob = random(rng) < pBobPlus ? 1 : -1;
      outcomes = { a: initial.a, b: bob, key: `${initial.a === 1 ? '+' : '-'}${bob === 1 ? '+' : '-'}` };
    } else {
      outcomes = drawOutcomes(jointProbabilities({ ...s, a, b }), rng);
    }
    const record = buildRecord({ ...options, id: n, emittedAt: n * (options.pairInterval ?? 1e-6) }, { ...s, a, b }, outcomes);
    record.basisA = basisA;
    record.basisB = basisB;
    record.bitA = outcomes.a === 1 ? 0 : 1;
    record.rawBitB = outcomes.b === 1 ? 0 : 1;
    record.bitB = s.source === 'classical' || s.state === 'singlet' ? 1 - record.rawBitB : record.rawBitB;
    record.sifted = basisA === basisB;
    record.intercepted = attacked;
    record.eveBasis = eveBasis;
    record.eveOutcome = eveOutcome;
    record.disclosed = false;
    if (record.sifted) sifted.push(record);
    records.push(record);
  }
  // Fisher-Yates gives a uniformly selected public parameter-estimation sample.
  const shuffled = [...sifted];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random(rng) * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const disclosed = Math.min(sifted.length, Math.ceil(sifted.length * sampleFraction));
  for (let i = 0; i < disclosed; i++) shuffled[i].disclosed = true;
  const publicSample = sifted.filter(record => record.disclosed);
  const retained = sifted.filter(record => !record.disclosed);
  const errors = publicSample.filter(record => record.bitA !== record.bitB).length;
  const siftedErrors = sifted.filter(record => record.bitA !== record.bitB).length;
  return { protocol: 'BBM92 educational simulation', source: s.source, state: s.state, pairs, intercepted,
    bases: [...bases], records: options.retainRecords === false ? [] : records,
    sifted: sifted.length, siftedCount: sifted.length, discardedBasis: pairs - sifted.length,
    disclosed, disclosedCount: disclosed, errors, qber: disclosed ? errors / disclosed : null,
    siftedQber: sifted.length ? siftedErrors / sifted.length : null,
    retained: retained.length, aliceKey: retained.map(record => record.bitA).join(''), bobKey: retained.map(record => record.bitB).join(''),
    publicSample: publicSample.map(record => ({ id: record.id, basis: record.basisA, bitA: record.bitA, bitB: record.bitB })),
    expectedQber: s.source === 'entangled' ? (1 - s.visibility) / 2 + s.visibility * interceptProbability / 4 : 0.5 - s.visibility / 4 + s.visibility * interceptProbability / 8,
    keyStatus: 'Sifted candidate bits; no secure key established',
    classicalChannelRequired: true,
  };
}
