import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eventRoot,readEventForecasts } from './event-store.mjs';
import { issueDailyFiveDay,updateFiveDayComparisons } from './five-day-store.mjs';
const root=process.env.BITINDEX_TRACKING_DIR||join(eventRoot,'..','predictions');
if(process.argv.includes('--issue')) {
  const market=JSON.parse(await readFile(join(process.env.BITINDEX_CACHE_DIR||join(eventRoot,'..','.cache'),'coinmetrics-btc.json'),'utf8'));
  const cases=JSON.parse(await readFile(join(eventRoot,'cases.json'),'utf8'));
  const source=(await readEventForecasts())[0];
  try { console.log(JSON.stringify(await issueDailyFiveDay(root,source,market,cases))); }
  catch(e) { if(/暂停新增/.test(e.message))console.log(JSON.stringify({status:'paused',reason:e.message}));else throw e; }
}
await updateFiveDayComparisons(root);
console.log('Five-day exact-date comparisons updated.');
