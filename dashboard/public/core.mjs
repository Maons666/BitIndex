export const DAY = 86400000;
export const DEFAULTS = Object.freeze({ electricity: 0.05, efficiency: 25, pue: 1.1, costMean: 'harmonic' });
export const METRICS = [
  { id: 'ahr999', name: 'AHR999', en: 'Accumulation index', color: '#5366dc', levels: [0.45, 1.2], labels: ['0.45', '1.20'] },
  { id: 'mining', name: '挖矿成本比率', en: 'Mining cost · 电费模型', color: '#c58126', levels: [1], labels: ['电费平衡线 1.00'] },
  { id: 'pi', name: 'Pi Cycle Top', en: 'Cycle crossover', color: '#db6851', levels: [1], labels: ['交叉线 1.00'] },
  { id: 'mvrv', name: 'MVRV', en: 'Market / realized value', color: '#2d8c89', levels: [1, 3.5], labels: ['1.00', '3.50'] },
  { id: 'puell', name: 'Puell Multiple', en: 'Daily issuance multiple', color: '#8a61bb', levels: [0.5, 4], labels: ['0.50', '4.00'] },
  { id: 'mayer', name: 'Mayer Multiple', en: 'Price / 200D MA', color: '#168caf', levels: [1, 2.4], labels: ['1.00', '2.40'] },
  { id: 'nupl', name: 'NUPL', en: 'Net unrealized profit / loss', color: '#b65089', levels: [0, .5, .75], labels: ['0', '0.50', '0.75'] },
  { id: 'rsi', name: 'RSI · 14 日', en: 'Wilder momentum', color: '#7c8d24', levels: [30, 70], labels: ['30', '70'] },
  { id: 'volatility', name: '30 日年化波动率', en: 'Realized volatility', color: '#b25d28', levels: [], labels: [] },
  { id: 'momentum', name: '60 日累计涨幅', en: '60D price return', color: '#4070a2', levels: [0], labels: ['0%'] },
  { id: 'hashRibbon', name: 'Hash Ribbon 比率', en: 'Hashrate 30D / 60D', color: '#638f76', levels: [1], labels: ['1.00'] },
  { id: 'ma2y', name: '两年均线倍数', en: 'Price / 730D MA', color: '#8f6a49', levels: [1, 5], labels: ['1.00', '5.00'] }
];
export const DEFAULT_SELECTION = ['ahr999', 'mining', 'pi', 'mvrv', 'puell'];
for (const m of METRICS) {
  m.group = ['mining', 'puell', 'hashRibbon'].includes(m.id) ? '矿工' : ['rsi', 'momentum', 'volatility'].includes(m.id) ? '动量' : '估值';
  m.unit = ['volatility', 'momentum'].includes(m.id) ? '%' : m.id === 'rsi' ? '' : '×';
  if (['ahr999', 'pi', 'nupl'].includes(m.id)) m.unit = '';
  m.digits = ['rsi', 'volatility', 'momentum'].includes(m.id) ? 2 : 3;
}
export function cleanSelection(ids) { return Array.isArray(ids) ? METRICS.filter(m => ids.includes(m.id)).map(m => m.id) : [...DEFAULT_SELECTION]; }
export const valid = x => typeof x === 'number' && Number.isFinite(x);
export const positive = x => valid(x) && x > 0;
export function validateSettings(raw = {}) {
  const s = { ...DEFAULTS, ...raw };
  for (const [key, lo, hi] of [['electricity', 0.001, 1], ['efficiency', 1, 500], ['pue', 1, 3]]) {
    s[key] = Number(s[key]);
    if (!valid(s[key]) || s[key] < lo || s[key] > hi) throw new Error('参数超出范围：' + key);
  }
  if (!['harmonic', 'geometric'].includes(s.costMean)) throw new Error('无效的 AHR999 成本口径');
  return s;
}
// Full calendar windows only. Missing observations invalidate the window; no forward fill.
export function rolling(values, window, kind = 'arithmetic') {
  let sum = 0, count = 0;
  const transformed = values.map(v => positive(v) ? kind === 'harmonic' ? 1 / v : kind === 'geometric' ? Math.log(v) : v : null);
  return transformed.map((v, i) => {
    if (v !== null) { sum += v; count++; }
    const old = transformed[i - window];
    if (i >= window && old !== null) { sum -= old; count--; }
    if (i < window - 1 || count !== window) return null;
    return kind === 'harmonic' ? window / sum : kind === 'geometric' ? Math.exp(sum / window) : sum / window;
  });
}
export function miningCost(hashrateTH, issuanceBTC, settings = DEFAULTS) {
  if (!positive(hashrateTH) || !positive(issuanceBTC)) return null;
  // TH/s × J/TH = watts; watts × 24 / 1000 = kWh per day.
  return hashrateTH * settings.efficiency * 24 / 1000 * settings.pue * settings.electricity / issuanceBTC;
}
export function rsiWilder(prices, period = 14) {
  let gain = 0, loss = 0, count = 0;
  return prices.map((p, i) => {
    if (i === 0 || !positive(p) || !positive(prices[i - 1])) { gain = loss = count = 0; return null; }
    const delta = p - prices[i - 1], up = Math.max(delta, 0), down = Math.max(-delta, 0);
    if (count < period) { gain += up; loss += down; count++; if (count < period) return null; gain /= period; loss /= period; }
    else { gain = (gain * (period - 1) + up) / period; loss = (loss * (period - 1) + down) / period; }
    return gain + loss === 0 ? 50 : loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  });
}
export function realizedVolatility(prices, period = 30) {
  const returns = prices.map((p, i) => i && positive(p) && positive(prices[i - 1]) ? Math.log(p / prices[i - 1]) : null);
  return returns.map((_, i) => {
    if (i < period) return null;
    const window = returns.slice(i - period + 1, i + 1);
    if (window.some(v => !valid(v))) return null;
    const mean = window.reduce((a, b) => a + b, 0) / period;
    return Math.sqrt(window.reduce((a, v) => a + (v - mean) ** 2, 0) / (period - 1) * 365) * 100;
  });
}
// Causal expanding midrank: the same historic value never changes when new days are appended.
export function historicalPercentiles(values, minHistory = 365) {
  const sorted = [];
  function bound(value, upper) { let lo = 0, hi = sorted.length; while (lo < hi) { const mid = (lo + hi) >>> 1; if (sorted[mid] < value || upper && sorted[mid] === value) lo = mid + 1; else hi = mid; } return lo; }
  return values.map(value => {
    if (!valid(value)) return null;
    const lo = bound(value, false), hi = bound(value, true); sorted.splice(hi, 0, value);
    return sorted.length < minHistory ? null : (lo + (hi - lo + 1) / 2) / sorted.length * 100;
  });
}
export function withPercentiles(rows) {
  const ranks = Object.fromEntries(METRICS.map(m => [m.id, historicalPercentiles(rows.map(r => r[m.id]))]));
  return rows.map((r, i) => ({ ...r, ...Object.fromEntries(METRICS.map(m => ['p_' + m.id, ranks[m.id][i]])) }));
}
export function compute(rows, rawSettings = DEFAULTS) {
  const settings = validateSettings(rawSettings);
  const prices = rows.map(r => r.price);
  const mean200 = rolling(prices, 200, settings.costMean);
  const ma111 = rolling(prices, 111), ma350 = rolling(prices, 350);
  const sma200 = rolling(prices, 200), sma730 = rolling(prices, 730);
  const hash30 = rolling(rows.map(r => r.hashrate), 30), hash60 = rolling(rows.map(r => r.hashrate), 60);
  const rsi = rsiWilder(prices), volatility = realizedVolatility(prices);
  const issuanceMean = rolling(rows.map(r => r.issuanceUSD), 365);
  const genesis = Date.UTC(2009, 0, 3);
  return rows.map((r, i) => {
    const age = (Date.parse(r.date + 'T00:00:00Z') - genesis) / DAY;
    const fitted = age > 0 ? 10 ** (5.84 * Math.log10(age) - 17.01) : null;
    const cost = miningCost(r.hashrate, r.issuance, settings);
    const pi = positive(ma111[i]) && positive(ma350[i]) ? ma111[i] / (2 * ma350[i]) : null;
    const previousPi = i > 0 && positive(ma111[i - 1]) && positive(ma350[i - 1]) ? ma111[i - 1] / (2 * ma350[i - 1]) : null;
    return {
      ...r, mean200: mean200[i], fitted, cost, ma111: ma111[i], ma350x2: positive(ma350[i]) ? ma350[i] * 2 : null,
      ahr999: positive(r.price) && positive(mean200[i]) && positive(fitted) ? r.price / mean200[i] * (r.price / fitted) : null,
      mining: positive(r.price) && positive(cost) ? r.price / cost : null,
      pi, piCross: valid(pi) && valid(previousPi) && pi >= 1 && previousPi < 1,
      mvrv: positive(r.mvrv) ? r.mvrv : null,
      puell: positive(r.issuanceUSD) && positive(issuanceMean[i]) ? r.issuanceUSD / issuanceMean[i] : null,
      mayer: positive(r.price) && positive(sma200[i]) ? r.price / sma200[i] : null,
      nupl: positive(r.mvrv) ? 1 - 1 / r.mvrv : null,
      rsi: rsi[i], volatility: volatility[i],
      momentum: i >= 60 && positive(r.price) && positive(prices[i - 60]) && prices.slice(i - 60, i + 1).every(positive) ? (r.price / prices[i - 60] - 1) * 100 : null,
      hashRibbon: positive(hash30[i]) && positive(hash60[i]) ? hash30[i] / hash60[i] : null,
      ma2y: positive(r.price) && positive(sma730[i]) ? r.price / sma730[i] : null,
      sma200: sma200[i], sma730: sma730[i], hash30: hash30[i], hash60: hash60[i]
    };
  });
}
export function latest(rows, key) { return rows.findLast(r => valid(r[key])) ?? null; }
export function regime(id, value) {
  if (!valid(value)) return { label: '数据不足', tone: 'muted' };
  if (id === 'ahr999') return value < 0.45 ? { label: '低于 0.45', tone: 'cool' } : value <= 1.2 ? { label: '0.45–1.20 区间', tone: 'calm' } : { label: '高于 1.20', tone: 'warm' };
  if (id === 'mining') return value < 1 ? { label: '币价低于电费成本', tone: 'warm' } : { label: '币价高于电费成本', tone: 'calm' };
  if (id === 'pi') return value >= 1 ? { label: '位于交叉线上方', tone: 'warm' } : { label: '位于交叉线下方', tone: 'calm' };
  if (id === 'mvrv') return value < 1 ? { label: '低于已实现市值', tone: 'cool' } : value > 3.5 ? { label: '高倍数区间', tone: 'warm' } : { label: '1.00–3.50 区间', tone: 'calm' };
  if (id === 'mayer' || id === 'ma2y') return { label: value < 1 ? '低于均线' : '高于均线', tone: value < 1 ? 'cool' : 'calm' };
  if (id === 'nupl') return { label: value < 0 ? '净浮亏' : '净浮盈', tone: value < 0 ? 'cool' : 'calm' };
  if (id === 'rsi') return { label: value < 30 ? '低于 30' : value > 70 ? '高于 70' : '30–70 区间', tone: value < 30 ? 'cool' : value > 70 ? 'warm' : 'calm' };
  if (id === 'volatility') return { label: '年化标准差', tone: 'muted' };
  if (id === 'momentum') return { label: value < 0 ? '60 日下跌' : '60 日上涨', tone: value < 0 ? 'cool' : 'calm' };
  if (id === 'hashRibbon') return { label: value < 1 ? '短期算力收缩' : '短期算力扩张', tone: value < 1 ? 'warm' : 'calm' };
  return value < 0.5 ? { label: '低发行价值区间', tone: 'cool' } : value > 4 ? { label: '高发行价值区间', tone: 'warm' } : { label: '0.50–4.00 区间', tone: 'calm' };
}
export function toCsv(rows, settings, selected = METRICS.map(m => m.id)) {
  const ids = cleanSelection(selected);
  const columns = ['date', 'price', ...ids, ...ids.map(id => 'p_' + id), 'cost', 'ma111', 'ma350x2', 'piCross', 'hashrate', 'issuance', 'issuanceUSD'];
  const header = [...columns, 'electricity_USD_kWh', 'efficiency_J_TH', 'PUE', 'ahr_cost_mean', 'source'];
  return '\uFEFF' + [header.join(','), ...rows.map(r => [...columns.map(k => typeof r[k] === 'boolean' ? Number(r[k]) : valid(r[k]) ? r[k].toFixed(['price', 'cost', 'ma111', 'ma350x2', 'issuanceUSD'].includes(k) ? 2 : 6) : r[k] ?? ''), settings.electricity, settings.efficiency, settings.pue, settings.costMean, 'Coin Metrics Community'].join(','))].join('\r\n');
}
