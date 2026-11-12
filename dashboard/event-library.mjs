const DAY = 86400000;
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const sd = a => Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1));
const date = t => new Date(t).toISOString().slice(0, 10);
export const impactLevel = z => Math.abs(z) < .5 ? 1 : Math.abs(z) < 1 ? 2 : Math.abs(z) < 2 ? 3 : 4;

// This is an observed event-window residual, not an identified causal effect.
export function measureCase(definition, rows) {
  const publicationDay = definition.publishedAt.slice(0, 10);
  const anchorDate = date(Date.parse(publicationDay) - DAY), byDate = new Map(rows.map(r => [r.date, r.price]));
  const before = Array.from({ length: 61 }, (_, i) => ({ date: date(Date.parse(anchorDate) - (60 - i) * DAY) })).map(r => ({ ...r, price: byDate.get(r.date) }));
  if (before.some(r => !Number.isFinite(r.price) || r.price <= 0)) throw new Error('案例事前窗口缺日：' + definition.id);
  const rs = before.slice(1).map((r, i) => Math.log(r.price / before[i].price));
  const sigma = Math.max(sd(rs.slice(-28)), sd(rs)), drift = .35 * (mean(rs.slice(-7)) + mean(rs.slice(-28))) / 2, anchorPrice = before.at(-1).price;
  const outcomes = [7, 30].map(horizon => {
    const targetDate = date(Date.parse(anchorDate) + horizon * DAY), actual = byDate.get(targetDate);
    if (!Number.isFinite(actual) || actual <= 0) return { horizon, targetDate, status: 'pending' };
    const width = sigma * Math.sqrt(horizon), trend = Math.min(width, Math.max(-width, drift * horizon));
    const logReturn = Math.log(actual / anchorPrice), residual = logReturn - trend, z = width > 0 ? residual / width : 0;
    return { horizon, targetDate, status: 'observed', actualPrice: actual, returnPct: (actual / anchorPrice - 1) * 100, noEventPrice: anchorPrice * Math.exp(trend), residualLogReturn: residual, standardizedMove: z, level: impactLevel(z), direction: Math.sign(residual) };
  });
  return { ...definition, anchorDate, anchorPrice, preEventDailyVolatility: sigma, outcomes, causalStatus: 'candidate-not-proven' };
}

export function matchHistory(event, library, horizon, cutoffAt) {
  const matches = (library.cases || []).filter(c => c.kind === event.kind && c.publishedAt < event.publishedAt).flatMap(c => {
    const o = c.outcomes.find(o => o.horizon === horizon && o.status === 'observed' && o.targetDate < cutoffAt.slice(0, 10));
    return o ? [{ id: c.id, title: c.title, level: o.level, direction: o.direction, standardizedMove: o.standardizedMove, returnPct: o.returnPct, targetDate: o.targetDate }] : [];
  });
  if (!matches.length) return { horizon, count: 0, level: null, label: '待积累', historicalDirection: null, reliability: 0, matches };
  const levels = matches.map(m => m.level).sort((a, b) => a - b), zs = matches.map(m => m.standardizedMove).sort((a, b) => a - b);
  const median = a => a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
  const level = Math.round(median(levels)), historicalDirection = Math.sign(median(zs));
  return { horizon, count: matches.length, level, label: 'L' + level, historicalDirection, reliability: matches.length / (matches.length + 5), matches };
}

export function detectMoves(rows, reviewedCases = []) {
  const candidates = []; let last = -Infinity;
  for (let i = 61; i < rows.length; i++) {
    if (rows[i].date < '2026-01-01') continue;
    const window = rows.slice(i - 61, i + 1);
    if (window.some((r, j) => !(r.price > 0) || j && Date.parse(r.date) - Date.parse(window[j-1].date) !== DAY)) continue;
    const past = window.slice(1, -1).map((r, j) => Math.log(r.price / window[j].price)), sigma = sd(past);
    const change = Math.log(rows[i].price / rows[i-1].price);
    if (Math.abs(change) < Math.max(Math.log(1.03), 2 * sigma) || i - last < 7) continue;
    last = i;
    const near = reviewedCases.filter(c => Math.abs(Date.parse(c.publishedAt) - Date.parse(rows[i].date)) <= 7 * DAY);
    candidates.push({ date: rows[i].date, returnPct: (rows[i].price / rows[i-1].price - 1) * 100, z: sigma ? change / sigma : 0, status: near.length ? 'case-nearby-not-causal-proof' : 'needs-research', relatedCases: near.map(c => c.id) });
  }
  return candidates.reverse();
}
