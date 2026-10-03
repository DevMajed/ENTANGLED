/** Portable, explicit record units and the seed of every independently sampled job. */
export function createExport({ seed, settings, dataset, batchHistory = [], bellDatasets = null, sweepData = [], signalRuns = [], qkdResult = null }) {
  return {
    format: 'ENTANGLED/1',
    model: 'Singlet and separable HV/VH mixture; optional depolarizing white noise',
    units: { angles: 'degrees', displayedTimestamps: 'nanoseconds',
      secondsFields: ['emittedAt', 'timestampA', 'timestampB', 'events[].timestamp'],
      nanosecondsFields: ['emissionTimeNs', 'timestamps.a', 'timestamps.b', 'events[].timestampNs'] },
    seed, batchHistory, prng: 'Mulberry32; seeded pseudorandom, not cryptographic',
    configuration: { ...settings }, dataset, bellDatasets, sweepData, signalRuns, qkdResult,
    simulationTime: 'Emission time plus optical flight; independent of animation playback',
    limitations: ['Ideal complete detection', 'Truth-paired events; timestamp-only instrument mode deferred', 'BBM92 retained candidates; authentication, reconciliation, privacy amplification and security analysis required']
  };
}

// Copy plain JSON data without stringify/parse passes over a potentially 100,000-pair log.
// Neither the exported snapshot nor later store additions can change the other object.
function copyData(value) {
  if (Array.isArray(value)) return value.map(copyData);
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, child] of Object.entries(value)) if (child !== undefined) result[key] = copyData(child);
    return result;
  }
  return value;
}

/**
 * Export committed measurement runs, rather than the queued settings for a future pair.
 * Large coherent vectors and theoretical probabilities occur once per captured-settings
 * group. Each record inherits them from its containing group and retains its actual
 * outcome, seed, immutable commit identity and complete timing/channel information.
 */
export function createMeasurementExport({ store, seed, timing = {}, captionOverrides = {}, layout = {} }) {
  if (!store || typeof store.snapshot !== 'function') throw new TypeError('A measurement export requires a MeasurementStore');
  const snapshot = store.snapshot();
  const groups = snapshot.groups.map(group => {
    const first = group.records[0];
    return {
      key: group.key,
      runId: group.runId,
      settings: copyData(group.settings),
      total: group.total,
      counts: copyData(group.counts),
      jointProbabilities: copyData(first?.jointProbabilities ?? {}),
      polarizationPathState: copyData(first?.polarizationPathState ?? null),
      records: group.records.map(record => {
        // These fields are identical for the whole group, not separate samples.
        const { settings, jointProbabilities, polarizationPathState, source, state, a, b, visibility, ...individual } = record;
        return copyData(individual);
      }),
    };
  });
  return {
    format: 'ENTANGLED/2',
    model: 'Joint-state Born probabilities; coherent ideal PBS; ideal destructive single-pair detection',
    units: {
      angles: 'degrees',
      emittedAt: 'seconds',
      modelDetectionTimes: 'nanoseconds',
      readoutTimestamps: 'nanoseconds',
      sourceRate: 'pairs per second',
      secondsFields: ['emittedAt', 'timestampA', 'timestampB'],
      nanosecondsFields: ['emissionTimeNs', 'modelDetectionTimesNs.a', 'modelDetectionTimesNs.b',
        'absorptionTimesNs.a', 'absorptionTimesNs.b', 'modelReadoutTimesNs.a', 'modelReadoutTimesNs.b',
        'readoutTimestampsNs.a', 'readoutTimestampsNs.b', 'events[].timestampNs',
        'events[].modelDetectionTimeNs', 'events[].modelReadoutTimeNs'],
      nanosecondsDurationFields: ['timing.delayNs', 'timing.opticalDelayNs', 'timing.jitterNs',
        'timing.readoutLatencyNs', 'timing.windowNs'],
      coincidenceWindow: 'Total width W; |tB - tA - calibrated offset| <= W/2',
    },
    seed: copyData(seed),
    prng: 'Mulberry32; record seed and pair id identify independent outcome/timing streams; not cryptographic',
    recordSchema: {
      inheritedFromGroup: ['settings', 'jointProbabilities', 'polarizationPathState'],
      identity: 'commitId is unique per measured pair; replay does not add another record',
      debugIdentifiers: 'Pair ids are simulator ground truth; coincidence matching uses timestamps and channels',
    },
    groups: { total: snapshot.total, groups },
    timing: copyData(timing),
    captionOverrides: copyData(captionOverrides),
    layout: copyData(layout),
    simulationTime: 'Captured model event times and readout timestamps are independent of presentation playback speed',
    limitations: ['Ideal complete detection', 'Optional timestamp jitter is explicitly simulated',
      'Timing correlation alone does not demonstrate polarization entanglement', 'Quantum-model simulation, not an experimental proof'],
  };
}
