import { createHash } from 'node:crypto';
import { matchHistory } from './event-library.mjs';
const DAY = 86400000;
export const EVENT_MODEL = 'event-scenarios-v1';
const day = t => new Date(t).toISOString().slice(0, 10);
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = xs => Math.sqrt(xs.reduce((s, x) => s + (x - mean(xs)) ** 2, 0) / (xs.length - 1));
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const fail = message => { throw new Error(message); };
const stamp = s => typeof s === 'string' && /^\d{4}-\d\d-\d\dT.*Z$/.test(s) && Number.isFinite(Date.parse(s));
const text = s => typeof s === 'string' && s.trim().length > 0;
export const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Only explicit agent publication calls this builder. Daily jobs never generate predictions.
export function buildEventForecast(analysis, market, { now = new Date() } = {}) {
  return calculate(analysis, market, now);
}

// A replay has a simulated information cutoff, never a backdated real issuance.
// Preserve the actual retrieval/research timestamps alongside that cutoff.
export function replayEventForecast(analysis, market, { asOf, reconstructedAt } = {}) {
  if (!stamp(asOf) || !stamp(reconstructedAt) || Date.parse(asOf) >= Date.parse(reconstructedAt) || analysis.cutoffAt !== asOf) fail('回放时间无效');
  return calculate(analysis, market, new Date(asOf), reconstructedAt);
}

function calculate(analysis, market, now, reconstructedAt = null) {
  const issuedAt = now.toISOString(), issueDay = day(now);
  if (!/^[a-z0-9-]+$/.test(analysis.id || '') || !stamp(analysis.cutoffAt) || Date.parse(analysis.cutoffAt) > now.getTime()) fail('分析 ID 或截止时间无效');
  if (now - Date.parse(analysis.cutoffAt) > DAY) fail('分析已超过 24 小时，请重新核查事件');
  if (!text(analysis.summary) || !text(analysis.author) || !Array.isArray(analysis.events) || !Array.isArray(analysis.coverageGaps)) fail('缺少分析内容');
  const retrievalLimit = reconstructedAt ? Date.parse(reconstructedAt) : now.getTime();
  if (!stamp(market.fetchedAt) || Date.parse(market.fetchedAt) > retrievalLimit || market.source !== 'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics') fail('行情来源或获取时间无效');
  const rows = market.rows.filter(r => r.date < issueDay && Number.isFinite(r.price) && r.price > 0).sort((a, b) => a.date.localeCompare(b.date));
  const anchor = rows.at(-1), sample = rows.slice(-61);
  if (sample.length !== 61 || (Date.parse(issueDay) - Date.parse(anchor.date)) / DAY > 3) fail('需要最近 61 个连续日收盘价，末日不能超过 3 天');
  sample.forEach((r, i) => { if (i && Date.parse(r.date) - Date.parse(sample[i - 1].date) !== DAY) fail('价格窗口缺日，拒绝插值'); });
  const returns = sample.slice(1).map((r, i) => Math.log(r.price / sample[i].price));
  const sigma = Math.max(sd(returns.slice(-28)), sd(returns));
  const drift = 0.35 * (0.5 * mean(returns.slice(-7)) + 0.5 * mean(returns.slice(-28)));
  const ids = new Set(), library = market.eventLibrary || { cases: [] };
  const events = analysis.events.map(e => {
    if (!text(e.id) || ids.has(e.id)) fail('事件 ID 重复或为空'); ids.add(e.id);
    if (!['macro', 'flows', 'leverage', 'policy', 'security'].includes(e.category)) fail('事件类别无效');
    const verifiedLimit = reconstructedAt ? Date.parse(reconstructedAt) : Date.parse(analysis.cutoffAt);
    if (!stamp(e.publishedAt) || Date.parse(e.publishedAt) > Date.parse(analysis.cutoffAt) || !stamp(e.verifiedAt) || Date.parse(e.verifiedAt) > verifiedLimit || Date.parse(e.verifiedAt) < Date.parse(e.publishedAt)) fail('事件发布时间/核查时间晚于截止时间或顺序无效');
    if (reconstructedAt && (!stamp(e.availableAt) || Date.parse(e.availableAt) < Date.parse(e.publishedAt) || Date.parse(e.availableAt) > now.getTime())) fail('回放事件尚不可用');
    if (![e.fact, e.inference, e.rationale, e.title, e.url].every(text) || !/^https:\/\//.test(e.url)) fail('事件需要事实、推断、评分理由及 HTTPS 来源');
    if (!text(e.kind)) fail('缺少历史事件分类');
    for (const [v, lo, hi] of [[e.direction, -1, 1], [e.similarity, 0, 1], [e.confidence, 0, 1], [e.novelty, 0, 1]]) if (!Number.isFinite(v) || v < lo || v > hi) fail('事件评分越界');
    const ageDays = (Date.parse(analysis.cutoffAt) - Date.parse(e.publishedAt)) / DAY;
    if (ageDays > 28) fail('只允许最近 28 天已发布事件进入新预测');
    const classifications = [7, 30].map(horizon => {
      const matched = matchHistory(e, library, horizon, analysis.cutoffAt);
      const contribution = e.direction * (matched.level || 0) / 4 * matched.reliability * e.similarity * e.confidence * e.novelty * 2 ** (-ageDays / 7);
      return { ...matched, contribution };
    });
    return { ...e, ageDays, classifications };
  });
  // Average within a channel: repeated stories must not mechanically amplify the same event.
  const horizons = [7, 30].map(horizon => {
    const groups = new Map();
    for (const e of events) { const list = groups.get(e.category) || []; list.push(e.classifications.find(c => c.horizon === horizon).contribution); groups.set(e.category, list); }
    const channelScores = Object.fromEntries([...groups].map(([k, v]) => [k, mean(v)]));
    const eventScore = clamp(Object.values(channelScores).reduce((a, b) => a + b, 0), -1, 1);
    const targetDate = day(Date.parse(issueDay) + horizon * DAY);
    const elapsed = (Date.parse(targetDate) - Date.parse(anchor.date)) / DAY;
    const width = sigma * Math.sqrt(elapsed), trend = clamp(drift * elapsed, -width, width);
    const eventLogAdjustment = 0.5 * eventScore * width;
    const noEvents = anchor.price * Math.exp(trend), base = noEvents * Math.exp(eventLogAdjustment);
    return { horizon, targetDate, elapsedFromAnchor: elapsed, noEvents, unchanged: anchor.price, base, weak: base * Math.exp(-width), strong: base * Math.exp(width), trendLogReturn: trend, eventLogAdjustment, eventAdjustmentPct: (Math.exp(eventLogAdjustment) - 1) * 100, eventScore, channelScores, rangeKind: 'scenario-envelope-not-confidence-interval' };
  });
  const result = { schema: 1, id: analysis.id, modelVersion: EVENT_MODEL, issuedAt, analysisCutoffAt: analysis.cutoffAt, author: analysis.author, updateMode: 'agent-triggered-free', anchor: { date: anchor.date, price: anchor.price }, source: market.source, sourceFetchedAt: market.fetchedAt, inputFingerprint: fingerprint(sample), analysisFingerprint: fingerprint(analysis), libraryFingerprint: fingerprint(library), summary: analysis.summary, coverageGaps: analysis.coverageGaps, conditions: analysis.conditions, events, parameters: { lookback: 60, trendShrinkage: 0.35, halfLifeDays: 7, sampleShrinkage: 5, maxEventSigma: 0.5, rangeSigma: 1, dailyVolatility: sigma, dailyTrend: drift }, features: { return7dPct: (anchor.price / sample.at(-8).price - 1) * 100, return28dPct: (anchor.price / sample.at(-29).price - 1) * 100, annualVolatilityPct: sigma * Math.sqrt(365) * 100 }, horizons };
  if (reconstructedAt) {
    delete result.issuedAt;
    result.updateMode = 'retrospective-current-model';
    result.asOf = issuedAt;
    result.reconstructedAt = reconstructedAt;
  }
  return result;
}

export function compareEventForecast(f, actual) {
  if (!Number.isFinite(actual.price) || actual.price <= 0 || actual.date < f.issuedAt.slice(0, 10)) return [];
  return f.horizons.filter(h => actual.date <= h.targetDate).map(h => {
    const settled = actual.date === h.targetDate;
    const error = p => settled ? Math.abs(p / actual.price - 1) * 100 : null;
    return { forecastId: f.id, modelVersion: f.modelVersion, issuedAt: f.issuedAt, horizon: h.horizon, targetDate: h.targetDate, date: actual.date, actualPrice: actual.price, actualObservedAt: actual.observedAt, actualSourceFetchedAt: actual.sourceFetchedAt, base: h.base, weak: h.weak, strong: h.strong, noEvents: h.noEvents, unchanged: h.unchanged, status: settled ? 'settled' : 'tracking', targetGapPct: (h.base / actual.price - 1) * 100, absoluteErrorPct: error(h.base), noEventsErrorPct: error(h.noEvents), unchangedErrorPct: error(h.unchanged), envelopeHit: settled ? actual.price >= h.weak && actual.price <= h.strong : null };
  });
}
