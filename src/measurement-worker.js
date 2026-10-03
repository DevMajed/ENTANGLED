import { runMeasurements } from './measurement.js';
self.onmessage = ({ data: job }) => {
  try {
    const startedAt = performance.now();
    const result = runMeasurements(job.settings, { ...job.timing, count: job.count, seed: job.seed, startId: job.startId,
      runId: job.runId, onProgress: progress => self.postMessage({ id: job.id, progress: Math.round(progress * job.count), fraction: progress }) });
    self.postMessage({ id: job.id, result, elapsedMs: performance.now() - startedAt });
  } catch (error) { self.postMessage({ id: job.id, error: error.message }); }
};
