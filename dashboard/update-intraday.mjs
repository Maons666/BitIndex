import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectHourly, readIntraday } from './intraday.mjs';
const root = process.env.BITINDEX_TRACKING_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'predictions');
if (!process.argv.includes('--context')) console.log(JSON.stringify(await collectHourly(root)));
const { rows, ...context } = await readIntraday(root);
console.log(JSON.stringify(context, null, 2));
