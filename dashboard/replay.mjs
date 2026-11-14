import { replayEventForecast, fingerprint, EVENT_MODEL } from './event-model.mjs';
import { measureCase } from './event-library.mjs';
const DAY = 86400000;
const date = t => new Date(t).toISOString().slice(0, 10);
const validDate = d => /^\d{4}-\d\d-\d\d$/.test(d) && date(Date.parse(d)) === d;

export function selectReplayEvents(events, asOf) {
  const streams = new Map();
  for (const e of [...events].sort((a, b) => a.availableAt.localeCompare(b.availableAt) || a.id.localeCompare(b.id))) {
    if (Date.parse(e.availableAt) <= Date.parse(asOf) && Date.parse(e.publishedAt) <= Date.parse(asOf) && Date.parse(asOf) - Date.parse(e.publishedAt) <= 28 * DAY) streams.set(e.stream, e);
  }
  return [...streams.values()];
}

// Called manually with a frozen research packet. No automatic generation of agent opinions.
export function buildReplay(input) {
  const { id, reconstructedAt, targetStart, targetEnd, market, evidence, cases } = input;
  if (!/^[a-z0-9-]+$/.test(id) || !validDate(targetStart) || !validDate(targetEnd) || targetStart > targetEnd || Date.parse(targetEnd) >= Date.parse(reconstructedAt.slice(0, 10))) throw new Error('回放日期无效');
  const n = (Date.parse(targetEnd) - Date.parse(targetStart)) / DAY + 1;
  if (n > 366) throw new Error('回放范围过大');
  const originStart = date(Date.parse(targetStart) - 30 * DAY), originEnd = date(Date.parse(targetEnd) - 30 * DAY);
  if (evidence.coverageStart > date(Date.parse(originStart) - 28 * DAY) || evidence.coverageEnd < originEnd) throw new Error('历史事件研究未覆盖回放范围');
  const ids = new Set();
  for (const e of evidence.events) {
    if (ids.has(e.id) || !e.stream || !Number.isFinite(Date.parse(e.availableAt)) || Date.parse(e.availableAt) < Date.parse(e.publishedAt) || !Number.isFinite(Date.parse(e.verifiedAt)) || Date.parse(e.verifiedAt) > Date.parse(reconstructedAt)) throw new Error('历史证据时间或 ID 无效');
    ids.add(e.id);
  }
  const byDate = new Map(market.rows.map(r => [r.date, r]));
  if (byDate.size !== market.rows.length) throw new Error('行情日期重复');
  if (market.rows.some((r, i) => !validDate(r.date) || r.date >= market.fetchedAt.slice(0,10) || i && r.date <= market.rows[i-1].date)) throw new Error('行情含未完成日线或顺序错误');
  const rows = Array.from({ length: n }, (_, i) => {
    const targetDate = date(Date.parse(targetStart) + i * DAY), originDate = date(Date.parse(targetDate) - 30 * DAY);
    const asOf = originDate + 'T16:00:00.000Z', through = date(Date.parse(originDate) - 2 * DAY);
    const history = market.rows.filter(r => r.date <= through);
    if (history.at(-1)?.date !== through) throw new Error('回放基准日缺失：' + through);
    const library = { cases: cases.filter(c => c.publishedAt < asOf).map(c => measureCase({ id: c.id, title: c.title, kind: c.kind, publishedAt: c.publishedAt }, history)) };
    const selected = selectReplayEvents(evidence.events, asOf);
    const analysis = { id: 'replay-' + originDate, cutoffAt: asOf, author: evidence.author, summary: '按固定证据时间线与现有模型进行历史回放', coverageGaps: evidence.coverageGaps, events: selected };
    const f = replayEventForecast(analysis, { ...market, rows: history, eventLibrary: library }, { asOf, reconstructedAt });
    const h = f.horizons.find(h => h.horizon === 30);
    if (h.targetDate !== targetDate) throw new Error('目标日不一致');
    const actual = byDate.get(targetDate)?.price;
    if (!(actual > 0) || !Number.isFinite(actual)) throw new Error('精确目标日实际价格缺失：' + targetDate);
    return { mode: 'retrospective', asOf, targetDate, anchor: f.anchor, actualPrice: actual, actualSourceFetchedAt: market.fetchedAt, ...h,
      inputFingerprint: f.inputFingerprint, analysisFingerprint: f.analysisFingerprint, libraryFingerprint: f.libraryFingerprint,
      events: f.events.map(e => { const c = e.classifications.find(c => c.horizon === 30); return { id: e.id, level: c.level, count: c.count, contribution: c.contribution, matches: c.matches }; }) };
  });
  return { schema: 1, id, modelVersion: EVENT_MODEL, mode: 'retrospective-current-model', reconstructedAt, source: market.source, sourceFetchedAt: market.fetchedAt,
    inputFingerprint: fingerprint(input), targetStart, targetEnd, originStart, originEnd,
    protocol: { horizon: 30, cutoffTimeUTC: '16:00', priceLagDays: 2, parameterTuning: false, repeatedStreams: 'latest-available-only', interval: 'scenario-envelope-not-confidence-interval', actualVintage: 'current-download', independentSamples: false },
    limitations: ['今天重建的 agent 判断，不是当时发出的预测，也不是盲测。', '仅使用历史截止日前的事件和行情；原始历史发布版本不可得，假定日线滞后 2 个日历日。', '事件库和模型是在今天选定的，案例选择仍有事后偏差；30 天收益窗口重叠，样本不独立。', '没有当时的预期共识和完整新闻流；未找到类似历史事件时，事件调整为零。'],
    evidence, rows };
}
