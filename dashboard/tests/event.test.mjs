import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildEventForecast, compareEventForecast } from '../event-model.mjs';
import { measureCase, matchHistory, impactLevel, detectMoves } from '../event-library.mjs';
import { publishAnalysis } from '../publish-analysis.mjs';
import { readEventForecasts, updateEventComparisons, readEventData } from '../event-store.mjs';
const DAY = 86400000, now = new Date('2026-11-12T16:00:00Z');
const market = () => ({ version: 1, source: 'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics', fetchedAt: '2026-11-11T15:00:00Z', rows: Array.from({ length: 400 }, (_, i) => ({ date: new Date(Date.parse('2026-11-10') - (399-i)*DAY).toISOString().slice(0,10), price: 60000*Math.exp(i*.0001+Math.sin(i)*.01) })) });
const event = () => ({ id:'flow', category:'flows', kind:'fund-outflow', publishedAt:'2026-11-10T13:00:00Z', verifiedAt:'2026-11-12T15:00:00Z', title:'Test facts', fact:'Observed', inference:'Assumed impact', rationale:'Uncalibrated', url:'https://example.com/source', direction:-1, confidence:.5, similarity:.5, novelty:.5 });
const analysis = () => ({ id:'test-issue', author:'test agent', cutoffAt:'2026-11-12T15:00:00Z', summary:'Test scenarios', coverageGaps:['Uncertain'], events:[event()] });
const library = () => ({ cases:[{ id:'past', kind:'fund-outflow', publishedAt:'2026-06-01T12:00:00Z', title:'Historical flow', outcomes:[7,30].map(horizon=>({ horizon, status:'observed', targetDate:'2026-07-01', level:4, standardizedMove:-2.5, direction:-1, returnPct:-12 })) }] });
test('事件预测签发后 7/30 日固定目标，未知事件不编造等级', () => {
  const f=buildEventForecast(analysis(),market(),{now});
  assert.deepEqual(f.horizons.map(h=>h.targetDate),['2026-11-19','2026-12-12']);
  assert.equal(f.anchor.date,'2026-11-10'); assert.equal(f.horizons[0].elapsedFromAnchor,9);
  assert.equal(f.events[0].classifications[0].label,'待积累');
  assert.equal(f.horizons[0].base,f.horizons[0].noEvents);
  for(const h of f.horizons) assert.ok(h.weak<h.base && h.base<h.strong);
});
test('历史匹配只用已到期同类案例；小样本收缩、重复新闻不放大', () => {
  const a=analysis(), m={...market(),eventLibrary:library()}, f=buildEventForecast(a,m,{now});
  assert.equal(f.events[0].classifications[0].level,4); assert.equal(f.events[0].classifications[0].reliability,1/6);
  assert.ok(f.horizons[0].base<f.horizons[0].noEvents);
  a.events.push({...event(),id:'duplicate'});
  assert.equal(buildEventForecast(a,m,{now}).horizons[0].base,f.horizons[0].base);
  const future=library(); future.cases[0].outcomes[0].targetDate='2026-11-13';
  assert.equal(matchHistory(event(),future,7,a.cutoffAt).count,0);
});
test('拒绝未来信息、过期分析、缺日与过期价格', () => {
  const a=analysis(); a.events[0].publishedAt='2026-11-13T00:00:00Z';
  assert.throws(()=>buildEventForecast(a,market(),{now}),/时间/);
  const old=analysis();old.cutoffAt='2026-11-08T00:00:00Z';assert.throws(()=>buildEventForecast(old,market(),{now}),/24/);
  const gap=market();gap.rows.splice(-10,1);assert.throws(()=>buildEventForecast(analysis(),gap,{now}),/缺日/);
  const stale=market();stale.rows=stale.rows.slice(0,-10);assert.throws(()=>buildEventForecast(analysis(),stale,{now}),/3 天/);
});
test('只在精确目标日结算；未来实际值不改变原目标', () => {
  const f=buildEventForecast(analysis(),market(),{now}), h=f.horizons[0];
  assert.deepEqual(compareEventForecast(f,{date:'2026-11-11',price:70000}),[]);
  assert.equal(compareEventForecast(f,{date:'2026-11-18',price:70000})[0].absoluteErrorPct,null);
  const c=compareEventForecast(f,{date:h.targetDate,price:h.base})[0];
  assert.equal(c.absoluteErrorPct,0);assert.equal(c.status,'settled');assert.equal(c.envelopeHit,true);
  assert.equal(compareEventForecast(f,{date:'2026-11-20',price:70000}).length,1);
});
test('事件留档不可覆盖，修改预测会校验失败；实际修订不改首次对照', async () => {
  const root=await mkdtemp(join(tmpdir(),'events-')), archiveRoot=join(root,'archive'), trackingRoot=join(root,'tracking');
  const f=await publishAnalysis(analysis(),{...market(),eventLibrary:library()},{root:archiveRoot,now});
  assert.equal((await readEventForecasts(archiveRoot)).length,1);
  await assert.rejects(publishAnalysis(analysis(),market(),{root:archiveRoot,now}),/不能重写/);
  await mkdir(join(trackingRoot,'actuals'),{recursive:true});
  const actual=join(trackingRoot,'actuals','2026-11-19.json');
  await writeFile(actual,JSON.stringify({date:'2026-11-19',price:70000,observedAt:'2026-11-20T12:00:00Z'}));
  await updateEventComparisons(trackingRoot,{archiveRoot});
  await writeFile(actual,JSON.stringify({date:'2026-11-19',price:71000}));
  await updateEventComparisons(trackingRoot,{archiveRoot});
  assert.equal((await readEventData(trackingRoot,{archiveRoot})).comparisons[0].actualPrice,70000);
  const path=join(archiveRoot,'forecasts',f.id+'.json'); await writeFile(path,'{}');
  await assert.rejects(readEventForecasts(archiveRoot),/被修改/);
});
test('历史等级用事前波动；后续行情不能改变已观察窗口结果', () => {
  const m=market(), d={id:'case',kind:'flows',publishedAt:'2026-06-01T23:59:59Z'};
  const before=measureCase(d,m.rows);
  m.rows.filter(r=>r.date>'2026-07-01').forEach(r=>r.price*=100);
  assert.deepEqual(measureCase(d,m.rows),before);
  assert.deepEqual([.4,.7,1.5,2.5].map(impactLevel),[1,2,3,4]);
  assert.ok(detectMoves(m.rows).every(c=>['needs-research','case-nearby-not-causal-proof'].includes(c.status)));
});
