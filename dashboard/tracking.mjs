import { mkdir, readFile, writeFile, readdir, link, unlink, rename, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DAY, positive, valid } from './public/core.mjs';

const day = date => new Date(date).toISOString().slice(0, 10);
export const TRACKING_MODE = 'comparison-only';
const average = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
export function newYorkClock(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}
// Publish a complete file atomically, without replacing an existing record, even across processes.
export async function writeOnce(path, content) {
  try { await access(path); return false; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, content, { flag: 'wx' });
    try { await link(temporary, path); return true; }
    catch (e) { if (e.code !== 'EEXIST') throw e; return false; }
  } finally { await unlink(temporary).catch(() => {}); }
}
const jsonOnce = (path, value) => writeOnce(path, JSON.stringify(value, null, 2));
async function records(folder) {
  let names;
  try { names = await readdir(folder, { recursive: true, withFileTypes: true }); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const files = names.filter(f => f.isFile() && f.name.endsWith('.json'));
  const output = [];
  for (const f of files) {
    try { output.push(JSON.parse(await readFile(join(f.parentPath ?? f.path, f.name), 'utf8'))); }
    catch (e) { throw new Error(`追踪记录损坏，未覆盖原文件：${f.name} (${e.message})`); }
  }
  return output;
}
async function replaceFile(path, content) {
  await mkdir(dirname(path), { recursive: true }); const temp = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temp, content);
    for (let n = 0; ; n++) {
      try { await rename(temp, path); break; }
      catch (e) { if (n >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e; await new Promise(r => setTimeout(r, 50 * (n + 1))); }
    }
  } finally { await unlink(temp).catch(() => {}); }
}
export function compareForecast(forecast, actual, createdAt) {
  const c = forecast.prediction, elapsed = (Date.parse(actual.date) - Date.parse(c.date)) / DAY;
  if (actual.date < c.date || actual.date > c.targetDate || !positive(actual.price)) return null;
  const settled = actual.date === c.targetDate;
  return {
    schema: 1, forecastId: forecast.id, modelVersion: forecast.modelVersion, issuedAt: forecast.issuedAt,
    createdAt, date: actual.date, baselineDate: c.date, targetDate: c.targetDate, elapsedDays: elapsed,
    baselinePrice: c.price, predictedPrice: c.predictedPrice, actualPrice: actual.price,
    actualObservedAt: actual.observedAt, actualSourceFetchedAt: actual.sourceFetchedAt,
    status: settled ? 'settled' : 'tracking', actualReturnPct: (actual.price / c.price - 1) * 100,
    targetGapPct: (c.predictedPrice / actual.price - 1) * 100,
    errorPct: settled ? (c.predictedPrice / actual.price - 1) * 100 : null,
    absoluteErrorPct: settled ? Math.abs(c.predictedPrice / actual.price - 1) * 100 : null,
    baselineErrorPct: settled ? Math.abs(c.price / actual.price - 1) * 100 : null,
    directionCorrect: settled ? Math.sign(c.predictedPrice - c.price) === Math.sign(actual.price - c.price) : null,
    intervalHit: settled && valid(c.lower) && valid(c.upper) ? actual.price >= c.lower && actual.price <= c.upper : null,
    dataFingerprint: forecast.dataFingerprint
  };
}
export function trackingCsv(comparisons) {
  const columns = ['forecastId', 'modelVersion', 'issuedAt', 'baselineDate', 'targetDate', 'date', 'status', 'elapsedDays', 'baselinePrice', 'predictedPrice', 'actualPrice', 'actualReturnPct', 'targetGapPct', 'errorPct', 'absoluteErrorPct', 'baselineErrorPct', 'directionCorrect', 'intervalHit', 'actualObservedAt', 'actualSourceFetchedAt', 'dataFingerprint'];
  return '\uFEFF' + [columns.join(','), ...comparisons.slice().sort((a, b) => a.date.localeCompare(b.date) || a.forecastId.localeCompare(b.forecastId)).map(r => columns.map(k => r[k] ?? '').join(','))].join('\r\n');
}
export async function readTracking(root) {
  const [forecasts, comparisons, runs, actuals] = await Promise.all([records(join(root, 'forecasts')), records(join(root, 'comparisons')), records(join(root, 'runs')), records(join(root, 'actuals'))]);
  forecasts.sort((a, b) => b.issuedAt.localeCompare(a.issuedAt) || a.id.localeCompare(b.id));
  runs.sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
  const latest = new Map(), settled = new Map();
  for (const r of comparisons) {
    if (!latest.has(r.forecastId) || latest.get(r.forecastId).date < r.date) latest.set(r.forecastId, r);
    if (r.status === 'settled') settled.set(r.forecastId, r);
  }
  const versions = [...new Set(forecasts.map(f => f.modelVersion))].map(version => {
    const rs = [...settled.values()].filter(r => r.modelVersion === version), intervals = rs.filter(r => r.intervalHit !== null);
    return { version, settled: rs.length, mape: average(rs.map(r => r.absoluteErrorPct)), baselineMape: average(rs.map(r => r.baselineErrorPct)), directionAccuracy: rs.length ? average(rs.map(r => Number(r.directionCorrect))) * 100 : null, intervalCoverage: intervals.length ? average(intervals.map(r => Number(r.intervalHit))) * 100 : null };
  });
  actuals.sort((a, b) => b.date.localeCompare(a.date));
  return { schema: 1, mode: TRACKING_MODE, newForecastsEnabled: false, total: forecasts.length, settled: settled.size, pending: forecasts.length - settled.size, versions, lastRun: runs[0] ?? null, latestActual: actuals[0] ?? null,
    forecasts: forecasts.map(f => ({ ...f, comparison: latest.get(f.id) ?? null })), comparisons };
}
export async function recordRun(root, info, now = new Date()) {
  const finishedAt = now.toISOString(), run = { schema: 1, ...info, finishedAt, localDate: newYorkClock(now).date };
  await jsonOnce(join(root, 'runs', day(now), finishedAt.replace(/[:.]/g, '-') + '_' + randomUUID() + '.json'), run);
  return run;
}
export async function shouldRunScheduled(root, now = new Date()) {
  const clock = newYorkClock(now);
  if (clock.hour < 9) return false;
  const runs = await records(join(root, 'runs'));
  return !runs.some(r => r.scope === 'daily' && r.mode === TRACKING_MODE && r.status === 'success' && r.localDate === clock.date && r.dataThrough >= day(now.getTime() - DAY));
}
// Production tracking deliberately has no model builder or forecast-writing path.
export async function updateComparisons(root, snapshot, { now = new Date(), trigger = 'manual' } = {}) {
  const stamp = now.toISOString(), utcToday = day(now), expected = day(now.getTime() - DAY);
  const base = { scope: 'daily', mode: TRACKING_MODE, archived: false, trigger, sourceFetchedAt: snapshot.fetchedAt };
  if (snapshot.state !== 'fresh') return recordRun(root, { ...base, status: 'stale', error: snapshot.error || '未取得新的官方数据；保留原对照', dataThrough: snapshot.rows.at(-1)?.date }, now);
  const rows = snapshot.rows.filter(r => r.date < utcToday && positive(r.price)).sort((a, b) => a.date.localeCompare(b.date));
  const last = rows.at(-1);
  const delayed = last?.date !== expected ? '数据源尚未发布最新完整日线；已更新可用实际数据，稍后重试' : null;
  const forecasts = await records(join(root, 'forecasts'));
  const firstDate = forecasts.map(f => f.prediction.date).sort()[0];
  // Preserve each real fetch, including revisions; evaluations use first-observed daily values.
  const observationPath = join('observations', utcToday, stamp.replace(/[:.]/g, '-') + '_' + randomUUID() + '.json');
  await jsonOnce(join(root, observationPath), { schema: 1, observedAt: stamp, sourceFetchedAt: snapshot.fetchedAt, source: snapshot.source, dataThrough: last?.date ?? null, rows: rows.filter(r => !firstDate ? r === last : r.date >= firstDate).map(({ date, price }) => ({ date, price })) });
  let newActuals = 0, newComparisons = 0;
  for (const row of rows) {
    if (!firstDate || row.date < firstDate) continue;
    const path = join(root, 'actuals', row.date + '.json');
    if (await jsonOnce(path, { schema: 1, date: row.date, price: row.price, observedAt: stamp, sourceFetchedAt: snapshot.fetchedAt, source: snapshot.source })) newActuals++;
    const actual = JSON.parse(await readFile(path, 'utf8'));
    for (const f of forecasts) {
      const comparison = compareForecast(f, actual, stamp);
      if (comparison && await jsonOnce(join(root, 'comparisons', row.date, f.id + '.json'), comparison)) newComparisons++;
    }
  }
  const view = await readTracking(root);
  // This CSV is a disposable view. JSON records above are immutable source records.
  await replaceFile(join(root, 'daily-comparison.csv'), trackingCsv(view.comparisons));
  const run = await recordRun(root, { ...base, status: delayed ? 'delayed' : 'success', dataThrough: last?.date ?? null, observedPrice: last?.price ?? null, observationPath, newActuals, newComparisons, total: view.total, settled: view.settled, error: delayed }, now);
  await replaceFile(join(root, 'latest-comparison.md'), comparisonReport({ ...view, lastRun: run }));
  return run;
}

export function comparisonReport(view) {
  const money = n => Number.isFinite(n) ? '$' + n.toFixed(2) : '—';
  const pct = n => Number.isFinite(n) ? n.toFixed(2) + '%' : '—';
  const run = view.lastRun;
  const lines = ['# 历史预测与实际价格对照', '', '已停止新增预测；原预测、模型参数和输入快照保持原样。', '',
    `最近运行：${run?.finishedAt ?? '—'}（UTC），状态 ${run?.status ?? '—'}。`,
    `真实数据获取时间：${run?.sourceFetchedAt ?? '—'}；最新已记录完整日线：${view.latestActual?.date ?? '—'}（UTC），价格 ${money(view.latestActual?.price)}。`,
    `留档 ${view.total} 份，已到期验证 ${view.settled} 份，待验证 ${view.pending} 份。`, '',
    '| 留档 ID | 目标日（UTC） | 原预测价 | 实际日（UTC） | 实际价 | 目标价相对实际价差 | 到期绝对误差 |',
    '| --- | --- | ---: | --- | ---: | ---: | ---: |'];
  for (const f of view.forecasts) {
    const c = f.comparison;
    lines.push(`| ${f.id} | ${f.prediction.targetDate} | ${money(f.prediction.predictedPrice)} | ${c?.date ?? '—'} | ${money(c?.actualPrice)} | ${pct(c?.targetGapPct)} | ${c?.status === 'settled' ? pct(c.absoluteErrorPct) : '待目标日数据'} |`);
  }
  lines.push('', '价差 =（预测价 ÷ 实际价 − 1）× 100%；期间价差不代表到期预测误差。只在精确目标日取得实际价格后结算，缺失目标日不以邻近日替代。', '',
    '日线评估固定首次获取的实际值；每次刷新取得的价格与时间另存 observations，以保留数据源后续修订。完整逐日比较见 [daily-comparison.csv](daily-comparison.csv)。', '',
    `数据源：[Coin Metrics Community API](${view.latestActual?.source ?? 'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics'})。`, '');
  return lines.join('\n');
}
