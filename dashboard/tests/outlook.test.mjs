import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOutlook, outlookCsv, outlookOptions, latestArchivedForecast, buildArchivedOutlook, buildArchivedCurve, archivedOutlookCsv } from '../public/outlook-core.mjs';

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
  assert.deepEqual(outlookOptions({ model: 'other', horizon: -1, lookback: Infinity }), { model: 'ridge', archiveView: 'curve', horizon: 30, lookback: 365, band: true });
});
const saved = (version = 'ridge-30d-v1', issuedAt = '2026-01-25T01:22:00Z') => ({
  id: 'saved-' + version, modelVersion: version, issuedAt,
  prediction: { date: '2026-01-24', targetDate: '2026-02-23', price: 110, predictedPrice: 120, lower: 90, upper: 150 }
});
test('独立选择两版模型最新签发记录，不依赖输入顺序且不修改原档', () => {
  const first = saved('ridge-30d-v1', '2026-01-24T01:22:00Z'), last = saved(), macro = saved('ridge-30d-macro-v1');
  const inputs = [first, macro, last], before = JSON.stringify(inputs);
  assert.equal(latestArchivedForecast(inputs, 'ridge'), last); assert.equal(latestArchivedForecast(inputs, 'macro'), macro);
  assert.equal(latestArchivedForecast(inputs, 'gbm'), null); assert.equal(latestArchivedForecast([], 'ridge'), null);
  assert.equal(JSON.stringify(inputs), before);
});
test('原模型只保留原始起点和目标价，实际更新和日线修订不会重新锚定预测', () => {
  const f = saved(), before = JSON.stringify(f), rows = fixture(400);
  const r = buildArchivedOutlook(rows, f, 'ridge', '2026-02-05');
  assert.deepEqual(r.anchor, { date: '2026-01-24', price: 110 });
  assert.equal(r.history.find(x => x.date === r.anchor.date).price, 100);
  assert.deepEqual(r.future, [{ date: '2026-01-24', ridge: 110 }, { date: '2026-02-23', ridge: 120 }]);
  assert.ok(r.latest.date > r.anchor.date); assert.equal(r.horizon, 30); assert.equal(JSON.stringify(f), before);
  const later = buildArchivedOutlook(fixture(460), f, 'ridge', '2026-04-10');
  assert.deepEqual(later.future, r.future); assert.ok(later.latest.date > f.prediction.targetDate);
});
test('留档 CSV 只导出一个预测目标，无中间每日预测值且保留签发时间和版本', () => {
  const f = saved('ridge-30d-macro-v1'), r = buildArchivedOutlook(fixture(400), f, 'macro', '2026-02-05');
  const csv = archivedOutlookCsv(r, { source: 'https://example.test', fetchedAt: '2026-02-05T12:00:00Z' });
  const lines = csv.split('\r\n');
  assert.equal(lines.length, r.history.length + 2); assert.equal(lines.filter(x => x.includes('"archived_target"')).length, 1);
  assert.ok(lines.at(-1).startsWith('"2026-02-23","archived_target","","120","90","150"'));
  assert.ok(csv.includes(f.issuedAt)); assert.ok(csv.includes(f.modelVersion)); assert.ok(csv.includes('"base_price"'));
});
test('缺少或无效留档时不冒用金融模型，缺失实际值不补造且未完成日线不显示', () => {
  const rows = fixture(400), today = rows.at(-1).date;
  assert.throws(() => buildArchivedOutlook(rows, null, 'ridge', today), /尚无/);
  assert.throws(() => buildArchivedOutlook(rows, saved(), 'macro', today), /格式无效/);
  const r = buildArchivedOutlook(rows.map((p, i) => i === 395 ? { ...p, price: null } : p), saved(), 'ridge', today);
  assert.ok(r.history.every(p => p.date < today && p.date !== rows[395].date));
});
test('历次预测曲线按目标日排序，只绘制真实留档点且不补缺失日', () => {
  const early = { ...saved(), id: 'earlier', issuedAt: '2026-01-23T01:22:00Z', prediction: { ...saved().prediction, date: '2026-01-22', targetDate: '2026-02-21', predictedPrice: 130 } };
  const inputs = [saved(), saved('ridge-30d-macro-v1'), early], before = JSON.stringify(inputs);
  const r = buildArchivedCurve(fixture(400), inputs, 'ridge', '2026-02-05');
  assert.deepEqual(r.future.map(p => [p.date, p.ridge]), [['2026-02-21', 130], ['2026-02-23', 120]]);
  assert.equal(r.future[0].forecast.issuedAt, early.issuedAt);
  assert.ok(r.future.every(p => p.date !== '2026-02-22' && p.date !== r.anchor.date));
  assert.equal(JSON.stringify(inputs), before);
  const csv = archivedOutlookCsv(r, { fetchedAt: '2026-02-05T12:00:00Z', source: 'test' });
  const targets = csv.split('\r\n').filter(l => l.includes('"archived_target"'));
  assert.equal(targets.length, 2); assert.ok(targets[0].includes(early.issuedAt)); assert.ok(targets[0].includes('"2026-01-22","110","earlier"'));
  const later = buildArchivedCurve(fixture(460), inputs, 'ridge', '2026-04-10');
  assert.deepEqual(later.future, r.future); assert.ok(later.history.some(p => p.date === '2026-02-21'));
});
test('单份留档仍只有一个预测点，其他模型或无效预测不能混入曲线', () => {
  assert.equal(buildArchivedCurve(fixture(400), [saved()], 'ridge', '2026-02-05').future.length, 1);
  assert.throws(() => buildArchivedCurve(fixture(400), [saved()], 'macro', '2026-02-05'), /尚无/);
  assert.throws(() => buildArchivedCurve(fixture(400), [{ ...saved(), prediction: { ...saved().prediction, predictedPrice: null } }], 'ridge', '2026-02-05'), /格式无效/);
});
