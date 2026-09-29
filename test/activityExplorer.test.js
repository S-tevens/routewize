import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

function harness() {
  class Node {
    constructor() { this.children = []; this.listeners = {}; this.value = ''; this.textContent = ''; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren() { this.children = []; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    click() {}
  }
  const nodes = new Map(), events = {}, blobs = [];
  const get = id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  get('activityOutcome').value = 'all';
  vm.runInNewContext(readFileSync(new URL('../public/activity-explorer.js', import.meta.url), 'utf8'), {
    document: {getElementById:get, createElement:()=>new Node()}, window:{addEventListener:(name,fn)=>events[name]=fn},
    Blob, URL:{createObjectURL:blob=>{blobs.push(blob);return 'blob:test';},revokeObjectURL(){}}, setTimeout:fn=>fn(), Date
  });
  return {get,events,blobs};
}
const sample = {
  daily:[{requests:4,cacheHits:1,routedCheaper:2,savings:-0.1,tokensRemoved:32,date:'2026-09-29'}], start:'2026-09-29',end:'2026-09-29',
  recent:[{timestamp:'2026-09-29T12:00:00Z',model_requested:'=UNTRUSTED()',model_used:'small',matched_rule:'cheap',estimated_savings:-0.1}, {timestamp:'2026-09-28T12:00:00Z',model_used:'old'}, {timestamp:'invalid'}]
};
test('activity summary uses daily totals, filters recent sample, and clears tenant data', () => {
  const h=harness(); h.events['activity-data']({detail:sample});
  assert.equal(h.get('explorerCache').textContent,'25.0%');
  assert.equal(h.get('explorerRouted').textContent,'50.0%');
  assert.match(h.get('explorerCount').textContent,/1 matching/);
  h.get('activitySearch').value='missing'; h.get('activitySearch').listeners.input();
  assert.equal(h.get('exportRecent').disabled,true);
  h.events['activity-reset']();
  assert.equal(h.get('explorerCache').textContent,'—');
  assert.equal(h.get('explorerRows').children.length,0);
  assert.equal(h.get('exportDaily').disabled,true);
});
test('CSV exports neutralize model formulas and preserve negative numeric savings', async () => {
  const h=harness(); h.events['activity-data']({detail:sample});
  h.get('exportRecent').listeners.click();
  const text=await h.blobs[0].text();
  assert.ok(text.includes('"\'=UNTRUSTED()"'));
  assert.ok(text.includes('"-0.1"'));
  assert.ok(!text.includes('old'));
});
