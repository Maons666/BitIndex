import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildEventForecast } from './event-model.mjs';
import { eventRoot, readEventForecasts } from './event-store.mjs';
import { writeOnce } from './tracking.mjs';
import { readIntraday } from './intraday.mjs';
// Explicit CLI only, never called by page refresh or Actions schedule.
export async function publishAnalysis(analysis, market, { root = eventRoot, now = new Date() } = {}) {
  await readEventForecasts(root);
  const f = buildEventForecast(analysis, market, { now }), name = f.id + '.json';
  const encode = x => JSON.stringify(x, null, 2) + '\n';
  let lock = {};
  try { lock = JSON.parse(await readFile(join(root, 'forecast-lock.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (lock[name]) throw new Error('该分析已发布；请新增版本，不能重写原预测');
  const inputs = { version: market.version, source: market.source, fetchedAt: market.fetchedAt, eventLibrary: market.eventLibrary || { cases: [] }, rows: market.rows.filter(r => r.date < f.issuedAt.slice(0, 10) && Number.isFinite(r.price) && r.price > 0).slice(-61).map(({ date, price }) => ({ date, price })) };
  if (market.intradayContext) inputs.intradayContext = structuredClone(market.intradayContext);
  // Fingerprints cover exactly the saved price rows; remove unconsumed raw metrics before building.
  const exact = buildEventForecast(analysis, inputs, { now });
  const exactRaw = encode(exact);
  for (const [folder, value] of [['analyses', encode(analysis)], ['inputs', encode(inputs)], ['forecasts', exactRaw]]) {
    if (!await writeOnce(join(root, folder, name), value)) throw new Error('已有同名文件，拒绝覆盖：' + folder + '/' + name);
  }
  lock[name] = createHash('sha256').update(exactRaw).digest('hex');
  await mkdir(root, { recursive: true }); await writeFile(join(root, 'forecast-lock.json'), encode(lock));
  return exact;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [analysisPath, marketPath] = process.argv.slice(2);
  if (!analysisPath || !marketPath) throw new Error('用法：node dashboard/publish-analysis.mjs <已核查分析.json> <行情快照.json>');
  const market = JSON.parse(await readFile(marketPath, 'utf8'));
  market.eventLibrary = JSON.parse(await readFile(join(eventRoot, 'library.json'), 'utf8'));
  const analysis = JSON.parse(await readFile(analysisPath, 'utf8'));
  const { rows, lastAttempt, limitations, ...context } = await readIntraday(process.env.BITINDEX_TRACKING_DIR || join(eventRoot, '..', 'predictions'));
  if (context.features && lastAttempt?.status === 'success' && Date.parse(context.receivedAt) <= Date.parse(analysis.cutoffAt) && Date.parse(analysis.cutoffAt) - Date.parse(context.receivedAt) <= 30 * 3600000) market.intradayContext = context;
  const f = await publishAnalysis(analysis, market);
  console.log(JSON.stringify({ id: f.id, issuedAt: f.issuedAt, horizons: f.horizons }, null, 2));
}
