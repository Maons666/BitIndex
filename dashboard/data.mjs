import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

export const SOURCE = 'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics';
export const FIELDS = 'PriceUSD,CapMVRVCur,IssTotUSD,IssTotNtv,HashRate';
const DAY = 86400000;
function numeric(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
export function normalize(data, today = new Date().toISOString().slice(0, 10)) {
  const map = new Map();
  for (const r of data) {
    const date = String(r.time ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date >= today || date < '2010-07-18') continue;
    const time = Date.parse(date + 'T00:00:00Z');
    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date) continue;
    map.set(date, { date, price: numeric(r.PriceUSD), mvrv: numeric(r.CapMVRVCur), issuanceUSD: numeric(r.IssTotUSD), issuance: numeric(r.IssTotNtv), hashrate: numeric(r.HashRate) });
  }
  const dates = [...map.keys()].sort();
  if (!dates.length) throw new Error('Coin Metrics 没有返回已完成的日线');
  const rows = [];
  for (let t = Date.parse(dates[0]); t <= Date.parse(dates.at(-1)); t += DAY) {
    const date = new Date(t).toISOString().slice(0, 10);
    rows.push(map.get(date) ?? { date, price: null, mvrv: null, issuanceUSD: null, issuance: null, hashrate: null });
  }
  if (!rows.some(r => r.price !== null)) throw new Error('数据源未返回有效价格');
  return rows;
}
export async function fetchHistory(fetcher = fetch) {
  let url = new URL(SOURCE);
  for (const [k, v] of Object.entries({ assets: 'btc', metrics: FIELDS, frequency: '1d', page_size: '10000', start_time: '2010-07-18' })) url.searchParams.set(k, v);
  const data = [], seen = new Set();
  while (url) {
    if (url.origin !== new URL(SOURCE).origin || url.pathname !== new URL(SOURCE).pathname || seen.has(url.href) || seen.size >= 20) throw new Error('数据源分页地址异常');
    seen.add(url.href);
    let response;
    try { response = await fetcher(url, { signal: AbortSignal.timeout(25000), headers: { Accept: 'application/json' } }); }
    catch { throw new Error('无法连接 Coin Metrics，请检查网络后重试'); }
    if (!response.ok) throw new Error(response.status === 429 ? 'Coin Metrics 请求额度暂时受限，请稍后重试' : `Coin Metrics 返回 HTTP ${response.status}`);
    const json = await response.json();
    if (!Array.isArray(json.data)) throw new Error('Coin Metrics 返回了无法识别的数据');
    data.push(...json.data);
    url = json.next_page_url ? new URL(json.next_page_url) : null;
  }
  const rows = normalize(data);
  // A successful HTTP response must not replace complete history with a truncated payload.
  if (rows.length < 365 || rows[0].date > '2011-01-01') throw new Error('数据源历史不完整，本次结果未覆盖缓存');
  return rows;
}
export function createDataStore(cachePath, fetcher = fetch) {
  let snapshot = null, flight = null, loaded = false;
  async function load() {
    if (loaded) return;
    loaded = true;
    try {
      const saved = JSON.parse(await readFile(cachePath, 'utf8'));
      if (saved.version === 1 && saved.source === SOURCE && Array.isArray(saved.rows) && saved.rows.length >= 365 && Number.isFinite(Date.parse(saved.fetchedAt))) snapshot = saved;
    } catch { /* First run or invalid cache: fetch from the provider. */ }
  }
  function payload(state, error = null, persistenceWarning = null) {
    return { ...snapshot, state, error, persistenceWarning, checkedAt: new Date().toISOString() };
  }
  async function refresh() {
    await load();
    if (flight) return flight;
    flight = (async () => {
      try {
        const rows = await fetchHistory(fetcher);
        const oldLast = snapshot?.rows.findLast(r => r.price !== null)?.date;
        const newLast = rows.findLast(r => r.price !== null)?.date;
        if (oldLast && newLast < oldLast) throw new Error('数据源返回的日期早于本地记录，本次保留较新记录');
        snapshot = { version: 1, source: SOURCE, fetchedAt: new Date().toISOString(), rows };
        let warning = null;
        const temporary = cachePath + '.' + randomUUID() + '.tmp';
        try {
          await mkdir(dirname(cachePath), { recursive: true });
          await writeFile(temporary, JSON.stringify(snapshot));
          for (let attempt = 0; ; attempt++) {
            try { await rename(temporary, cachePath); break; }
            catch (e) {
              if (attempt >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
              await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
            }
          }
        } catch { warning = '本次数据已更新，但无法保存离线缓存'; }
        finally { await unlink(temporary).catch(() => {}); }
        return payload('fresh', null, warning);
      } catch (e) {
        if (!snapshot) throw e;
        return payload('stale', e.message);
      } finally { flight = null; }
    })();
    return flight;
  }
  return { refresh, async get() { await load(); return snapshot ? payload('cached') : refresh(); } };
}
