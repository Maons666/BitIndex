import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readTracking, trackingCsv } from './tracking.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function buildPages({ trackingRoot = process.env.BITINDEX_TRACKING_DIR || join(root, 'predictions'), cacheRoot = process.env.BITINDEX_CACHE_DIR || join(root, '.cache'), output = join(root, 'dist'), repository = process.env.GITHUB_REPOSITORY || 'Maons666/BitIndex' } = {}) {
  const raw = JSON.parse(await readFile(join(cacheRoot, 'coinmetrics-btc.json'), 'utf8'));
  if (raw.version !== 1 || raw.source !== 'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics' || raw.rows.length < 365 || !Number.isFinite(Date.parse(raw.fetchedAt))) throw new Error('缺少有效真实数据，无法发布');
  const view = await readTracking(trackingRoot);
  if (!view.total || view.newForecastsEnabled !== false) throw new Error('历史预测留档缺失或模式错误，拒绝发布空白对照');
  const r = view.lastRun;
  const tracking = { schema: view.schema, mode: view.mode, newForecastsEnabled: false, total: view.total, pending: view.pending, settled: view.settled, versions: view.versions,
    latestActual: view.latestActual,
    lastRun: r ? { mode: r.mode, status: r.status, finishedAt: r.finishedAt, sourceFetchedAt: r.sourceFetchedAt, dataThrough: r.dataThrough, error: r.status === 'success' ? null : '后台更新尚未成功完成，显示上次已记录数据' } : null,
    forecasts: view.forecasts.slice(0, 60).map(({ id, modelVersion, issuedAt, prediction, comparison }) => ({ id, modelVersion, issuedAt, prediction, comparison })) };
  const csv = trackingCsv(view.comparisons);
  const version = createHash('sha256').update(JSON.stringify([raw, tracking, csv])).digest('hex');
  const prefix = `data/${version}`, publishedAt = new Date().toISOString();
  const manifest = { schema: 1, version, publishedAt, sourceFetchedAt: raw.fetchedAt, dataThrough: raw.rows.findLast(r => r.price !== null)?.date, market: `${prefix}/market.json`, tracking: `${prefix}/tracking.json`, csv: `${prefix}/daily-comparison.csv` };
  await mkdir(join(output, prefix), { recursive: true });
  const assets = ['style.css', 'app.mjs', 'core.mjs', 'chart.mjs', 'forecast.mjs', 'data-client.mjs', 'favicon.svg'];
  for (const file of assets) await copyFile(join(root, 'dashboard/public', file), join(output, file));
  let html = await readFile(join(root, 'dashboard/public/index.html'), 'utf8');
  html = html.replace('最近核对', '数据获取时间')
    .replace('更新实际数据 ↻', '刷新对照 ↻')
    .replace('href="/api/tracking.csv"', `href="./${manifest.csv}"`)
    .replace('刷新会重新请求真实历史数据，数据源未发布新日线时数值保持不变。', '云端每天更新真实数据与历史预测对照；页面刷新读取最新已发布版本，不触发后台取数。数据源未发布新日线时数值保持不变。')
    .replace('自动任务只更新实际价格和历史预测对照，以纽约时间 09:00 为日界执行门槛，失败按小时重试，需要电脑开机、联网且当前用户已登录。', 'GitHub Actions 每小时检查一次，纽约时间 09:00 后更新实际价格与历史预测对照，最新完整 UTC 日线已获取时跳过重复取数；失败或日线延迟则重试。执行可能受平台排队影响，无需保持本机开机。')
    .replace('<div class="notice" id="notice"', '<p class="publication-note">每日自动更新 · 刷新读取最新发布数据 · <a href="https://github.com/' + repository + '/actions/workflows/pages.yml" target="_blank" rel="noreferrer">更新记录 ↗</a></p>\n    <div class="notice" id="notice"');
  await writeFile(join(output, 'index.html'), html);
  await writeFile(join(output, 'runtime.mjs'), `export const deployment = ${JSON.stringify({ mode: 'pages', repository })};\n`);
  await writeFile(join(output, prefix, 'market.json'), JSON.stringify({ ...raw, publicationVersion: version }));
  await writeFile(join(output, prefix, 'tracking.json'), JSON.stringify({ ...tracking, publicationVersion: version }));
  await writeFile(join(output, prefix, 'daily-comparison.csv'), csv);
  await writeFile(join(output, 'data/manifest.json'), JSON.stringify(manifest));
  await writeFile(join(output, '.nojekyll'), '');
  return { output, version, dataThrough: manifest.dataThrough, forecasts: view.total };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await buildPages(), null, 2));
