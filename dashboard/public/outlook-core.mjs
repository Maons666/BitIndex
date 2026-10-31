const DAY = 86400000;
export const OUTLOOK_VERSION = 'financial-outlook-v1';
export const MODELS = [
  { id: 'gbm', name: '几何布朗运动', short: 'GBM', formula: 'E[Sₕ] = S₀ · exp((m + σ²/2)h)', description: '用历史收益的均值与波动率，刻画未来价格分布。' },
  { id: 'trend', name: '对数趋势', short: 'Log trend', formula: 'Ŝₕ = S₀ · exp(bh)', description: '估计历史对数价格的趋势斜率，从最新价格向前延伸。' },
  { id: 'baseline', name: '价格不变基准', short: 'No change', formula: 'Ŝₕ = S₀', description: '假设未来价格维持当前水平，作为模型比较的基准。' }
];
export function outlookOptions(value = {}) {
  return { model: MODELS.some(m => m.id === value.model) ? value.model : 'gbm', horizon: [7, 30, 90].includes(Number(value.horizon)) ? Number(value.horizon) : 30, lookback: [90, 180, 365].includes(Number(value.lookback)) ? Number(value.lookback) : 365, band: value.band !== false };
}
const positive = x => Number.isFinite(x) && x > 0;
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
