import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateComparisons, compareForecast, readTracking, shouldRunScheduled, newYorkClock, writeOnce, recordRun } from '../tracking.mjs';
import { createTrackingJob } from '../tracking-job.mjs';

const source = 'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics';
const raw = (date, price) => ({ date, price });
const now = new Date('2026-10-18T13:00:00Z');
const input = (rows, date = now.toISOString()) => ({ rows, state: 'fresh', source, fetchedAt: date });
async function seed(root) {
  const f = { id: '2026-10-18__test-v1', modelVersion: 'test-v1', issuedAt: now.toISOString(), source,
    prediction: { date: '2026-10-17', targetDate: '2026-11-16', price: 100, predictedPrice: 120, lower: 80, upper: 140 } };
  const path = join(root, 'forecasts/2026-10-18/test-v1.json');
  await writeOnce(path, JSON.stringify(f));
  await writeOnce(join(root, 'inputs/original.json.gz'), 'immutable original input');
  return path;
}
test('只更新实际值，重复或并发执行不改变原预测及输入，修订另存观测', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bitindex-compare-')), path = await seed(root);
  const before = await readFile(path, 'utf8'), snapshot = input([raw('2026-10-17', 100)]);
  await Promise.all([updateComparisons(root, snapshot, { now }), updateComparisons(root, snapshot, { now })]);
  const first = await readTracking(root);
  assert.equal(first.total, 1); assert.equal(first.comparisons.length, 1); assert.equal(first.pending, 1);
  assert.equal(first.comparisons[0].absoluteErrorPct, null);
  const nextDay = new Date('2026-10-19T13:00:00Z');
  const result = await updateComparisons(root, input([raw('2026-10-17', 105), raw('2026-10-18', 110)], nextDay.toISOString()), { now: nextDay });
  assert.equal(result.archived, false); assert.equal(result.mode, 'comparison-only');
  assert.equal(await readFile(path, 'utf8'), before);
  assert.equal(await readFile(join(root, 'inputs/original.json.gz'), 'utf8'), 'immutable original input');
  const view = await readTracking(root);
  assert.equal(view.total, 1); assert.equal(view.comparisons.find(c => c.date === '2026-10-17').actualPrice, 100);
  assert.equal(JSON.parse(await readFile(join(root, result.observationPath), 'utf8')).rows[0].price, 105);
  assert.equal(view.latestActual.price, 110);
  assert.equal((await readdir(join(root, 'inputs'))).length, 1);
});
test('补齐错过的实际价格，以精确目标日结算；后续日期不改变结算', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bitindex-mature-')); await seed(root);
  await updateComparisons(root, input([raw('2026-10-17', 100)]), { now });
  const late = input([raw('2026-10-17', 100), raw('2026-10-18', 110), raw('2026-11-16', 150), raw('2026-11-17', 999)], '2026-11-18T13:00:00Z');
  await updateComparisons(root, late, { now: new Date('2026-11-18T13:00:00Z') });
  const view = await readTracking(root), settled = view.forecasts[0].comparison;
  assert.equal(view.total, 1); assert.equal(view.settled, 1); assert.equal(settled.date, '2026-11-16'); assert.equal(settled.actualPrice, 150);
  assert.ok(Math.abs(settled.absoluteErrorPct - 20) < 1e-10); assert.equal(settled.directionCorrect, true); assert.equal(settled.intervalHit, false);
  assert.equal(view.comparisons.length, 3);
  assert.equal(view.versions[0].settled, 1);
});
test('缺失目标日不拿最近价格代替；中途仅显示目标差距', () => {
  const f = { id: 'test', modelVersion: 'v1', prediction: { date: '2026-10-17', targetDate: '2026-11-16', price: 100, predictedPrice: 120, lower: null, upper: null } };
  const pending = compareForecast(f, { date: '2026-11-15', price: 110 }, 'now');
  assert.equal(pending.errorPct, null); assert.equal(pending.status, 'tracking'); assert.ok(pending.targetGapPct > 0);
  assert.equal(compareForecast(f, { date: '2026-11-17', price: 125 }, 'now'), null);
});
test('未完成 UTC 日线和无效价格不进入实际对照，滞后日线可补齐并重试', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bitindex-delayed-')); await seed(root);
  const snapshot = input([raw('2026-10-17', 100), raw('2026-10-18', 999), raw('2026-10-19', -1)]);
  const r = await updateComparisons(root, snapshot, { now });
  assert.equal(r.dataThrough, '2026-10-17'); assert.equal(r.status, 'success');
  assert.equal((await readTracking(root)).comparisons.length, 1);
  assert.equal((await updateComparisons(root, snapshot, { now: new Date('2026-10-22T13:00:00Z') })).status, 'delayed');
  assert.equal(await shouldRunScheduled(root, new Date('2026-10-22T14:00:00Z')), true);
});
test('缓存或断网不冒充刚获取的实际数据', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bitindex-stale-')); await seed(root);
  for (const state of ['stale', 'cached']) {
    assert.equal((await updateComparisons(root, { ...input([raw('2026-10-17', 999)]), state }, { now })).status, 'stale');
  }
  const view = await readTracking(root);
  assert.equal(view.comparisons.length, 0); assert.equal(view.latestActual, null); assert.equal(view.total, 1);
  await assert.rejects(readdir(join(root, 'observations')), { code: 'ENOENT' });
});
test('没有历史预测时任务不会训练、创建预测或输入快照', async () => {
  const project = await mkdtemp(join(tmpdir(), 'bitindex-job-'));
  const d = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const job = createTrackingJob(project, () => { throw new Error('must never train'); });
  const result = await job.run(input([raw(d, 100)], new Date().toISOString()));
  assert.equal(result.total, 0); assert.equal(result.archived, false);
  for (const folder of ['forecasts', 'inputs']) await assert.rejects(readdir(join(project, 'predictions', folder)), { code: 'ENOENT' });
});
test('纽约夏令时与每日去重；旧预测任务成功不抑制新的对照任务', async () => {
  assert.equal(newYorkClock(now).hour, 9);
  assert.equal(newYorkClock(new Date('2026-11-18T14:00:00Z')).hour, 9);
  const root = await mkdtemp(join(tmpdir(), 'bitindex-schedule-'));
  assert.equal(await shouldRunScheduled(root, new Date('2026-10-18T12:59:00Z')), false);
  await recordRun(root, { scope: 'daily', status: 'success', dataThrough: '2026-10-17' }, now);
  assert.equal(await shouldRunScheduled(root, now), true);
  await updateComparisons(root, input([raw('2026-10-17', 100)]), { now });
  assert.equal(await shouldRunScheduled(root, new Date('2026-10-18T14:00:00Z')), false);
  assert.equal(await shouldRunScheduled(root, new Date('2026-10-19T13:00:00Z')), true);
});
test('独占写入不会留下半文件或覆盖先写内容', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bitindex-once-')), path = join(root, 'record.json');
  const results = await Promise.all([writeOnce(path, 'first'), writeOnce(path, 'second')]);
  assert.equal(results.filter(Boolean).length, 1); assert.ok(['first', 'second'].includes(await readFile(path, 'utf8')));
});
