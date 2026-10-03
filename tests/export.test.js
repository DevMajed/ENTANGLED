import test from 'node:test';
import assert from 'node:assert/strict';
import { createExport } from '../src/export.js';
import { samplePair, seededRng } from '../src/physics.js';
import { appendRecord, emptyDataset } from '../src/experiment.js';
test('JSON exports preserve physics settings, observations, time units and independently replayable batch seeds', () => {
  const settings = {source:'entangled',state:'singlet',a:12,b:56,visibility:.8};
  const d=emptyDataset(settings), rng=seededRng(19);
  for(let id=1;id<=20;id++)appendRecord(d,samplePair({...settings,id,emissionTimeNs:id*1e6},rng));
  const exported=JSON.parse(JSON.stringify(createExport({seed:19,settings,dataset:d,batchHistory:[{seed:109,startId:21,count:100,settings}]})));
  assert.equal(exported.seed,19);assert.equal(exported.batchHistory[0].seed,109);
  assert.deepEqual(exported.dataset.counts,d.counts);assert.deepEqual(exported.configuration,settings);
  assert.deepEqual(exported.dataset.records,d.records);
  assert.equal(exported.units.displayedTimestamps,'nanoseconds');
  assert.ok(exported.units.secondsFields.includes('events[].timestamp'));
  assert.ok(exported.units.nanosecondsFields.includes('events[].timestampNs'));
});
