import { readFile,readdir } from 'node:fs/promises';
import { join,resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeOnce } from './tracking.mjs';
import { buildFiveDayReplay, makeDailyFiveDayPacket, verifyDailyFiveDayPacket, agentMaxAgeDays } from './five-day-model.mjs';
export const fiveDayRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../event-predictions/five-day');
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const files=async p=>{try{return (await readdir(p)).filter(f=>f.endsWith('.json')).sort();}catch(e){if(e.code==='ENOENT')return [];throw e;}};
export async function readFiveDayPackets(trackingRoot,{archiveRoot=fiveDayRoot}={}) {
  const all=new Map();
  for(const folder of [join(archiveRoot,'forecasts'),join(trackingRoot,'five-day','forecasts')]) for(const file of await files(folder)) {
    const packet=verifyDailyFiveDayPacket(await json(join(folder,file)));
    if(all.has(packet.id)&&JSON.stringify(all.get(packet.id))!==JSON.stringify(packet))throw new Error('同名五日预测冲突');
    all.set(packet.id,packet);
  }
  return [...all.values()].sort((a,b)=>a.issuedAt.localeCompare(b.issuedAt));
}
export async function issueDailyFiveDay(trackingRoot,sourceForecast,market,cases,{archiveRoot=fiveDayRoot,now=new Date()}={}) {
  const existing=await readFiveDayPackets(trackingRoot,{archiveRoot}), id='daily-five-'+now.toISOString().slice(0,10);
  if(existing.some(p=>p.id===id))return {status:'already-issued',id};
  let packet;
  try { packet=makeDailyFiveDayPacket(sourceForecast,market,cases,{now}); }
  catch(e) { if(/缺日|事前窗口|连续日收盘/.test(e.message)) throw new Error(e.message+'；暂停新增五日预测'); throw e; }
  const saved=await writeOnce(join(trackingRoot,'five-day','forecasts',id+'.json'),JSON.stringify(packet,null,2)+'\n');
  return {status:saved?'issued':'already-issued',id};
}
export async function updateFiveDayComparisons(trackingRoot,{archiveRoot=fiveDayRoot}={}) {
  const packets=await readFiveDayPackets(trackingRoot,{archiveRoot});
  const actuals=new Map();for(const file of await files(join(trackingRoot,'actuals'))){const a=await json(join(trackingRoot,'actuals',file));actuals.set(a.date,a);}
  for(const p of packets) for(const h of p.forecast.horizons) {
    const a=actuals.get(h.targetDate);if(!a||!Number.isFinite(a.price)||a.price<=0)continue;
    const c={forecastId:p.id,horizon:h.horizon,targetDate:h.targetDate,actualPrice:a.price,actualObservedAt:a.observedAt,actualSourceFetchedAt:a.sourceFetchedAt,status:'settled'};
    await writeOnce(join(trackingRoot,'five-day','comparisons',`${p.id}__${h.horizon}.json`),JSON.stringify(c,null,2)+'\n');
  }
}
export async function readFiveDayData(trackingRoot,{archiveRoot=fiveDayRoot}={}) {
  const replays=[];for(const file of (await files(join(archiveRoot,'replays'))).filter(f=>f.endsWith('.input.json'))){
    const input=await json(join(archiveRoot,'replays',file)),saved=await json(join(archiveRoot,'replays',file.replace('.input.json','.report.json')));
    if(JSON.stringify(saved)!==JSON.stringify(buildFiveDayReplay(input)))throw new Error('五日回放不能复算');replays.push(saved);
  }
  replays.sort((a,b)=>b.reconstructedAt.localeCompare(a.reconstructedAt));
  const packets=await readFiveDayPackets(trackingRoot,{archiveRoot}), comparisons=[];
  for(const f of await files(join(trackingRoot,'five-day','comparisons')))comparisons.push(await json(join(trackingRoot,'five-day','comparisons',f)));
  const issues=packets.map(p=>({id:p.id,mode:'live',asOf:p.issuedAt,anchor:p.forecast.anchor,agentSource:p.agentSource,modelVersion:p.forecast.modelVersion,source:p.inputs.source,sourceFetchedAt:p.inputs.fetchedAt,events:p.forecast.events,
    targets:p.forecast.horizons.map(h=>({...h,...(comparisons.find(c=>c.forecastId===p.id&&c.horizon===h.horizon&&c.targetDate===h.targetDate)||{actualPrice:null,status:'pending'})}))}));
  return {schema:1,policy:{daily:true,agentMaxAgeDays,agentRefresh:'manual-free',noBackfill:true},replays,issues};
}
