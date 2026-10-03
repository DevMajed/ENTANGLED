import { samplePair, seededRng, jointProbabilities, normalizeSettings, SPEED_OF_LIGHT } from './physics.js';

const DEG = Math.PI / 180;
const complex = (re = 0, im = 0) => ({ re, im });
const z = value => typeof value === 'number' ? complex(finite(value, 'amplitude')) : complex(finite(value.re, 'real amplitude'), finite(value.im, 'imaginary amplitude'));
const multiply = (a, b) => complex(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
const scale = (a, b) => complex(a.re * b, a.im * b);
const add = (a, b) => complex(a.re + b.re, a.im + b.im);
const conjugate = a => complex(a.re, -a.im);
const finite = (value, name) => { if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${name} must be finite`); return value; };
export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
export function normSquared(vector) { return vector.reduce((sum, value) => sum + z(value).re ** 2 + z(value).im ** 2, 0); }

/** Local output basis is HT, HR, VT, VR. Ideal H→HT; V→exp(i phase)VR. */
export function singlePBSIsometry(input, phase = 0) {
  if (!Array.isArray(input) || input.length !== 2) throw new TypeError('Single-photon input must have H,V amplitudes');
  finite(phase, 'phase');
  return [z(input[0]), complex(), complex(), multiply(z(input[1]), complex(Math.cos(phase), Math.sin(phase)))];
}
function localHWP(angle) {
  const c = Math.cos(angle * DEG), s = Math.sin(angle * DEG);
  return [[c, s], [s, -c]];
}
function transformPair(ket, a, b, phase) {
  const ua = localHWP(a), ub = localHWP(b);
  const output = Array.from({ length: 16 }, () => complex());
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) {
    let amplitude = complex();
    for (let h = 0; h < 2; h++) for (let v = 0; v < 2; v++) amplitude = add(amplitude, scale(z(ket[h * 2 + v]), ua[x][h] * ub[y][v]));
    // Compensated global minus fixes the displayed singlet convention at a=b=0.
    amplitude = scale(amplitude, -1);
    const reflectPhase = complex(Math.cos(phase * (x + y)), Math.sin(phase * (x + y)));
    output[(x ? 3 : 0) * 4 + (y ? 3 : 0)] = multiply(amplitude, reflectPhase);
  }
  return output;
}

/** Coherent isometry; this operation never samples a route or creates detector records. */
export function coherentPBSState(settings = {}, { phase = 0 } = {}) {
  finite(phase, 'phase');
  const captured = normalizeSettings(settings);
  const probabilities = jointProbabilities(captured);
  const baseKets = captured.source === 'classical' ? [[0, 1, 0, 0], [0, 0, 1, 0]]
    : [captured.state === 'phiPlus' ? [Math.SQRT1_2, 0, 0, Math.SQRT1_2] : [0, Math.SQRT1_2, -Math.SQRT1_2, 0]];
  const components = baseKets.map(ket => ({ weight: captured.visibility / baseKets.length, amplitudes: transformPair(ket, captured.a, captured.b, phase) }));
  if (captured.visibility < 1) for (let i = 0; i < 4; i++) components.push({ weight: (1 - captured.visibility) / 4,
    amplitudes: transformPair(Array.from({ length: 4 }, (_, j) => i === j ? 1 : 0), captured.a, captured.b, phase) });
  return deepFreeze({ kind: captured.source === 'entangled' && captured.visibility === 1 ? 'coherent-pure-state' : 'density-mixture',
    localModes: ['HT', 'HR', 'VT', 'VR'], amplitudes: components.length === 1 ? components[0].amplitudes : null, components,
    jointProbabilities: probabilities,
    branchWeights: { a: { transmitted: probabilities['++'] + probabilities['+-'], reflected: probabilities['-+'] + probabilities['--'] },
      b: { transmitted: probabilities['++'] + probabilities['-+'], reflected: probabilities['+-'] + probabilities['--'] }, joint: probabilities },
    norm: components.reduce((sum, component) => sum + component.weight * normSquared(component.amplitudes), 0),
    phaseConvention: `Reflection phase ${phase} radians; compensated common global minus`,
  });
}

/** Trace both path degrees of freedom; this is not the full polarization/path state. */
export function traceOutPath(state) {
  const rho = Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => complex()));
  for (const component of state.components) for (let ia = 0; ia < 4; ia++) for (let ib = 0; ib < 4; ib++)
    for (let ja = 0; ja < 4; ja++) for (let jb = 0; jb < 4; jb++) {
      if (ia % 2 !== ja % 2 || ib % 2 !== jb % 2) continue;
      const i = Math.floor(ia / 2) * 2 + Math.floor(ib / 2), j = Math.floor(ja / 2) * 2 + Math.floor(jb / 2);
      rho[i][j] = add(rho[i][j], scale(multiply(component.amplitudes[ia * 4 + ib], conjugate(component.amplitudes[ja * 4 + jb])), component.weight));
    }
  return rho;
}
function gaussian(rng) {
  return Math.sqrt(-2 * Math.log(Math.max(Number.MIN_VALUE, rng()))) * Math.cos(2 * Math.PI * rng());
}
function contextFor(settings) {
  const captured = normalizeSettings(settings);
  jointProbabilities(captured); // Validate the same authoritative probability boundary.
  return deepFreeze({ settings: captured, jointProbabilities: jointProbabilities(captured), polarizationPathState: coherentPBSState(captured) });
}

/** Sample once for software playback; outcomes are hidden until destructive absorption. All times below are ns. */
export function createMeasurement(settings = {}, options = {}) {
  const seed = options.seed ?? 2026, id = options.id ?? 1, runId = options.runId ?? `run-${seed}`;
  const sourceRate = finite(options.sourceRate ?? 1_000, 'sourceRate');
  if (sourceRate <= 0) throw new RangeError('sourceRate must be positive');
  const context = options.context ?? contextFor(settings);
  const emissionTimeNs = finite(options.emissionTimeNs ?? id / sourceRate * 1e9, 'emissionTimeNs');
  const pathA = finite(options.pathLengthA ?? 1.8, 'pathLengthA'), pathB = finite(options.pathLengthB ?? 1.8, 'pathLengthB');
  if (pathA < 0 || pathB < 0) throw new RangeError('path lengths cannot be negative');
  const opticalDelayNs = finite(options.opticalDelayNs ?? 0, 'opticalDelayNs');
  const delayNs = finite(options.delayNs ?? 12, 'delayNs');
  const jitterNs = finite(options.jitterNs ?? 0, 'jitterNs');
  const latencyNs = finite(options.readoutLatencyNs ?? 24, 'readoutLatencyNs');
  if (jitterNs < 0 || latencyNs < 0) throw new RangeError('jitter and readout latency cannot be negative');
  const sample = samplePair({ ...context.settings, id, emittedAt: emissionTimeNs / 1e9,
    flightTime: { a: pathA / SPEED_OF_LIGHT, b: pathB / SPEED_OF_LIGHT + opticalDelayNs / 1e9 } }, seededRng(`${seed}:outcome:${id}`));
  const modelDetectionTimesNs = { a: sample.timestampA * 1e9, b: sample.timestampB * 1e9 };
  const modelReadoutTimesNs = { a: modelDetectionTimesNs.a + latencyNs + Math.max(0, -delayNs),
    b: modelDetectionTimesNs.b + latencyNs + Math.max(0, delayNs) };
  const timingRng = seededRng(`${seed}:timing:${id}`);
  const readoutTimestampsNs = { a: modelReadoutTimesNs.a + (jitterNs ? gaussian(timingRng) * jitterNs : 0),
    b: modelReadoutTimesNs.b + (jitterNs ? gaussian(timingRng) * jitterNs : 0) };
  const commitId = `${runId}:${id}`;
  const events = ['A', 'B'].map(arm => {
    const side = arm.toLowerCase(), outcome = sample.outcomes[side];
    return { arm, channel: `${arm}${outcome === 1 ? '+' : '-'}`, detector: `${arm}${outcome === 1 ? '+' : '-'}`, outcome,
      timestampNs: readoutTimestampsNs[side], modelDetectionTimeNs: modelDetectionTimesNs[side], modelReadoutTimeNs: modelReadoutTimesNs[side],
      debugPairId: id, debugCommitId: commitId };
  });
  return deepFreeze({ id, pairId: id, debugPairId: id, runId, commitId, seed, ...context.settings, settings: context.settings,
    emittedAt: emissionTimeNs / 1e9, emissionTimeNs, outcomeA: sample.outcomeA, outcomeB: sample.outcomeB,
    outcomes: sample.outcomes, outcomeKey: sample.outcomeKey, detectors: sample.detectors,
    modelDetectionTimesNs, absorptionTimesNs: modelDetectionTimesNs, modelReadoutTimesNs, readoutTimestampsNs,
    timestampA: readoutTimestampsNs.a / 1e9, timestampB: readoutTimestampsNs.b / 1e9,
    events, jointProbabilities: context.jointProbabilities, polarizationPathState: context.polarizationPathState,
    timing: { sourceRate, delayNs, opticalDelayNs, jitterNs, readoutLatencyNs: latencyNs, windowNs: options.windowNs ?? 4 },
    detectorModel: 'ideal single-pair destructive detection',
  });
}

/** Timestamp/channel-only, mutually-unique matching. Full window width W; boundary inclusive. */
export function timestampMatcher(events, { delayNs = 12, windowNs = 4 } = {}) {
  finite(delayNs, 'delayNs'); finite(windowNs, 'windowNs');
  if (windowNs < 0) throw new RangeError('windowNs cannot be negative');
  const invalid = [], a = [], b = [];
  events.forEach((event, inputIndex) => {
    const channel = event.channel ?? event.detector;
    if (!/^[AB][+-]$/.test(channel) || !Number.isFinite(event.timestampNs)) { invalid.push({ inputIndex, event }); return; }
    (channel[0] === 'A' ? a : b).push({ event, inputIndex });
  });
  const sort = (left, right) => left.event.timestampNs - right.event.timestampNs;
  a.sort(sort); b.sort(sort);
  const intervals = [], differences = new Int32Array(b.length + 1);
  let low = 0, high = 0;
  for (const item of a) {
    const center = item.event.timestampNs + delayNs;
    while (low < b.length && b[low].event.timestampNs < center - windowNs / 2) low++;
    high = Math.max(high, low);
    while (high < b.length && b[high].event.timestampNs <= center + windowNs / 2) high++;
    intervals.push([low, high]);
    if (high > low) { differences[low]++; differences[high]--; }
  }
  const bDegrees = new Int32Array(b.length);
  for (let i = 0, degree = 0; i < b.length; i++) { degree += differences[i]; bDegrees[i] = degree; }
  const matches = [], ambiguous = [], unmatchedA = [], usedB = new Set();
  a.forEach((item, i) => {
    const [lo, hi] = intervals[i];
    if (hi === lo) { unmatchedA.push(item.event); return; }
    if (hi - lo !== 1 || bDegrees[lo] !== 1) { ambiguous.push({ a: item.event, candidateCount: hi - lo,
      candidates: b.slice(lo, Math.min(hi, lo + 8)).map(candidate => candidate.event), candidatesTruncated: hi - lo > 8 }); return; }
    const partner = b[lo].event, deltaTimeNs = partner.timestampNs - item.event.timestampNs;
    usedB.add(lo);
    const outcomeA = (item.event.channel ?? item.event.detector)[1] === '+' ? 1 : -1;
    const outcomeB = (partner.channel ?? partner.detector)[1] === '+' ? 1 : -1;
    matches.push({ a: item.event, b: partner, deltaTimeNs, correctedDeltaNs: deltaTimeNs - delayNs,
      outcomeA, outcomeB, outcomeKey: `${outcomeA === 1 ? '+' : '-'}${outcomeB === 1 ? '+' : '-'}` });
  });
  return { matches, ambiguous, unmatchedA, unmatchedB: b.filter((_, i) => !usedB.has(i)).map(item => item.event), invalid,
    delayNs, windowNs, policy: 'Only mutually unique timestamp/channel candidates are paired; ambiguity is reported',
    usesDebugPairIds: false };
}
const emptyCounts = () => ({ '++': 0, '+-': 0, '-+': 0, '--': 0 });
export function measurementGroupKey(record) {
  return JSON.stringify([record.runId, record.settings.source, record.settings.state, record.settings.a, record.settings.b, record.settings.visibility]);
}
export class MeasurementStore {
  constructor() { this.groups = new Map(); this.committed = new Set(); this.total = 0; }
  commit(record) {
    if (!record?.commitId) throw new TypeError('A measurement commit requires a unique commitId');
    if (this.committed.has(record.commitId)) return false;
    if (!['++', '+-', '-+', '--'].includes(record.outcomeKey) || ![1, -1].includes(record.outcomeA) || ![1, -1].includes(record.outcomeB)
      || record.events?.length !== 2 || new Set(record.events.map(event => event.arm)).size !== 2) throw new TypeError('A completed ideal pair requires two valid arm outcomes and detector events');
    deepFreeze(record); // Worker structured cloning drops Object.freeze; restore store immutability.
    const key = measurementGroupKey(record);
    if (!this.groups.has(key)) this.groups.set(key, { key, runId: record.runId, settings: record.settings, total: 0, counts: emptyCounts(), records: [] });
    const group = this.groups.get(key);
    group.total++; group.counts[record.outcomeKey]++; group.records.push(record);
    this.committed.add(record.commitId); this.total++;
    return true;
  }
  commitBatch(batch) { let count = 0; for (const record of batch.records) if (this.commit(record)) count++; return count; }
  reset() { this.groups.clear(); this.committed.clear(); this.total = 0; }
  snapshot() { return { total: this.total, groups: [...this.groups.values()].map(group => ({ ...group, counts: { ...group.counts }, records: [...group.records] })) }; }
}
export function measurementStatistics(group) {
  const n = group?.total ?? 0, counts = group?.counts ?? emptyCounts();
  return { n, correlation: n ? (counts['++'] + counts['--'] - counts['+-'] - counts['-+']) / n : null,
    aPlus: n ? (counts['++'] + counts['+-']) / n : null, bPlus: n ? (counts['++'] + counts['-+']) / n : null,
    counts: { ...counts } };
}

export function runMeasurements(settings = {}, options = {}) {
  const count = options.count ?? options.pairs ?? 1_000;
  if (!Number.isSafeInteger(count) || count < 1) throw new RangeError('count must be a positive integer');
  const startId = options.startId ?? 1, context = contextFor(settings);
  const records = [], events = [], counts = emptyCounts();
  for (let i = 0; i < count; i++) {
    const record = createMeasurement(context.settings, { ...options, context, id: startId + i });
    records.push(record); events.push(...record.events); counts[record.outcomeKey]++;
    if (options.onProgress && ((i + 1) % 10_000 === 0 || i + 1 === count)) options.onProgress((i + 1) / count);
  }
  const first = records[0];
  const calibratedDelayNs = options.calibratedDelayNs ?? (first.modelReadoutTimesNs.b - first.modelReadoutTimesNs.a);
  const coincidences = timestampMatcher(events, { delayNs: calibratedDelayNs, windowNs: options.windowNs ?? 4 });
  const matchedCounts = emptyCounts();
  const histogram = new Map();
  for (const match of coincidences.matches) { matchedCounts[match.outcomeKey]++; const dt = Math.round(match.deltaTimeNs * 1e6) / 1e6; histogram.set(dt, (histogram.get(dt) ?? 0) + 1); }
  return { total: count, count, settings: context.settings, seed: options.seed ?? 2026, runId: first.runId,
    records, events, counts, matchedCounts, coincidences,
    timing: { ...first.timing, calibratedDelayNs, histogram: [...histogram].sort((a, b) => a[0] - b[0]).map(([deltaTimeNs, count]) => ({ deltaTimeNs, count })),
      units: 'nanoseconds', histogramNote: first.timing.jitterNs === 0 ? 'Ideal zero-jitter feature; no smoothing' : 'Explicitly simulated Gaussian timestamp jitter' } };
}
