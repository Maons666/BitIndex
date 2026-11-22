import { readFile, readdir, mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { writeOnce } from './tracking.mjs';

export const HOURLY_SOURCE = 'https://api.kraken.com/0/public/OHLC';
const HOUR = 3600000;
const hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const encode = x => JSON.stringify(x, null, 2) + '\n';
async function optional(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch(e) { if(e.code === 'ENOENT') return null; throw e; } }
async function atomic(path, value) {
  const temp = path + '.' + randomUUID() + '.tmp';
  await writeFile(temp, encode(value)); await rename(temp, path);
}
export function normalizeHourly(payload, receivedAt) {
  const cutoff = Date.parse(receivedAt);
  if (!Number.isFinite(cutoff) || !Array.isArray(payload?.error) || payload.error.length) throw new Error('Kraken 返回错误或获取时间无效');
  const raw = payload.result?.XXBTZUSD;
  if (!Array.isArray(raw) || raw.length < 2) throw new Error('Kraken BTC/USD 小时数据缺失');
  const rows = new Map();
  // Kraken explicitly marks the final candle as uncommitted, even with since.
  for (const v of raw.slice(0, -1)) {
    if (!Array.isArray(v) || v.length !== 8 || v.some(x => x === null || x === '' || typeof x === 'boolean')) throw new Error('小时记录格式无效');
    const [seconds, open, high, low, close, vwap, volume, trades] = v.map(Number);
    if (![seconds, open, high, low, close, vwap, volume, trades].every(Number.isFinite) || !Number.isInteger(seconds) || seconds % 3600 !== 0 || seconds < 0 || Math.min(open, high, low, close, vwap) <= 0 || low > Math.min(open, close, vwap) || high < Math.max(open, close, vwap) || volume < 0 || !Number.isInteger(trades) || trades < 0) throw new Error('小时价格、成交量或时间无效');
    if ((seconds + 3600) * 1000 > cutoff) continue;
    const time = new Date(seconds * 1000).toISOString(), row = { time, open, high, low, close, vwap, volume, trades };
    if (rows.has(time) && hash(rows.get(time)) !== hash(row)) throw new Error('同一小时返回冲突记录');
    rows.set(time, row);
  }
  if (!rows.size) throw new Error('没有已结束的小时');
  return [...rows.values()].sort((a, b) => a.time.localeCompare(b.time));
}
export function hourlyFeatures(rows) {
  if (!rows.length) return null;
  const last = rows.at(-1), end = Date.parse(last.time), byTime = new Map(rows.map(r => [Date.parse(r.time), r]));
  const window = n => {
    const selected = Array.from({ length: n }, (_, i) => byTime.get(end - (n - 1 - i) * HOUR));
    return selected.every(Boolean) ? selected : null;
  };
  const ret = hours => { const w = window(hours + 1); return w ? (last.close / w[0].close - 1) * 100 : null; };
  const w24 = window(24), w25 = window(25), w192 = window(192);
  const volume = w => w.reduce((s, r) => s + r.volume, 0);
  const vol24 = w24 ? volume(w24) : null, previousAverage = w192 ? volume(w192.slice(0, 168)) / 7 : null;
  return {
    through: new Date(end + HOUR).toISOString(), price: last.close,
    return1hPct: ret(1), return6hPct: ret(6), return24hPct: ret(24),
    realizedVolatility24hPct: w25 ? Math.sqrt(w25.slice(1).reduce((s, r, i) => s + Math.log(r.close / w25[i].close) ** 2, 0)) * 100 : null,
    low24h: w24 ? Math.min(...w24.map(r => r.low)) : null,
    high24h: w24 ? Math.max(...w24.map(r => r.high)) : null,
    belowHigh24hPct: w24 ? (last.close / Math.max(...w24.map(r => r.high)) - 1) * 100 : null,
    vwap24h: vol24 > 0 ? w24.reduce((s, r) => s + r.vwap * r.volume, 0) / vol24 : null,
    volume24hBTC: vol24,
    volumeRatio: previousAverage > 0 && vol24 !== null ? vol24 / previousAverage : null,
    continuousHours: (() => { let n = 0; while (byTime.has(end - n * HOUR)) n++; return n; })()
  };
}
export async function readHourlyArchive(trackingRoot) {
  const folder = join(trackingRoot, 'intraday', 'batches');
  let files; try { files = (await readdir(folder)).filter(f => /^\d{4}-\d\d-\d\d\.json$/.test(f)).sort(); } catch(e) { if(e.code === 'ENOENT') return { rows: [], batches: [] }; throw e; }
  const map = new Map(), batches = [];
  for (const f of files) {
    const batch = await optional(join(folder, f));
    const { fingerprint, ...content } = batch;
    if (hash(content) !== fingerprint || batch.source !== HOURLY_SOURCE || batch.intervalMinutes !== 60 || !Number.isFinite(Date.parse(batch.receivedAt))) throw new Error('小时留档校验失败：' + f);
    for (const row of batch.newRows) {
      if (Date.parse(row.time) + HOUR > Date.parse(batch.receivedAt) || map.has(row.time)) throw new Error('小时留档存在未来数据或重复覆盖');
      map.set(row.time, row);
    }
    batches.push(batch);
  }
  return { rows: [...map.values()].sort((a, b) => a.time.localeCompare(b.time)), batches };
}
export async function readIntraday(trackingRoot) {
  const { rows, batches } = await readHourlyArchive(trackingRoot), latest = batches.at(-1);
  const lastAttempt = await optional(join(trackingRoot, 'intraday', 'last-attempt.json'));
  return {
    schema: 1, source: HOURLY_SOURCE, provider: 'Kraken', pair: 'BTC/USD', intervalMinutes: 60,
    mode: 'agent-context-not-fitted-coefficient', receivedAt: latest?.receivedAt ?? null,
    archiveFingerprint: latest?.fingerprint ?? null, lastAttempt,
    firstHour: rows[0]?.time ?? null, count: rows.length, features: hourlyFeatures(rows),
    rows: rows.slice(-168),
    limitations: ['单一交易所 USD 现货，成交量不代表全市场。', '仅使用已结束小时；缺失不插值。每天批量更新，并非实时推送。', '首次取得的历史小时只有今天的获取时间，不能冒充过去当时已知的数据。', '作为 agent 研判输入；尚未训练分时系数，不自动调整已签发目标。']
  };
}
export async function collectHourly(trackingRoot, { fetcher = fetch, now = new Date(), receivedAt } = {}) {
  const archive = await readHourlyArchive(trackingRoot), date = now.toISOString().slice(0, 10), folder = join(trackingRoot, 'intraday');
  if (archive.batches.some(b => b.date === date)) return { status: 'skipped', reason: '当天小时行情已留档' };
  const url = new URL(HOURLY_SOURCE); url.searchParams.set('pair', 'XBTUSD'); url.searchParams.set('interval', '60');
  if (archive.rows.length) url.searchParams.set('since', String(Date.parse(archive.rows.at(-1).time) / 1000));
  await mkdir(folder, { recursive: true });
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(25000), headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('Kraken HTTP ' + response.status);
    const payload = await response.json(), stamp = receivedAt || new Date().toISOString();
    if (Date.parse(stamp) < now.getTime() || stamp.slice(0, 10) !== date) throw new Error('获取时间早于请求或跨日，请重新采集');
    const fetched = normalizeHourly(payload, stamp);
    if (Date.parse(stamp) - Date.parse(fetched.at(-1).time) - HOUR > 2 * HOUR) throw new Error('小时数据已过期，保留旧记录');
    const known = new Map(archive.rows.map(r => [r.time, r]));
    const newRows = fetched.filter(r => !known.has(r.time));
    const revisions = fetched.filter(r => known.has(r.time) && hash(known.get(r.time)) !== hash(r)).map(r => ({ time: r.time, retained: known.get(r.time), providerRevision: r }));
    const content = { schema: 1, date, source: HOURLY_SOURCE, url: url.href, pair: 'BTC/USD', intervalMinutes: 60, receivedAt: stamp, payload, newRows, revisions };
    const batch = { ...content, fingerprint: hash(content) };
    if (!await writeOnce(join(folder, 'batches', date + '.json'), encode(batch))) throw new Error('当天留档已存在，拒绝覆盖');
    const result = { status: 'success', checkedAt: stamp, newHours: newRows.length, revisionsRetained: revisions.length };
    await atomic(join(folder, 'last-attempt.json'), result);
    return result;
  } catch(e) {
    await atomic(join(folder, 'last-attempt.json'), { status: 'failed', checkedAt: new Date().toISOString(), error: e.message });
    throw e;
  }
}
