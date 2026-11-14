import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildFiveDayReplay,makeDailyFiveDayPacket} from '../five-day-model.mjs';
import {buildEventForecast} from '../event-model.mjs';
import {issueDailyFiveDay,readFiveDayData,readFiveDayPackets,updateFiveDayComparisons} from '../five-day-store.mjs';
import {fiveDayRows,fiveDaySummaries,fiveDayCsv} from '../public/five-day-core.mjs';
const DAY=86400000,now=new Date('2026-11-14T19:00:00Z');
function fixture(){return {id:'five-test',reconstructedAt:now.toISOString(),targetStart:'2026-10-14',targetEnd:'2026-10-16',
 market:{version:1,source:'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics',fetchedAt:'2026-11-13T20:55:00Z',rows:Array.from({length:400},(_,i)=>({date:new Date(Date.parse('2026-11-12')-(399-i)*DAY).toISOString().slice(0,10),price:60000*Math.exp(i*.0005+Math.sin(i)*.02)}))},
 evidence:{author:'test',coverageStart:'2026-09-11',coverageEnd:'2026-11-07',coverageGaps:['test'],events:[{id:'flow',stream:'flows',category:'flows',kind:'fund-outflow',publishedAt:'2026-10-08T00:00:00Z',availableAt:'2026-10-09T12:00:00Z',verifiedAt:'2026-11-14T18:00:00Z',title:'flow',fact:'published',inference:'assumed',rationale:'test',url:'https://example.com/flow',direction:-1,similarity:.5,confidence:.5,novelty:.5}]},
 cases:[{id:'past',title:'old flow',kind:'fund-outflow',publishedAt:'2026-06-01T00:00:00Z'}]};}
function source(m){return buildEventForecast({id:'review',author:'agent',cutoffAt:'2026-11-14T02:00:00Z',summary:'test',coverageGaps:['test'],events:[]},m,{now:new Date('2026-11-14T03:00:00Z')});}
test('每个历史起点冻结5个独立期限，日期精确，原7/30日不被插值',()=>{
 const f=buildFiveDayReplay(fixture()),first=f.issues[0];assert.equal(f.issues.length,3);assert.equal(first.asOf,'2026-10-09T16:00:00.000Z');assert.equal(first.anchor.date,'2026-10-07');
 assert.deepEqual(first.targets.map(t=>t.targetDate),['2026-10-10','2026-10-11','2026-10-12','2026-10-13','2026-10-14']);
 assert.deepEqual(first.events[0].classifications.map(c=>c.horizon),[1,2,3,4,5]);assert.ok(first.targets.every(t=>t.status==='settled'));
 assert.equal(fiveDayRows(f.issues).length,15);assert.equal(fiveDayCsv(f.issues,f).split('\r\n').length,16);
});
test('改变起点之后的行情和未来消息不会改变任何五日预测',()=>{
 const a=fixture(),b=structuredClone(a),before=buildFiveDayReplay(a);
 b.market.rows.filter(r=>r.date>'2026-10-09').forEach(r=>r.price*=10);
 b.evidence.events.push({...b.evidence.events[0],id:'future',publishedAt:'2026-10-20T00:00:00Z',availableAt:'2026-10-20T00:00:00Z',direction:1});
 const after=buildFiveDayReplay(b);before.issues.forEach((f,i)=>assert.deepEqual(after.issues[i].targets.map(t=>t.base),f.targets.map(t=>t.base)));
 assert.notEqual(before.issues[0].targets[0].actualPrice,after.issues[0].targets[0].actualPrice);
 const gap=fixture();gap.market.rows=gap.market.rows.filter(r=>r.date!=='2026-10-12');assert.throws(()=>buildFiveDayReplay(gap),/精确目标日/);
});
test('真实五日签发保留agent原始日期，过期分析或过旧行情暂停新增',()=>{
 const {market,cases}=fixture(),s=source(market),p=makeDailyFiveDayPacket(s,market,cases,{now});
 assert.equal(p.agentSource.analysisCutoffAt,s.analysisCutoffAt);assert.equal(p.issuedAt,now.toISOString());assert.equal(p.forecast.horizons[0].targetDate,'2026-11-15');assert.equal(p.forecast.horizons[4].targetDate,'2026-11-19');
 assert.throws(()=>makeDailyFiveDayPacket({...s,analysisCutoffAt:'2026-11-06T00:00:00Z'},market,cases,{now}),/7天/);
 assert.throws(()=>makeDailyFiveDayPacket(s,{...market,fetchedAt:'2026-11-12T00:00:00Z'},cases,{now}),/24小时/);
});
test('同一天并发或重复签发只保存一份；实际修订不会回写已结算目标',async()=>{
 const root=await mkdtemp(join(tmpdir(),'five-daily-')),archiveRoot=join(root,'empty'),{market,cases}=fixture(),s=source(market);
 await Promise.all([issueDailyFiveDay(root,s,market,cases,{archiveRoot,now}),issueDailyFiveDay(root,s,market,cases,{archiveRoot,now})]);
 const before=JSON.stringify(await readFiveDayPackets(root,{archiveRoot}));
 market.rows.at(-1).price*=2;assert.equal((await issueDailyFiveDay(root,s,market,cases,{archiveRoot,now})).status,'already-issued');assert.equal(JSON.stringify(await readFiveDayPackets(root,{archiveRoot})),before);
 await mkdir(join(root,'actuals'));await writeFile(join(root,'actuals','2026-11-15.json'),JSON.stringify({date:'2026-11-15',price:70000,observedAt:'2026-11-16T14:00:00Z'}));
 await updateFiveDayComparisons(root,{archiveRoot});const data=await readFiveDayData(root,{archiveRoot});assert.equal(data.issues[0].targets[0].actualPrice,70000);assert.equal(data.issues[0].targets[1].actualPrice,null);
 await writeFile(join(root,'actuals','2026-11-15.json'),JSON.stringify({date:'2026-11-15',price:90000}));await updateFiveDayComparisons(root,{archiveRoot});assert.equal((await readFiveDayData(root,{archiveRoot})).issues[0].targets[0].actualPrice,70000);
 const summary=fiveDaySummaries(data.issues);assert.equal(summary[0].count,1);assert.equal(summary[4].count,0);
 const path=join(root,'five-day','forecasts','daily-five-2026-11-14.json'),raw=JSON.parse(await readFile(path,'utf8'));raw.forecast.horizons[0].base=1;await writeFile(path,JSON.stringify(raw));await assert.rejects(readFiveDayPackets(root,{archiveRoot}),/不能复算/);
});
test('同一实际日期的不同起点预测各自保留且按期限分别统计',()=>{
 const issues=[{id:'a',mode:'live',asOf:'2026-11-14T16:00:00Z',targets:[{horizon:2,targetDate:'2026-11-16',base:110,actualPrice:100,noEvents:100,unchanged:100,weak:90,strong:130}]},{id:'b',mode:'live',asOf:'2026-11-15T16:00:00Z',targets:[{horizon:1,targetDate:'2026-11-16',base:120,actualPrice:100,noEvents:100,unchanged:100,weak:90,strong:130}]}];
 const rows=fiveDayRows(issues),s=fiveDaySummaries(issues);assert.equal(rows.length,2);assert.equal(rows[0].targetDate,rows[1].targetDate);assert.ok(Math.abs(s[0].mape-20)<1e-10);assert.ok(Math.abs(s[1].mape-10)<1e-10);
});
test('行情缺日只暂停新五日签发，不补造价格',async()=>{
 const root=await mkdtemp(join(tmpdir(),'five-gap-')),{market,cases}=fixture(),s=source(market);
 market.rows=market.rows.filter(r=>r.date!=='2026-11-01');
 await assert.rejects(issueDailyFiveDay(root,s,market,cases,{archiveRoot:join(root,'empty'),now}),/暂停新增/);
 assert.equal((await readFiveDayPackets(root,{archiveRoot:join(root,'empty')})).length,0);
});
