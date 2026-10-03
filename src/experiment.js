/** Authoritative, renderer-independent recorded observations. Angles: degrees; time: ns. */
export const OUTCOMES = ['++', '+-', '-+', '--'];
export function configurationKey(settings) {
  return JSON.stringify([settings.source, settings.state ?? 'singlet', settings.a, settings.b, settings.visibility ?? 1]);
}
export function emptyDataset(settings = {}) {
  return { settings: { ...settings }, counts: Object.fromEntries(OUTCOMES.map(k => [k, 0])), total: 0, events: [], records: [], last: null };
}
export function outcomeKey(record) {
  const a = record.outcomeA ?? record.aOutcome ?? record.outcomes?.a;
  const b = record.outcomeB ?? record.bOutcome ?? record.outcomes?.b;
  if (![1, -1].includes(a) || ![1, -1].includes(b)) throw new Error('A recorded detection requires two valid outcomes.');
  return (a === 1 ? '+' : '-') + (b === 1 ? '+' : '-');
}
export function appendRecord(dataset, record) {
  if (configurationKey(record.settings) !== configurationKey(dataset.settings)) throw new Error('Cannot combine incompatible measurement configurations.');
  dataset.counts[outcomeKey(record)]++;
  dataset.total++;
  dataset.last = record;
  dataset.records.push(record);
  if (record.events) dataset.events.push(...record.events);
  return dataset;
}
export function mergeBatch(dataset, batch) {
  if (configurationKey(batch.settings) !== configurationKey(dataset.settings)) throw new Error('Cannot combine incompatible batch configurations.');
  for (const key of OUTCOMES) dataset.counts[key] += batch.counts[key];
  dataset.total += batch.total;
  // Avoid function argument limits (notably Chromium) at 100k pairs / 200k events.
  dataset.records = dataset.records.concat(batch.records);
  dataset.events = dataset.events.concat(batch.records.flatMap(r => r.events ?? []));
  dataset.last = batch.records.at(-1) ?? dataset.last;
  return dataset;
}
export function statistics(dataset) {
  const c = dataset.counts, n = dataset.total;
  const e = n ? (c['++'] + c['--'] - c['+-'] - c['-+']) / n : null;
  return { n, e, se: n > 1 ? Math.sqrt(Math.max(0, 1 - e * e) / (n - 1)) : null,
    aPlus: n ? (c['++'] + c['+-']) / n : null, bPlus: n ? (c['++'] + c['-+']) / n : null,
    opposite: n ? (c['+-'] + c['-+']) / n : null,
    bPlusGivenAPlus: c['++'] + c['+-'] ? c['++'] / (c['++'] + c['+-']) : null };
}
export function bellSummary(datasets) {
  const values = datasets.map(statistics);
  if (values.some(x => x.n < 2)) return { s: null, se: null, values };
  return { s: Math.abs(values[0].e + values[1].e + values[2].e - values[3].e), se: Math.sqrt(values.reduce((sum, x) => sum + x.se ** 2, 0)), values };
}
