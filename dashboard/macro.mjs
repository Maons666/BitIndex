import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DAY, positive, valid } from './public/core.mjs';
import { buildModel, evaluateBacktest } from './model.mjs';

export const MACRO_VERSION = 'ridge-30d-macro-v1';
export const VIX_SOURCE = 'https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv';
export const EFFR_SOURCE = 'https://markets.newyorkfed.org/api/rates/unsecured/effr/search.json';
export const EXTERNAL_FEATURES = [
  { id: 'vix', name: 'VIX 风险水平', transform: 'log' },
  { id: 'vixChange30', name: 'VIX 30 日变化', transform: 'identity' },
  { id: 'effr', name: '有效联邦基金利率', transform: 'identity' },
  { id: 'effrChange90', name: '利率 90 日变化', transform: 'identity' }
];
const dateAfter = (date, days) => new Date(Date.parse(date) + days * DAY).toISOString().slice(0, 10);
const isDate = date => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
export function parseVix(csv) {
  const lines = csv.trim().replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines.shift() !== 'DATE,OPEN,HIGH,LOW,CLOSE') throw new Error('Cboe VIX 数据格式变化');
  return lines.map(line => {
    const [d, , , , close] = line.split(','), [month, day, year] = d.split('/'), date = `${year}-${month?.padStart(2, '0')}-${day?.padStart(2, '0')}`;
    return { date, value: Number(close) };
  }).filter(r => isDate(r.date) && positive(r.value) && r.date >= '2010-01-01').sort((a, b) => a.date.localeCompare(b.date));
}
export function parseEffr(json) {
  if (!Array.isArray(json.refRates)) throw new Error('纽约联储利率格式变化');
  return json.refRates.filter(r => r.type === 'EFFR' && isDate(r.effectiveDate) && valid(r.percentRate)).map(r => ({ date: r.effectiveDate, value: r.percentRate })).sort((a, b) => a.date.localeCompare(b.date));
}
export function alignMacro(dates, snapshot) {
  function known(series, date, lag) {
    // A conservative availability assumption, not historical publication/vintage metadata.
    const cutoff = dateAfter(date, -lag); let lo = 0, hi = series.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (series[mid].date <= cutoff) lo = mid + 1; else hi = mid; }
    const point = series[lo - 1];
    return point && Date.parse(date) - Date.parse(point.date) <= 14 * DAY ? point : null;
  }
  return new Map(dates.map(date => {
    const v = known(snapshot.vix, date, 1), v30 = known(snapshot.vix, dateAfter(date, -30), 1);
    const r = known(snapshot.effr, date, 4), r90 = known(snapshot.effr, dateAfter(date, -90), 4);
    return [date, { vix: v?.value ?? null, vixChange30: v && v30 ? Math.log(v.value / v30.value) : null,
      effr: r?.value ?? null, effrChange90: r && r90 ? r.value - r90.value : null,
      vixObservedDate: v?.date ?? null, effrObservedDate: r?.date ?? null }];
  }));
}
export function createMacroStore(cachePath, fetcher = fetch) {
  let snapshot = null, loaded = false, flight = null;
  async function load() {
    if (loaded) return; loaded = true;
    try { const saved = JSON.parse(await readFile(cachePath, 'utf8')); if (saved.version === 1 && saved.vix.length > 1000 && saved.effr.length > 1000) snapshot = saved; } catch {}
  }
  async function refresh() {
    await load(); if (flight) return flight;
    flight = (async () => {
      try {
        const end = new Date().toISOString().slice(0, 10), url = new URL(EFFR_SOURCE);
        url.searchParams.set('startDate', '2010-01-01'); url.searchParams.set('endDate', end);
        const replies = await Promise.allSettled([VIX_SOURCE, url].map(async u => {
          const r = await fetcher(u, { signal: AbortSignal.timeout(25000) });
          if (!r.ok) throw new Error(`外部数据源 HTTP ${r.status}`); return r;
        }));
        if (replies.some(r => r.status === 'rejected')) throw new Error(replies.find(r => r.status === 'rejected').reason.message);
        const vix = parseVix(await replies[0].value.text()).filter(r => r.date < end), effr = parseEffr(await replies[1].value.json()).filter(r => r.date < end);
        if ([vix, effr].some(rs => rs.length < 1000 || rs[0].date > '2011-01-01')) throw new Error('外部数据历史不完整');
        if (snapshot && (vix.at(-1).date < snapshot.vix.at(-1).date || effr.at(-1).date < snapshot.effr.at(-1).date)) throw new Error('外部数据日期倒退');
        snapshot = { version: 1, fetchedAt: new Date().toISOString(), sources: { vix: VIX_SOURCE, effr: EFFR_SOURCE }, vix, effr };
        await mkdir(dirname(cachePath), { recursive: true }); const temp = cachePath + '.' + randomUUID() + '.tmp';
        try { await writeFile(temp, JSON.stringify(snapshot)); await rename(temp, cachePath); }
        finally { await unlink(temp).catch(() => {}); }
        return { ...snapshot, state: 'fresh', error: null };
      } catch (e) { if (!snapshot) throw e; return { ...snapshot, state: 'stale', error: e.message }; }
      finally { flight = null; }
    })();
    return flight;
  }
  return { refresh, async get() { await load(); return snapshot ? { ...snapshot, state: 'cached' } : refresh(); } };
}
export function buildMacroModel(bitcoin, macro, original) {
  const byDate = alignMacro(bitcoin.rows.map(r => r.date), macro);
  const model = buildModel(bitcoin.rows, { version: MACRO_VERSION }, { features: EXTERNAL_FEATURES, byDate });
  const externalFingerprint = createHash('sha256').update(JSON.stringify({ vix: macro.vix, effr: macro.effr })).digest('hex');
  const dates = new Set(model.history.map(r => r.date)), originalPairs = original.history.filter(r => dates.has(r.date)), pairedDates = new Set(originalPairs.map(r => r.date));
  const candidatePairs = model.history.filter(r => pairedDates.has(r.date));
  const recentStart = dateAfter(model.current.date, -730);
  const paired = { original: evaluateBacktest(originalPairs), candidate: evaluateBacktest(candidatePairs),
    recentOriginal: evaluateBacktest(originalPairs.filter(r => r.date >= recentStart)), recentCandidate: evaluateBacktest(candidatePairs.filter(r => r.date >= recentStart)) };
  return { ...model, fingerprint: original.fingerprint, source: bitcoin.source, fetchedAt: bitcoin.fetchedAt,
    external: { fingerprint: externalFingerprint, fetchedAt: macro.fetchedAt, state: macro.state, sources: macro.sources, vixThrough: macro.vix.at(-1).date, effrThrough: macro.effr.at(-1).date, availabilityLagDays: { vix: 1, effr: 4 }, maxObservationAgeDays: 14, currentInputs: byDate.get(model.current.featureDate), error: macro.error ?? null },
    paired, role: 'candidate' };
}
