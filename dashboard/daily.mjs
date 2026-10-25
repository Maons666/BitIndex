import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDataStore } from './data.mjs';
import { shouldRunScheduled, recordRun, TRACKING_MODE } from './tracking.mjs';
import { createTrackingJob } from './tracking-job.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const directory = process.env.BITINDEX_TRACKING_DIR || join(root, 'predictions'), scheduled = process.argv.includes('--scheduled');
const cacheDirectory = process.env.BITINDEX_CACHE_DIR || join(root, '.cache');
try {
  if (scheduled && !await shouldRunScheduled(directory)) {
    console.log('今日已完成或尚未到纽约时间 09:00。');
  } else {
    const snapshot = await createDataStore(join(cacheDirectory, 'coinmetrics-btc.json')).refresh();
    const result = await createTrackingJob(root, { trackingRoot: directory }).run(snapshot, scheduled ? 'scheduled' : 'cli');
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'success') process.exitCode = 1;
  }
} catch (e) {
  await recordRun(directory, { scope: 'daily', mode: TRACKING_MODE, archived: false, status: 'failed', trigger: scheduled ? 'scheduled' : 'cli', error: e.message }).catch(() => {});
  console.error(e.message); process.exitCode = 1;
}
