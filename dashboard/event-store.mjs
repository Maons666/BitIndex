import { readFile, readdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { writeOnce } from './tracking.mjs';
import { buildEventForecast, compareEventForecast } from './event-model.mjs';
import { buildReplay } from './replay.mjs';
export const eventRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../event-predictions');
async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function listJson(path) {
  try { return (await readdir(path)).filter(x => x.endsWith('.json')).sort(); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
export async function readEventForecasts(root = eventRoot) {
  const files = await listJson(join(root, 'forecasts'));
  if (!files.length) return [];
  const lock = await readJson(join(root, 'forecast-lock.json'));
  if (files.length !== Object.keys(lock).length) throw new Error('事件预测锁数量不一致');
  const result = [];
  for (const file of files) {
    const raw = await readFile(join(root, 'forecasts', file), 'utf8');
    if (createHash('sha256').update(raw).digest('hex') !== lock[file]) throw new Error('事件预测留档被修改：' + file);
    const f = JSON.parse(raw), analysis = await readJson(join(root, 'analyses', file)), inputs = await readJson(join(root, 'inputs', file));
    const rebuilt = buildEventForecast(analysis, inputs, { now: new Date(f.issuedAt) });
    if (JSON.stringify(f) !== JSON.stringify(rebuilt)) throw new Error('事件预测不能由已存输入复算：' + file);
    result.push(f);
  }
  return result.sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
}
export async function updateEventComparisons(trackingRoot, { archiveRoot = eventRoot } = {}) {
  const forecasts = await readEventForecasts(archiveRoot);
  if (!forecasts.length) return;
  for (const file of await listJson(join(trackingRoot, 'actuals'))) {
    const actual = await readJson(join(trackingRoot, 'actuals', file));
    for (const f of forecasts) for (const c of compareEventForecast(f, actual)) {
      await writeOnce(join(trackingRoot, 'events', 'comparisons', `${f.id}__${c.horizon}__${c.date}.json`), JSON.stringify(c, null, 2));
    }
  }
}
export function eventCsv(rows) {
  const columns = ['forecastId', 'modelVersion', 'issuedAt', 'horizon', 'targetDate', 'date', 'actualPrice', 'base', 'weak', 'strong', 'noEvents', 'unchanged', 'status', 'targetGapPct', 'absoluteErrorPct', 'noEventsErrorPct', 'unchangedErrorPct', 'envelopeHit', 'actualObservedAt', 'actualSourceFetchedAt'];
  return '\uFEFF' + [columns.join(','), ...rows.map(r => columns.map(k => r[k] ?? '').join(','))].join('\r\n');
}
export async function readEventData(trackingRoot, { archiveRoot = eventRoot } = {}) {
  const forecasts = await readEventForecasts(archiveRoot), folder = join(trackingRoot, 'events', 'comparisons');
  const comparisons = await Promise.all((await listJson(folder)).map(f => readJson(join(folder, f))));
  comparisons.sort((a, b) => a.date.localeCompare(b.date) || a.forecastId.localeCompare(b.forecastId) || a.horizon - b.horizon);
  const research = await readJson(join(archiveRoot, 'research.json')).catch(e => { if (e.code === 'ENOENT') return { periods: [] }; throw e; });
  const library = await readJson(join(archiveRoot, 'library.json')).catch(e => { if (e.code === 'ENOENT') return { cases: [] }; throw e; });
  const replays = [];
  for (const file of (await listJson(join(archiveRoot, 'replays'))).filter(f => f.endsWith('.report.json'))) {
    const saved = await readJson(join(archiveRoot, 'replays', file));
    const input = await readJson(join(archiveRoot, 'replays', file.replace('.report.json', '.input.json')));
    if (JSON.stringify(saved) !== JSON.stringify(buildReplay(input))) throw new Error('历史回放不能由留档输入复算：' + file);
    replays.push(saved);
  }
  replays.sort((a, b) => b.reconstructedAt.localeCompare(a.reconstructedAt));
  return { schema: 1, updateMode: 'agent-triggered-free', forecasts, comparisons, research, library, replays };
}
