import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitRidge, predict, buildModel, evaluateBacktest, vector, modelCsv } from '../model.mjs';
import { DAY, compute } from '../public/core.mjs';

function near(a, b) { assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`); }
function fixture(n = 1800) {
  return Array.from({ length: n }, (_, i) => {
    const price = 100 * Math.exp(i * .001 + .2 * Math.sin(i / 90) + .04 * Math.cos(i / 7));
    return { date: new Date(Date.UTC(2010, 6, 18) + i * DAY).toISOString().slice(0, 10), price, mvrv: 2 + .5 * Math.sin(i / 80), issuance: 100, issuanceUSD: price * 100, hashrate: 1000 + i };
  });
}
test('岭回归与一维闭式解一致，常量特征不影响截距', () => {
  const samples = [-1, 0, 1].map(x => ({ x: [x, 5], y: 2 + 3 * x }));
  const fit = fitRidge(samples, 3);
  near(predict(fit, [1, 5]), 3.5); near(predict(fit, [0, 5]), 2); near(fit.weights[1], 0);
  near(fit.means[0], 0); near(fit.scales[0], Math.sqrt(2 / 3));
  assert.throws(() => fitRidge([{ x: [NaN], y: 1 }, { x: [1], y: 2 }]));
});
test('训练标签严格早于预测日，特征滞后一天，测试期不重叠', () => {
  const model = buildModel(fixture());
  assert.ok(model.history.length >= 10);
  for (const [i, row] of [...model.history, model.current].entries()) {
    assert.ok(row.trainLabelEnd < row.date); assert.ok(row.trainEnd < row.trainLabelEnd);
    assert.equal(Date.parse(row.date) - Date.parse(row.featureDate), DAY);
    assert.equal(Date.parse(row.targetDate) - Date.parse(row.date), 30 * DAY);
    assert.ok(row.trainingN >= 730); assert.ok(row.index > 0 && row.index < 100);
    if (i && i < model.history.length) assert.ok(row.date >= model.history[i - 1].targetDate);
  }
});
test('追加未来暴涨不能改变已发出的预测、标准化或误差区间', () => {
  const raw = fixture(2200), cutoff = 1850, prior = buildModel(raw.slice(0, cutoff));
  const full = buildModel(raw.map((r, i) => i < cutoff ? r : { ...r, price: r.price * 10, mvrv: 15, issuanceUSD: r.issuanceUSD * 10 }));
  assert.deepEqual(full.history.filter(r => r.targetDate <= raw[cutoff - 1].date), prior.history);
  const issued = full.history.find(r => r.date === prior.history.at(-1).date);
  assert.deepEqual(issued, prior.history.at(-1));
});
test('最新预测与同日历史回放完全一致，区间只使用已知样本外残差', () => {
  const raw = fixture(2300), full = buildModel(raw), historic = full.history.at(-2);
  const prefix = raw.filter(r => r.date <= historic.date), replay = buildModel(prefix);
  const { actualPrice, actualLogReturn, ...issued } = historic;
  assert.deepEqual(replay.current, issued);
  assert.equal(issued.calibrationN, full.history.filter(r => r.targetDate < issued.date).length);
  assert.ok(issued.calibrationN >= 20); assert.ok(issued.lower <= issued.predictedPrice && issued.upper >= issued.predictedPrice);
});
test('缺失特征不填充，训练不足明确失败', () => {
  assert.equal(vector({}), null); assert.throws(() => buildModel(fixture(800)), /训练样本/);
  const raw = fixture(), last = raw.at(-1); raw.at(-2).mvrv = null;
  const model = buildModel(raw); assert.ok(model.current.date < last.date);
  assert.equal(vector(compute(raw).at(-2)), null);
});
test('回测指标可手算，导出保留标签截止日期与模型版本', () => {
  const stats = evaluateBacktest([{ date: '2025-01-01', targetDate: '2025-01-31', price: 100, predictedPrice: 100, actualPrice: 200, predictedLogReturn: 0, actualLogReturn: Math.log(2), lower: 50, upper: 150 }]);
  near(stats.mape, 50); near(stats.baselineMape, 50); near(stats.rmseImprovement, 0); near(stats.intervalCoverage, 0);
  const csv = modelCsv({ spec: { version: 'test' }, history: [] }); assert.ok(csv.includes('trainLabelEnd')); assert.ok(csv.includes('model_version,data_sha256,source'));
});
