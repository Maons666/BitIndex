import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReplay, selectReplayEvents } from '../replay.mjs';
import { evaluationSummary, evaluateRow, liveEvaluationRows } from '../public/evaluation-core.mjs';
const DAY = 86400000;
function fixture() {
  return { id: 'test-replay', reconstructedAt: '2026-11-14T04:00:00Z', targetStart: '2026-10-14', targetEnd: '2026-10-16',
    market: { source: 'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics', fetchedAt: '2026-11-13T12:00:00Z', rows: Array.from({length: 400}, (_, i) => ({date: new Date(Date.parse('2026-11-12') - (399-i)*DAY).toISOString().slice(0,10), price: 60000*Math.exp(i*.0005 + Math.sin(i)*.01)})) },
    evidence: { author: 'test agent', coverageStart: '2026-08-17', coverageEnd: '2026-10-13', coverageGaps: ['test'], events: [{ id:'flow', stream:'flows', category:'flows', kind:'fund-outflow', publishedAt:'2026-09-12T00:00:00Z', availableAt:'2026-09-13T00:00:00Z', verifiedAt:'2026-11-14T03:00:00Z', title:'outflow', fact:'observed', inference:'pressure', rationale:'fixed', url:'https://example.com/report', direction:-1, confidence:.6, similarity:.5, novelty:.5 }] },
    cases:[{id:'old', title:'old', kind:'fund-outflow', publishedAt:'2026-06-01T23:59:59Z'}] };
}
test('回放保留今天核查时间；逐日目标等于历史截止日加30日，使用滞后2日行情', () => {
  const r=buildReplay(fixture()); assert.equal(r.rows.length,3); assert.equal(r.mode,'retrospective-current-model');
  assert.equal(r.rows[0].asOf,'2026-09-14T16:00:00.000Z'); assert.equal(r.rows[0].anchor.date,'2026-09-12');
  assert.equal(r.evidence.events[0].verifiedAt,'2026-11-14T03:00:00Z');
  assert.ok(r.rows.every(x=>!('issuedAt' in x) && Date.parse(x.targetDate)-Date.parse(x.asOf.slice(0,10))===30*DAY));
});
test('修改截止后的行情与未来事件不会改变历史预测或案例等级', () => {
  const a=fixture(), before=buildReplay(a), b=structuredClone(a);
  b.market.rows.filter(r=>r.date>'2026-09-14').forEach(r=>r.price*=5);
  b.evidence.events.push({...a.evidence.events[0],id:'future',publishedAt:'2026-10-01T00:00:00Z',availableAt:'2026-10-02T00:00:00Z',direction:1});
  const after=buildReplay(b);
  before.rows.forEach((r,i)=>{ assert.equal(after.rows[i].base,r.base); assert.deepEqual(after.rows[i].events,r.events); assert.equal(after.rows[i].libraryFingerprint,r.libraryFingerprint); });
  assert.notEqual(after.rows[0].actualPrice,before.rows[0].actualPrice);
});
test('历史同类案例只使用当时已完成的窗口；同一新闻流只保留最新可用版本', () => {
  const a=fixture(); a.cases[0].publishedAt='2026-09-01T00:00:00Z';
  assert.equal(buildReplay(a).rows[0].events[0].count,0);
  const e=a.evidence.events[0], updated={...e,id:'updated',availableAt:'2026-09-15T00:00:00Z'};
  assert.deepEqual(selectReplayEvents([e,updated],'2026-09-14T16:00:00Z').map(e=>e.id),['flow']);
  assert.deepEqual(selectReplayEvents([e,updated],'2026-09-15T16:00:00Z').map(e=>e.id),['updated']);
});
test('缺失精确目标日、价格缺日、证据未覆盖与伪造核查时间均拒绝', () => {
  const a=fixture(); a.market.rows=a.market.rows.filter(r=>r.date!=='2026-10-15'); assert.throws(()=>buildReplay(a),/精确目标日/);
  const b=fixture(); b.market.rows=b.market.rows.filter(r=>r.date!=='2026-09-01'); assert.throws(()=>buildReplay(b),/缺日/);
  const c=fixture(); c.evidence.coverageStart='2026-09-01'; assert.throws(()=>buildReplay(c),/未覆盖/);
  const d=fixture(); d.evidence.events[0].verifiedAt='2026-11-15T00:00:00Z'; assert.throws(()=>buildReplay(d),/无效/);
});
test('误差符号、等样本基线和未到期真实预测处理正确', () => {
  const rows=[{base:110,noEvents:120,unchanged:100,weak:90,strong:130,actualPrice:100},{base:90,noEvents:80,unchanged:100,weak:70,strong:110,actualPrice:100},{base:999,noEvents:999,unchanged:999,actualPrice:null}];
  assert.ok(Math.abs(evaluateRow(rows[0]).signedErrorPct-10)<1e-12); assert.equal(evaluateRow(rows[1]).dollarError,-10);
  const s=evaluationSummary(rows); assert.equal(s.count,2); assert.ok(Math.abs(s.mape-10)<1e-12); assert.equal(s.unchangedMape,0); assert.equal(s.eventWinPct,100);
  const data={forecasts:[{id:'real',issuedAt:'2026-11-01T00:00:00Z',anchor:{price:100},events:[],horizons:[{horizon:30,targetDate:'2026-12-01',base:110}]}],comparisons:[{forecastId:'real',horizon:30,date:'2026-11-30',actualPrice:95,status:'tracking'}]};
  assert.equal(liveEvaluationRows(data)[0].actualPrice,null); data.comparisons.push({...data.comparisons[0],date:'2026-12-01',status:'settled'}); assert.equal(liveEvaluationRows(data)[0].actualPrice,95);
});
