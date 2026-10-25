import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { readTracking, comparisonReport } from './tracking.mjs';

// The former model:report command now reports saved forecasts only.
if (process.argv.includes('--refresh')) await import('./daily.mjs');
const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'predictions');
const view = await readTracking(root);
await writeFile(join(root, 'latest-comparison.md'), comparisonReport(view));
console.log(JSON.stringify({ report: 'predictions/latest-comparison.md', mode: view.mode, total: view.total, settled: view.settled, pending: view.pending, latestActual: view.latestActual }, null, 2));
