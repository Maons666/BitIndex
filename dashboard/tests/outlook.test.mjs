import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOutlook, outlookCsv, outlookOptions } from '../public/outlook-core.mjs';

const DAY = 86400000, start = Date.parse('2025-01-01');
const fixture = (n = 400, growth = () => 0) => {
  let price = 100;
  return Array.from({ length: n }, (_, i) => { if (i) price *= Math.exp(growth(i)); return { date: new Date(start + i * DAY).toISOString().slice(0, 10), price }; });
};
const close = (a, b, tolerance = 1e-10) => assert.ok(Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(b)), `${a} != ${b}`);
test('常量价格时三模型、均值、中位数与区间全部维持原价格', () => {
  const r = buildOutlook(fixture(), { horizon: 90 }, '2026-10-31');
  assert.equal(r.future.length, 91); assert.equal(r.lookback, 365); assert.equal(r.parameters.dailyVolatility, 0);
  for (const p of r.future) for (const key of ['gbm', 'median', 'lower', 'upper', 'trend', 'baseline']) close(p[key], 100);
});
test('确定性对数增长符合闭式解，所有曲线从实际收盘处开始', () => {
  const rows = fixture(400, () => .001), r = buildOutlook(rows, { lookback: 90, horizon: 30 }, '2026-10-31');
  close(r.parameters.logDrift, .001); close(r.parameters.trendSlope, .001);
  const last = r.future.at(-1); close(last.gbm, rows.at(-1).price * Math.exp(.03)); close(last.trend, last.gbm);
  for (const key of ['gbm', 'median', 'lower', 'upper', 'trend', 'baseline']) assert.equal(r.future[0][key], rows.at(-1).price);
  assert.equal(Date.parse(last.date) - Date.parse(r.anchor.date), 30 * DAY);
});
test('GBM 对数正态均值修正、样本方差和区间平方根时间尺度可手算', () => {
  const r = buildOutlook(fixture(400, i => i % 2 ? .01 : -.01), { lookback: 90, horizon: 90 }, '2026-10-31');
  const variance = 90 * .0001 / 89;
  close(r.parameters.logDrift, 0); close(r.parameters.dailyVolatility ** 2, variance);
  close(r.parameters.annualVolatility, Math.sqrt(variance * 365));
  const p = r.future[30]; close(p.gbm / r.anchor.price, Math.exp(variance * 30 / 2)); close(p.median, r.anchor.price);
  close(Math.log(p.upper / p.median), 1.959963984540054 * Math.sqrt(variance * 30));
  close(p.lower * p.upper, p.median ** 2); assert.ok(p.gbm > p.median);
});
test('当前未完成日线和未来数据不会进入估计，缺日及非正价格不插值', () => {
  const rows = fixture(400, i => .002 * Math.sin(i)), today = new Date(start + 400 * DAY).toISOString().slice(0, 10);
  const first = buildOutlook(rows, { lookback: 90 }, today);
  assert.deepEqual(buildOutlook([...rows, { date: today, price: 1e100 }], { lookback: 90 }, today), first);
  assert.throws(() => buildOutlook(rows.filter((_, i) => i !== 390), { lookback: 90 }, today), /缺失/);
  assert.throws(() => buildOutlook(rows.map((r, i) => i === 399 ? { ...r, price: null } : r), { lookback: 90 }, today), /无效/);
  assert.throws(() => buildOutlook(rows.slice(-50), { lookback: 90 }, today), /需要/);
});
test('CSV 区分实际与未来，并保留模型口径、输入时间和来源', () => {
  const r = buildOutlook(fixture(), { horizon: 7, lookback: 90 }, '2026-10-31');
  const csv = outlookCsv(r, { fetchedAt: '2026-10-30T10:00:00Z', source: 'https://example.test/data' });
  const lines = csv.split('\r\n');
  assert.equal(lines.length, 1 + 91 + 7); assert.ok(lines[1].includes('"actual","100"'));
  assert.ok(lines.at(-1).includes('"model","",')); assert.ok(lines.at(-1).includes('financial-outlook-v1'));
  assert.ok(csv.includes('gbm_mean')); assert.ok(csv.includes('gbm_median')); assert.ok(csv.includes('2026-10-30T10:00:00Z'));
});
test('持久化参数中的无效模型与窗口恢复默认值', () => {
  assert.deepEqual(outlookOptions({ model: 'other', horizon: -1, lookback: Infinity }), { model: 'gbm', horizon: 30, lookback: 365, band: true });
});
