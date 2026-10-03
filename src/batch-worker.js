import { samplePair, seededRng, runQKD } from './physics.js';
import { emptyDataset, appendRecord } from './experiment.js';

self.onmessage = ({ data: job }) => {
  try {
    const rng = seededRng(job.seed);
    let result;
    if (job.type === 'qkd') {
      result = runQKD({ ...job.settings, pairs: job.count, seed: job.seed, interceptProbability: job.eve, sampleFraction: .2 });
    } else if (job.type === 'bell') {
      const angles = [[0, 22.5], [0, -22.5], [45, 22.5], [45, -22.5]];
      const datasets = angles.map(([a, b]) => emptyDataset({ ...job.settings, a, b }));
      for (let i = 0; i < job.count; i++) {
        // Independent local setting choices, followed by a fresh-pair Born sample.
        const ai = rng() < .5 ? 0 : 1, bi = rng() < .5 ? 0 : 1;
        const d = datasets[ai * 2 + bi];
        appendRecord(d, samplePair({ ...d.settings, id: job.startId + i, emissionTimeNs: (job.startId + i) * 1e6 }, rng));
      }
      result = datasets;
    } else if (job.type === 'sweep') {
      result = [];
      for (let b = 0; b <= 180; b += 10) {
        const d = emptyDataset({ ...job.settings, a: job.settings.a, b });
        for (let i = 0; i < job.count; i++) appendRecord(d, samplePair({ ...d.settings, id: i + 1, emissionTimeNs: i * 1e6 }, rng));
        result.push(d);
      }
    } else if (job.type === 'signal') {
      const d = emptyDataset({ ...job.settings, a: job.bit ? 45 : 0, b: 0 });
      for (let i = 0; i < job.count; i++) appendRecord(d, samplePair({ ...d.settings, id: job.startId + i, emissionTimeNs: (job.startId + i) * 1e6 }, rng));
      result = d;
    } else {
      result = emptyDataset(job.settings);
      for (let i = 0; i < job.count; i++) appendRecord(result, samplePair({ ...job.settings, id: job.startId + i, emissionTimeNs: (job.startId + i) * 1e6 }, rng));
    }
    self.postMessage({ id: job.id, type: job.type, result, seed: job.seed, count: job.count });
  } catch (error) { self.postMessage({ id: job.id, error: error.message }); }
};
