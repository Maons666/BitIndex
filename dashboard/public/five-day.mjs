import { readMarket,readFiveDay } from './data-client.mjs';
import { usd,number } from './chart.mjs';
import { fiveDayRows,fiveDaySummaries,fiveDayCsv } from './five-day-core.mjs';
const $=id=>document.getElementById(id), DAY=86400000;
let data=null,issues=[],page=0,busy=false;
const historic=()=>$('five-mode').value==='replay';
const replay=()=>data?.replays?.[0];
const pct=n=>Number.isFinite(n)?(n>0?'+':'')+number(n,2)+'%':'—';
const time=s=>new Date(s).toLocaleString('zh-CN',{timeZone:'America/New_York',hour12:false});
function el(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;}
function save(value,name,type){const url=URL.createObjectURL(new Blob([value],{type})),a=el('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
try{document.documentElement.dataset.theme=localStorage.getItem('bitindex.real.theme')==='dark'?'dark':'light';}catch{}
$('theme').addEventListener('click',()=>{const theme=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=theme;try{localStorage.setItem('bitindex.real.theme',theme);}catch{}});
$('open-info').addEventListener('click',()=>$('info-dialog').showModal());for(const id of ['close-info','close-info-bottom'])$(id).addEventListener('click',()=>$('info-dialog').close());
function unavailable(){const today=new Date().toISOString().slice(0,10);return t=>t.targetDate>today?'未到期':'待公布';}
function evidence(issue){
  $('five-evidence-title').textContent=issue.asOf.slice(0,10)+' · agent 判断与来源';const box=$('five-evidence-body');box.replaceChildren();
  box.append(el('p','muted',`${historic()?'模拟截止':'真实签发'} ${issue.asOf} · 行情基准 ${issue.anchor.date} / ${usd(issue.anchor.price)}`));
  if(issue.agentSource)box.append(el('p','muted',`沿用分析 ${issue.agentSource.id} · 原证据截止 ${issue.agentSource.analysisCutoffAt}；当日只更新行情和衰减权重。`));
  for(const item of issue.events){const e=historic()?replay().evidence.events.find(e=>e.id===item.id):item;if(!e)continue;const p=el('p');p.append(el('strong','',e.title),el('br'),document.createTextNode(e.fact),el('br'),el('span','muted','判断：'+e.inference+' '));const a=el('a','','来源 ↗');if(/^https:\/\//.test(e.url))a.href=e.url;a.target='_blank';a.rel='noreferrer';p.append(a,el('br'),el('small','muted',`公开 ${e.publishedAt} · 实际核查 ${e.verifiedAt}`));const levels=item.classifications||[];p.append(el('br'),el('small','muted','第1～5天等级：'+levels.map(c=>c.label||'待积累').join(' / ')));box.append(p);}
  if(!issue.events.length)box.append(el('p','muted','该截止点没有可用的已核查事件，事件调整为零。'));
}
function render(){
  const r=replay();issues=[...(historic()?r?.issues||[]:data.issues)].sort((a,b)=>b.asOf.localeCompare(a.asOf));
  const size=Number($('five-limit').value),pages=Math.max(1,Math.ceil(issues.length/size));page=Math.min(page,pages-1);
  $('five-content').hidden=!issues.length;$('five-csv').disabled=!issues.length;$('five-json').disabled=!issues.length;
  $('five-description').textContent=historic()?r?`事后回放 · ${issues.length} 个预测起点（${r.originStart} — ${r.originEnd}）· 第5天目标 ${r.targetStart} — ${r.targetEnd} · 重建 ${time(r.reconstructedAt)}（纽约）`:'尚未发布历史回放。':`真实每日留档 · ${issues.length} 期 · 每期同时冻结未来1～5天价格，精确目标日到齐后填入实际值。`;
  const age=issues[0]?.agentSource? (Date.now()-Date.parse(issues[0].agentSource.analysisCutoffAt))/DAY:null;
  $('five-policy').textContent=historic()?'此表不是过去真实发出的预测；历史与真实成绩分开统计。':age>7?'最近 agent 分析已超过7天，暂停新增预测；触发分析更新后恢复。':issues.length?`最近沿用的 agent 分析：${time(issues[0].agentSource.analysisCutoffAt)}（纽约）。每天更新行情，分析过期则暂停新增。`:'等待首次真实签发。';
  const summaries=fiveDaySummaries(issues);$('five-summary').replaceChildren(...summaries.map(s=>{const d=el('div');d.append(el('span','muted',`第 ${s.horizon} 天 · MAPE`),el('strong','',s.count?number(s.mape,2)+'%':'待到期'),el('small','muted',`${s.count}/${s.total} 已配对`),el('small','muted',s.count?`不加事件 ${number(s.noEventsMape,2)}% / 不变价 ${number(s.unchangedMape,2)}%`:'同日基线到期后计算'));return d;}));
  const visible=issues.slice(page*size,(page+1)*size),wait=unavailable();
  $('five-body').replaceChildren(...visible.map(issue=>{const tr=el('tr');tr.dataset.issue=issue.id;const origin=el('th');origin.scope='row';const button=el('button','text-button',issue.asOf.slice(0,10));button.addEventListener('click',()=>{evidence(issue);$('five-evidence').open=true;$('five-evidence').scrollIntoView({behavior:'smooth',block:'start'});});origin.append(button,el('small','muted',issue.asOf.slice(11,16)+' UTC'),el('small','muted',historic()?'历史重建':'真实签发'));tr.append(origin);
    for(const t of fiveDayRows([issue])){const td=el('td','five-cell');td.dataset.horizon=t.horizon;td.dataset.target=t.targetDate;td.dataset.prediction=t.base;if(t.actualPrice!==null)td.dataset.actual=t.actualPrice;td.append(el('span','five-target',t.targetDate),el('strong','',`预测 ${usd(t.base)}`),el('span','',`实际 ${t.actualPrice===null?wait(t):usd(t.actualPrice)}`),el('span',Number.isFinite(t.signedErrorPct)?(t.signedErrorPct>=0?'five-over':'five-under'):'muted','偏差 '+pct(t.signedErrorPct)));tr.append(td);}return tr;}));
  $('five-flat-body').replaceChildren(...fiveDayRows(visible).map(t=>{const tr=el('tr');[t.asOf.slice(0,10),`第${t.horizon}天`,t.targetDate,usd(t.base),t.actualPrice===null?wait(t):usd(t.actualPrice),usd(t.dollarError),pct(t.signedErrorPct),usd(t.noEvents),usd(t.unchanged)].forEach(x=>tr.append(el('td','',x)));return tr;}));
  $('five-page').textContent=`${page+1} / ${pages} 页 · 共 ${issues.length} 个起点`;$('five-prev').disabled=page===0;$('five-next').disabled=page===pages-1;
  if(visible[0])evidence(visible[0]);
}
async function load(force=false){if(busy)return;busy=true;$('refresh').disabled=true;$('refresh-label').textContent='读取中';
  try{const market=await readMarket(force);const last=market.rows.findLast(r=>r.price>0);$('btc-price').textContent=usd(last?.price);$('price-date').textContent=last?.date||'—';$('checked-time').textContent=time(market.fetchedAt);$('five-status').textContent=`行情截至 ${last?.date}（UTC）· 每个起点对应未来五个收盘日`;
    data=null;$('five-content').hidden=true;for(const id of ['five-csv','five-json','five-mode'])$(id).disabled=true;$('five-description').textContent='正在读取对应版本的五日对照…';$('five-policy').textContent='';
    data=await readFiveDay(market);$('five-mode').disabled=false;render();$('notice').hidden=true;
  }catch(e){$('notice').textContent='读取失败：'+e.message+'。未取得新版本时不会重新计算预测。';$('notice').hidden=false;if(!data)$('five-description').textContent='五日对照暂不可用，请稍后刷新。';}
  finally{busy=false;$('refresh').disabled=false;$('refresh-label').textContent='刷新数据';}}
$('refresh').addEventListener('click',()=>load(true));for(const id of ['five-mode','five-limit'])$(id).addEventListener('change',()=>{page=0;if(data)render();});
$('five-prev').addEventListener('click',()=>{page--;render();});$('five-next').addEventListener('click',()=>{page++;render();});
$('five-csv').addEventListener('click',()=>save(fiveDayCsv(issues,historic()?replay():{}),'BitIndex_5day_'+(historic()?'replay':'live')+'.csv','text/csv;charset=utf-8'));
$('five-json').addEventListener('click',()=>save(JSON.stringify(historic()?replay():{mode:'live',policy:data.policy,issues},null,2),'BitIndex_5day_'+(historic()?'replay':'live')+'.json','application/json'));
load();
