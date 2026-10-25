import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export async function checkForecastLock(directory) {
  const locked = JSON.parse(await readFile(join(directory, 'forecast-lock.json'), 'utf8'));
  const files = (await readdir(join(directory, 'forecasts'), { recursive: true, withFileTypes: true })).filter(f => f.isFile());
  if (files.length !== Object.keys(locked).length) throw new Error('预测留档数量变化，已中止发布');
  for (const [relative, hash] of Object.entries(locked)) {
    if (!/^\d{4}-\d{2}-\d{2}\/[a-z0-9._-]+\.json$/i.test(relative)) throw new Error('预测锁定路径无效');
    if (createHash('sha256').update(await readFile(join(directory, 'forecasts', relative))).digest('hex') !== hash) throw new Error('原预测被改动，已中止发布：' + relative);
  }
  return files.length;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.env.BITINDEX_TRACKING_DIR || resolve(dirname(fileURLToPath(import.meta.url)), '../predictions');
  console.log('Unchanged original forecasts: ' + await checkForecastLock(directory));
}
