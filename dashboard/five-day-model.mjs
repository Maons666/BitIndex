import { FIVE_DAYS, FIVE_DAY_MODEL, fingerprint, buildFiveDayForecast, replayFiveDayForecast } from './event-model.mjs';
import { measureCase } from './event-library.mjs';
import { selectReplayEvents } from './replay.mjs';
const DAY = 86400000;
const date = t => new Date(t).toISOString().slice(0,10);
const positive = n => Number.isFinite(n) && n > 0;
export const agentMaxAgeDays = 7;
export function shortLibrary(cases, rows, cutoff) {
  return { cases: cases.filter(c => Date.parse(c.publishedAt) < Date.parse(cutoff)).map(c => measureCase({id:c.id,title:c.title,kind:c.kind,publishedAt:c.publishedAt},rows,FIVE_DAYS)) };
}
export function buildFiveDayReplay(input) {
  const { id, reconstructedAt, targetStart, targetEnd, market, evidence, cases } = input;
  const n=(Date.parse(targetEnd)-Date.parse(targetStart))/DAY+1;
  if (!/^[a-z0-9-]+$/.test(id) || !Number.isInteger(n) || n<1 || n>366 || targetEnd>=reconstructedAt.slice(0,10)) throw new Error('五日回放日期无效');
  const originStart=date(Date.parse(targetStart)-5*DAY), originEnd=date(Date.parse(targetEnd)-5*DAY);
  if (evidence.coverageStart>date(Date.parse(originStart)-28*DAY) || evidence.coverageEnd<originEnd) throw new Error('五日回放事件覆盖不足');
  const prices=new Map(market.rows.map(r=>[r.date,r.price]));
  if(prices.size!==market.rows.length || market.rows.some((r,i)=>r.date>=market.fetchedAt.slice(0,10)||i&&r.date<=market.rows[i-1].date)) throw new Error('行情日期重复、乱序或日线未结束');
  if(new Set(evidence.events.map(e=>e.id)).size!==evidence.events.length) throw new Error('事件 ID 重复');
  const issues=Array.from({length:n},(_,i)=>{
    const originDate=date(Date.parse(originStart)+i*DAY), asOf=originDate+'T16:00:00.000Z', through=date(Date.parse(originDate)-2*DAY);
    const history=market.rows.filter(r=>r.date<=through);
    if(history.at(-1)?.date!==through) throw new Error('回放基准日缺失');
    const analysis={id:'five-replay-'+originDate,cutoffAt:asOf,author:evidence.author,summary:'按当时已公开事实重建的未来1至5日预测',coverageGaps:evidence.coverageGaps,events:selectReplayEvents(evidence.events,asOf)};
    const f=replayFiveDayForecast(analysis,{...market,rows:history,eventLibrary:shortLibrary(cases,history,asOf)},{asOf,reconstructedAt});
    return {id:f.id,mode:'retrospective',asOf,anchor:f.anchor,inputFingerprint:f.inputFingerprint,analysisFingerprint:f.analysisFingerprint,libraryFingerprint:f.libraryFingerprint,
      events:f.events.map(e=>({id:e.id,classifications:e.classifications})),
      targets:f.horizons.map(h=>{const actualPrice=prices.get(h.targetDate);if(!positive(actualPrice))throw new Error('精确目标日缺失：'+h.targetDate);return {...h,actualPrice,actualSourceFetchedAt:market.fetchedAt,status:'settled'};})};
  });
  return {schema:1,id,mode:'retrospective-current-model',modelVersion:FIVE_DAY_MODEL,reconstructedAt,source:market.source,sourceFetchedAt:market.fetchedAt,inputFingerprint:fingerprint(input),targetStart,targetEnd,originStart,originEnd,
    protocol:{horizons:FIVE_DAYS,cutoffTimeUTC:'16:00',priceLagDays:2,parameterTuning:false,caseLevels:'measured-separately-at-each-horizon',repeatedStreams:'latest-available-only',actualVintage:'current-download'},
    limitations:['今天重建的历史信息集，不是当时实际发出的预测，也不是盲测。','当前下载行情可能已被修订；原始可用版本不完整，保守假定日线滞后2天。','案例与模型是事后选定的，agent 判断也可能受事后认识影响；重叠目标不独立。'],evidence,issues};
}
export function makeDailyFiveDayPacket(sourceForecast, market, cases, {now=new Date()}={}) {
  if(!sourceForecast || now-Date.parse(sourceForecast.analysisCutoffAt)>agentMaxAgeDays*DAY || Date.parse(sourceForecast.issuedAt)>now.getTime()) throw new Error('agent 分析超过7天或时间无效，暂停新增五日预测');
  if(now-Date.parse(market.fetchedAt)>DAY) throw new Error('行情获取超过24小时，暂停新增五日预测');
  const issuedAt=now.toISOString(), issueDay=date(now), history=market.rows.filter(r=>r.date<issueDay);
  const analysis={id:'daily-five-'+issueDay,cutoffAt:issuedAt,author:sourceForecast.author,summary:'每日行情更新，沿用最近一次已核查 agent 判断',coverageGaps:sourceForecast.coverageGaps,
    events:sourceForecast.events.filter(e=>Date.parse(e.publishedAt)<=now.getTime()&&now-Date.parse(e.publishedAt)<=28*DAY).map(({ageDays,classifications,...e})=>e)};
  const inputs={version:market.version,source:market.source,fetchedAt:market.fetchedAt,rows:history.filter(r=>positive(r.price)).slice(-61).map(({date,price})=>({date,price})),eventLibrary:shortLibrary(cases,history,issuedAt)};
  const forecast=buildFiveDayForecast(analysis,inputs,{now});
  return {schema:1,id:forecast.id,mode:'live',issuedAt,agentSource:{id:sourceForecast.id,issuedAt:sourceForecast.issuedAt,analysisCutoffAt:sourceForecast.analysisCutoffAt,summary:sourceForecast.summary},updateMode:'daily-market-with-frozen-agent-analysis',analysis,inputs,forecast};
}
export function verifyDailyFiveDayPacket(packet) {
  if(packet.mode!=='live'||packet.id!==packet.forecast.id||packet.issuedAt!==packet.forecast.issuedAt||packet.forecast.modelVersion!==FIVE_DAY_MODEL) throw new Error('五日留档身份无效');
  if(JSON.stringify(buildFiveDayForecast(packet.analysis,packet.inputs,{now:new Date(packet.issuedAt)}))!==JSON.stringify(packet.forecast)) throw new Error('五日留档不能复算');
  if(Date.parse(packet.agentSource.analysisCutoffAt)>Date.parse(packet.issuedAt)||Date.parse(packet.issuedAt)-Date.parse(packet.agentSource.analysisCutoffAt)>agentMaxAgeDays*DAY) throw new Error('五日留档分析已过期');
  return packet;
}
