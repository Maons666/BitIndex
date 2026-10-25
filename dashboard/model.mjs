import { createHash } from 'node:crypto';
import { compute, DAY, positive, valid } from './public/core.mjs';

// Prespecified v1 specification. Do not select hyperparameters against the reported backtest.
export const SPEC = Object.freeze({ version: 'ridge-30d-v1', horizon: 30, lag: 1, alpha: 100, minTrain: 730, step: 30, intervalMin: 20 });
export const FEATURES = [
  { id: 'mvrv', name: 'MVRV', transform: 'log' },
  { id: 'puell', name: 'Puell Multiple', transform: 'log' },
  { id: 'mayer', name: 'Mayer Multiple', transform: 'log' },
  { id: 'pi', name: 'Pi Cycle Top', transform: 'log' },
  { id: 'rsi', name: 'RSI 14', transform: 'divide100' },
  { id: 'volatility', name: '30 日年化波动率', transform: 'log1pPercent' },
  { id: 'momentum', name: '60 日累计涨幅', transform: 'logReturnPercent' },
  { id: 'hashRibbon', name: 'Hash Ribbon 比率', transform: 'log' },
  { id: 'ma2y', name: '两年均线倍数', transform: 'log' }
];
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
export function vector(row, features = FEATURES) {
  if (!row) return null;
  const x = features.map(f => {
    const v = row[f.id];
    if (!valid(v)) return null;
    if (f.transform === 'identity') return v;
    if (f.transform === 'log') return positive(v) ? Math.log(v) : null;
    if (f.transform === 'divide100') return v / 100;
    if (f.transform === 'log1pPercent') return v >= 0 ? Math.log1p(v / 100) : null;
    return v > -100 ? Math.log1p(v / 100) : null;
  });
  return x.every(valid) ? x : null;
}
function solve(matrix, rhs) {
  const n = rhs.length, a = matrix.map((r, i) => [...r, rhs[i]]);
  for (let k = 0; k < n; k++) {
    let pivot = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(a[i][k]) > Math.abs(a[pivot][k])) pivot = i;
    [a[k], a[pivot]] = [a[pivot], a[k]];
    if (Math.abs(a[k][k]) < 1e-12) throw new Error('模型矩阵不可解');
    const d = a[k][k]; for (let j = k; j <= n; j++) a[k][j] /= d;
    for (let i = 0; i < n; i++) if (i !== k) {
      const factor = a[i][k]; for (let j = k; j <= n; j++) a[i][j] -= factor * a[k][j];
    }
  }
  return a.map(r => r[n]);
}
export function fitRidge(samples, alpha = SPEC.alpha) {
  if (samples.length < 2 || !(alpha > 0)) throw new Error('训练数据不足或正则参数无效');
  const p = samples[0].x.length, n = samples.length;
  if (samples.some(s => s.x.length !== p || !s.x.every(valid) || !valid(s.y))) throw new Error('训练数据包含缺失值');
  const means = Array.from({ length: p }, (_, j) => mean(samples.map(s => s.x[j])));
  const scales = means.map((m, j) => Math.sqrt(mean(samples.map(s => (s.x[j] - m) ** 2))) || 1);
  const intercept = mean(samples.map(s => s.y));
  const targetScale = Math.sqrt(mean(samples.map(s => (s.y - intercept) ** 2)));
  const gram = Array.from({ length: p }, () => Array(p).fill(0)), rhs = Array(p).fill(0);
  for (const s of samples) {
    const z = s.x.map((v, j) => (v - means[j]) / scales[j]);
    for (let j = 0; j < p; j++) {
      rhs[j] += z[j] * (s.y - intercept);
      for (let k = 0; k <= j; k++) gram[j][k] += z[j] * z[k];
    }
  }
  for (let j = 0; j < p; j++) { gram[j][j] += alpha; for (let k = j + 1; k < p; k++) gram[j][k] = gram[k][j]; }
  return { means, scales, intercept, targetScale, weights: solve(gram, rhs), n };
}
export function predict(fit, x) { return fit.intercept + fit.weights.reduce((s, w, j) => s + w * (x[j] - fit.means[j]) / fit.scales[j], 0); }
export function quantile(values, q) {
  if (!values.length) return null;
  const a = [...values].sort((x, y) => x - y), index = (a.length - 1) * q, lo = Math.floor(index);
  return a[lo] + (a[Math.ceil(index)] - a[lo]) * (index - lo);
}
export function evaluateBacktest(rows) {
  if (!rows.length) return { n: 0 };
  const error = rows.map(r => r.predictedLogReturn - r.actualLogReturn);
  const baselineError = rows.map(r => -r.actualLogReturn);
  const rmseLog = Math.sqrt(mean(error.map(e => e * e))), baselineRmseLog = Math.sqrt(mean(baselineError.map(e => e * e)));
  const calibrated = rows.filter(r => valid(r.lower));
  return {
    n: rows.length, start: rows[0].date, end: rows.at(-1).targetDate,
    rmseLog, baselineRmseLog, rmseImprovement: baselineRmseLog ? 1 - rmseLog / baselineRmseLog : null,
    mape: mean(rows.map(r => Math.abs(r.predictedPrice / r.actualPrice - 1))) * 100,
    baselineMape: mean(rows.map(r => Math.abs(r.price / r.actualPrice - 1))) * 100,
    directionAccuracy: mean(rows.map(r => Number(Math.sign(r.predictedLogReturn) === Math.sign(r.actualLogReturn)))) * 100,
    alwaysUpAccuracy: mean(rows.map(r => Number(r.actualLogReturn > 0))) * 100,
    intervalN: calibrated.length,
    intervalCoverage: calibrated.length ? mean(calibrated.map(r => Number(r.actualPrice >= r.lower && r.actualPrice <= r.upper))) * 100 : null
  };
}
function makeForecast(row, featureRow, fit, training, history, spec, features) {
  const predictedLogReturn = predict(fit, vector(featureRow, features)), predictedPrice = row.price * Math.exp(predictedLogReturn);
  // Only outcomes observable strictly before the issue date may calibrate the interval.
  const residuals = history.filter(r => r.targetDate < row.date).map(r => r.actualLogReturn - r.predictedLogReturn);
  const enough = residuals.length >= spec.intervalMin;
  const lower = enough ? row.price * Math.exp(predictedLogReturn + Math.min(0, quantile(residuals, .1))) : null;
  const upper = enough ? row.price * Math.exp(predictedLogReturn + Math.max(0, quantile(residuals, .9))) : null;
  const forecast = {
    date: row.date, featureDate: featureRow.date, targetDate: new Date(Date.parse(row.date) + spec.horizon * DAY).toISOString().slice(0, 10),
    price: row.price, predictedLogReturn, predictedReturn: Math.expm1(predictedLogReturn) * 100, predictedPrice,
    index: 100 / (1 + Math.exp(-predictedLogReturn / Math.max(fit.targetScale, .01))), lower, upper,
    calibrationN: residuals.length, trainingN: fit.n, trainStart: training[0].date,
    trainEnd: training.at(-1).date, trainLabelEnd: training.at(-1).targetDate
  };
  if (![forecast.index, predictedPrice, predictedLogReturn].every(valid) || !positive(predictedPrice)) throw new Error('模型数值异常');
  return forecast;
}
export function buildModel(rawRows, options = {}, external = null) {
  const spec = { ...SPEC, ...options };
  if (spec.horizon !== 30 || spec.lag !== 1 || spec.step !== 30) throw new Error('v1 固定 30 日预测、1 日滞后与 30 日步长');
  const features = external ? [...FEATURES, ...external.features] : FEATURES;
  const rows = compute(rawRows).map(r => external ? { ...r, ...external.byDate.get(r.date) } : r), samples = [], origins = [];
  for (let i = spec.lag; i < rows.length; i++) {
    const r = rows[i], f = rows[i - spec.lag], x = vector(f, features);
    if (!x || !positive(r.price) || Date.parse(r.date) - Date.parse(f.date) !== spec.lag * DAY) continue;
    origins.push(i);
    const target = rows[i + spec.horizon];
    if (target && positive(target.price) && Date.parse(target.date) - Date.parse(r.date) === spec.horizon * DAY) {
      samples.push({ i, date: r.date, targetDate: target.date, x, y: Math.log(target.price / r.price) });
    }
  }
  const history = []; let lastIssued = -Infinity;
  for (const i of origins) {
    if (i + spec.horizon >= rows.length || i - lastIssued < spec.step || !positive(rows[i + spec.horizon].price)) continue;
    const training = samples.filter(s => s.targetDate < rows[i].date);
    if (training.length < spec.minTrain) continue;
    const fit = fitRidge(training, spec.alpha), f = makeForecast(rows[i], rows[i - spec.lag], fit, training, history, spec, features);
    if (rows[i + spec.horizon].date !== f.targetDate) continue;
    history.push({ ...f, actualPrice: rows[i + spec.horizon].price, actualLogReturn: Math.log(rows[i + spec.horizon].price / rows[i].price) });
    lastIssued = i;
  }
  const last = origins.at(-1);
  if (last === undefined) throw new Error('完整指标不足，无法建立预测');
  const training = samples.filter(s => s.targetDate < rows[last].date);
  if (training.length < spec.minTrain) throw new Error(`模型需要至少 ${spec.minTrain} 个已到期训练样本`);
  const fit = fitRidge(training, spec.alpha), current = makeForecast(rows[last], rows[last - spec.lag], fit, training, history, spec, features);
  const recentStart = new Date(Date.parse(rows[last].date) - 730 * DAY).toISOString().slice(0, 10);
  const all = evaluateBacktest(history), recent = evaluateBacktest(history.filter(r => r.date >= recentStart));
  const years = [...new Set(history.map(r => r.date.slice(0, 4)))].map(year => ({ year, ...evaluateBacktest(history.filter(r => r.date.startsWith(year))) }));
  return {
    spec, dataStart: rows[0]?.date, dataEnd: rows.at(-1)?.date, featureStart: rows[origins[0] - spec.lag].date,
    current, all, recent, years, history,
    verdict: all.rmseImprovement > 0 && recent.n >= 12 && recent.rmseImprovement > 0 ? 'better-in-backtest' : 'not-validated',
    features: features.map((f, j) => ({ ...f, weight: fit.weights[j], mean: fit.means[j], scale: fit.scales[j] })),
    intercept: fit.intercept, targetScale: fit.targetScale
  };
}
export function createModelStore() {
  let key, result;
  return snapshot => {
    const fingerprint = createHash('sha256').update(JSON.stringify(snapshot.rows)).digest('hex');
    if (key !== fingerprint) { result = buildModel(snapshot.rows); key = fingerprint; }
    return { ...result, fingerprint, source: snapshot.source, fetchedAt: snapshot.fetchedAt };
  };
}
export function modelCsv(model) {
  const keys = ['date', 'featureDate', 'targetDate', 'index', 'price', 'predictedPrice', 'actualPrice', 'predictedReturn', 'predictedLogReturn', 'actualLogReturn', 'lower', 'upper', 'trainingN', 'trainStart', 'trainEnd', 'trainLabelEnd', 'calibrationN'];
  return '\uFEFF' + [keys.concat(['model_version', 'data_sha256', 'source']).join(','), ...model.history.map(r => [...keys.map(k => r[k] ?? ''), model.spec.version, model.fingerprint ?? '', model.source ?? 'Coin Metrics Community'].join(','))].join('\r\n');
}
