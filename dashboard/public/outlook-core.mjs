const DAY = 86400000;
export const OUTLOOK_VERSION = 'financial-outlook-v1';
export const MODELS = [
  { id: 'gbm', name: '几何布朗运动', short: 'GBM', formula: 'E[Sₕ] = S₀ · exp((m + σ²/2)h)', description: '用历史收益的均值与波动率，刻画未来价格分布。' },
  { id: 'trend', name: '对数趋势', short: 'Log trend', formula: 'Ŝₕ = S₀ · exp(bh)', description: '估计历史对数价格的趋势斜率，从最新价格向前延伸。' },
  { id: 'baseline', name: '价格不变基准', short: 'No change', formula: 'Ŝₕ = S₀', description: '假设未来价格维持当前水平，作为模型比较的基准。' }
];
export const ARCHIVE_MODELS = [
  { id: 'ridge', name: '我的模型 · 原版', version: 'ridge-30d-v1' },
  { id: 'macro', name: '我的模型 · 外部因素', version: 'ridge-30d-macro-v1' }
];
export function outlookOptions(value = {}) {
  return { model: [...ARCHIVE_MODELS, ...MODELS].some(m => m.id === value.model) ? value.model : 'ridge', archiveView: value.archiveView === 'single' ? 'single' : 'curve', horizon: [7, 30, 90].includes(Number(value.horizon)) ? Number(value.horizon) : 30, lookback: [90, 180, 365].includes(Number(value.lookback)) ? Number(value.lookback) : 365, band: value.band !== false };
}
const positive = x => Number.isFinite(x) && x > 0;
const validDate = date => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(Date.parse(date)).toISOString().slice(0, 10) === date;
export function latestArchivedForecast(forecasts, model) {
  const version = ARCHIVE_MODELS.find(m => m.id === model)?.version;
  if (!version) return null;
  return (forecasts || []).filter(f => f.modelVersion === version && Number.isFinite(Date.parse(f.issuedAt))).slice()
    .sort((a, b) => Date.parse(b.issuedAt) - Date.parse(a.issuedAt))[0] || null;
}
export function buildArchivedOutlook(rows, forecast, model, today = new Date().toISOString().slice(0, 10)) {
  const p = forecast?.prediction;
  if (!p) throw new Error('尚无该模型的预测留档');
  if (forecast.modelVersion !== ARCHIVE_MODELS.find(m => m.id === model)?.version || !validDate(p.date) || !validDate(p.targetDate) || !positive(p.price) || !positive(p.predictedPrice) || p.targetDate <= p.date) throw new Error('预测留档格式无效');
  const all = rows.filter(r => validDate(r.date) && r.date < today && positive(r.price)).slice().sort((a, b) => a.date.localeCompare(b.date));
  if (!all.length) throw new Error('尚无可用的实际日线');
  const latest = all.at(-1), from = Math.min(Date.parse(latest.date) - 90 * DAY, Date.parse(p.date) - 30 * DAY);
  const history = all.filter(r => Date.parse(r.date) >= from).map(({ date, price }) => ({ date, price }));
  if (Date.parse(history[0].date) > Date.parse(p.date)) throw new Error('实际日线尚未覆盖预测起点');
  // The saved model predicts one endpoint. Never interpolate daily model outputs.
  return { kind: 'archive', version: forecast.modelVersion, forecast, latest, anchor: { date: p.date, price: p.price },
    horizon: (Date.parse(p.targetDate) - Date.parse(p.date)) / DAY, history,
    future: [{ date: p.date, [model]: p.price }, { date: p.targetDate, [model]: p.predictedPrice }] };
}
export function archivedOutlookCsv(result, snapshot) {
  const f = result.forecast, p = f.prediction;
  const columns = ['date', 'type', 'actual_price', 'predicted_price', 'lower80', 'upper80', 'base_date', 'base_price', 'forecast_id', 'model_version', 'issued_at', 'actual_source_fetched_at', 'actual_source'];
  const tail = [p.date, p.price, f.id, f.modelVersion, f.issuedAt, snapshot.fetchedAt, snapshot.source];
  const lines = result.history.map(r => [r.date, 'actual', r.price, '', '', '', ...tail]);
  for (const saved of result.forecasts || [f]) {
    const target = saved.prediction;
    lines.push([target.targetDate, 'archived_target', '', target.predictedPrice, target.lower, target.upper,
      target.date, target.price, saved.id, saved.modelVersion, saved.issuedAt, snapshot.fetchedAt, snapshot.source]);
  }
  const cell = v => '"' + String(v ?? '').replaceAll('"', '""') + '"';
  return '\uFEFF' + [columns, ...lines].map(row => row.map(cell).join(',')).join('\r\n');
}
export function buildArchivedCurve(rows, forecasts, model, today = new Date().toISOString().slice(0, 10)) {
  const version = ARCHIVE_MODELS.find(m => m.id === model)?.version;
  const saved = (forecasts || []).filter(f => f.modelVersion === version).slice().sort((a, b) =>
    String(a.prediction?.targetDate).localeCompare(String(b.prediction?.targetDate)) || String(a.issuedAt).localeCompare(String(b.issuedAt)));
  if (!saved.length) throw new Error('尚无该模型的预测留档');
  for (const f of saved) {
    const p = f.prediction;
    if (!p || !validDate(p.date) || !validDate(p.targetDate) || !positive(p.price) || !positive(p.predictedPrice) || Date.parse(p.targetDate) - Date.parse(p.date) !== 30 * DAY || !Number.isFinite(Date.parse(f.issuedAt))) throw new Error('预测留档格式无效');
  }
  // Keep each genuine issue, with its original target date and signature. No reforecasting or interpolation.
  const result = buildArchivedOutlook(rows, latestArchivedForecast(saved, model), model, today);
  const from = Math.min(Date.parse(result.latest.date) - 30 * DAY, Date.parse(saved[0].prediction.targetDate) - 7 * DAY);
  const history = rows.filter(r => validDate(r.date) && r.date < today && positive(r.price) && Date.parse(r.date) >= from)
    .slice().sort((a, b) => a.date.localeCompare(b.date)).map(({ date, price }) => ({ date, price }));
  return { ...result, view: 'curve', forecasts: saved, history,
    future: saved.map(f => ({ date: f.prediction.targetDate, [model]: f.prediction.predictedPrice, forecast: f })) };
}
export function buildOutlook(rows, options = {}, today = new Date().toISOString().slice(0, 10)) {
  const { lookback, horizon } = outlookOptions(options);
  const history = rows.filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.date < today).slice().sort((a, b) => a.date.localeCompare(b.date));
  const sample = history.slice(-(lookback + 1));
  if (sample.length !== lookback + 1) throw new Error(`需要 ${lookback + 1} 个日收盘价，请缩短估计窗口`);
  for (let i = 0; i < sample.length; i++) {
    const r = sample[i], t = Date.parse(r.date);
    if (!positive(r.price) || !Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== r.date || i && t - Date.parse(sample[i - 1].date) !== DAY) throw new Error('估计窗口内有缺失或无效日线，请选择较短窗口或等待数据更新');
  }
  const returns = sample.slice(1).map((r, i) => Math.log(r.price) - Math.log(sample[i].price));
  const m = returns.reduce((a, b) => a + b, 0) / lookback;
  const variance = returns.reduce((sum, r) => sum + (r - m) ** 2, 0) / (lookback - 1), sigma = Math.sqrt(variance);
  const xMean = lookback / 2, logs = sample.map(r => Math.log(r.price)), yMean = logs.reduce((a, b) => a + b, 0) / sample.length;
  const slope = logs.reduce((sum, y, i) => sum + (i - xMean) * (y - yMean), 0) / logs.reduce((sum, _, i) => sum + (i - xMean) ** 2, 0);
  const anchor = sample.at(-1), price = exponent => {
    const value = anchor.price * Math.exp(exponent);
    if (!positive(value)) throw new Error('模型结果超出可显示范围，请缩短窗口或预测期');
    return value;
  };
  const future = Array.from({ length: horizon + 1 }, (_, h) => ({
    date: new Date(Date.parse(anchor.date) + h * DAY).toISOString().slice(0, 10), h,
    gbm: price((m + variance / 2) * h), median: price(m * h),
    lower: price(m * h - 1.959963984540054 * sigma * Math.sqrt(h)), upper: price(m * h + 1.959963984540054 * sigma * Math.sqrt(h)),
    trend: price(slope * h), baseline: anchor.price
  }));
  return { version: OUTLOOK_VERSION, anchor: { date: anchor.date, price: anchor.price }, lookback, horizon, sampleStart: sample[0].date,
    parameters: { logDrift: m, dailyVolatility: sigma, annualVolatility: sigma * Math.sqrt(365), trendSlope: slope },
    history: sample.slice(-91).map(({ date, price }) => ({ date, price })), future };
}
export function outlookCsv(result, snapshot) {
  const columns = ['date', 'type', 'actual_price', 'gbm_mean', 'gbm_median', 'gbm_lower95', 'gbm_upper95', 'log_trend', 'no_change', 'base_date', 'lookback_days', 'horizon_days', 'model_version', 'source_fetched_at', 'source'];
  const tail = [result.anchor.date, result.lookback, result.horizon, result.version, snapshot.fetchedAt, snapshot.source];
  const lines = result.history.map(r => [r.date, 'actual', r.price, '', '', '', '', '', '', ...tail]);
  for (const r of result.future.slice(1)) lines.push([r.date, 'model', '', r.gbm, r.median, r.lower, r.upper, r.trend, r.baseline, ...tail]);
  const cell = v => '"' + String(v ?? '').replaceAll('"', '""') + '"';
  return '\uFEFF' + [columns, ...lines].map(row => row.map(cell).join(',')).join('\r\n');
}
