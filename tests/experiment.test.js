import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyDataset, appendRecord, mergeBatch, statistics, bellSummary } from '../src/experiment.js';
const settings = { source: 'entangled', state: 'singlet', a: 0, b: 0, visibility: 1 };
const record = (a, b) => ({ settings: { ...settings }, outcomeA: a, outcomeB: b, events: [] });
test('Records derive joint and local statistics without fabricated observations', () => {
  const d = emptyDataset(settings);
  assert.equal(statistics(d).e, null);
  appendRecord(d, record(1, -1)); appendRecord(d, record(-1, 1));
  assert.deepEqual(d.counts, { '++': 0, '+-': 1, '-+': 1, '--': 0 });
  assert.equal(statistics(d).e, -1); assert.equal(statistics(d).aPlus, .5);
  assert.equal(statistics(d).bPlus, .5);
});
test('An incompatible configuration cannot silently contaminate records or batch counts', () => {
  const d = emptyDataset(settings);
  assert.throws(() => appendRecord(d, { ...record(1, -1), settings: { ...settings, b: 45 } }));
  assert.throws(() => mergeBatch(d, { settings: { ...settings, source: 'classical' }, counts: {}, records: [], total: 100 }));
  assert.equal(d.total, 0);
});
test('CHSH reports insufficient data and does not clip finite samples', () => {
  const ds = Array.from({ length: 4 }, () => emptyDataset(settings));
  assert.equal(bellSummary(ds).s, null);
  ds.forEach((d, i) => { appendRecord(d, record(1, i === 3 ? 1 : -1)); appendRecord(d, record(-1, i === 3 ? -1 : 1)); });
  assert.equal(bellSummary(ds).s, 4);
});
test('A 100,000-pair batch merges all 200,000 detector events without function argument overflow', () => {
  const d=emptyDataset(settings);
  const records=Array.from({length:100000},(_,id)=>({...record(1,-1),id,events:[{arm:'A',pairId:id},{arm:'B',pairId:id}]}));
  mergeBatch(d,{settings,records,total:100000,counts:{'++':0,'+-':100000,'-+':0,'--':0}});
  assert.equal(d.total,100000);assert.equal(d.records.length,100000);assert.equal(d.events.length,200000);
  assert.equal(d.events.at(-1).pairId,99999);assert.equal(statistics(d).e,-1);
});
