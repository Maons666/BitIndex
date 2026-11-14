import { usd, number } from './chart.mjs';
import { evaluateRow, evaluationSummary, liveEvaluationRows, evaluationCsv } from './evaluation-core.mjs';
const $ = id => document.getElementById(id), DAY = 86400000;
let data = null, rows = [], selected = 0;
const pct = n => Number.isFinite(n) ? (n > 0 ? '+' : '') + number(n, 2) + '%' : '—';
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function svgNode(tag, attrs = {}, text) { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k,v] of Object.entries(attrs)) e.setAttribute(k,v); if (text !== undefined) e.textContent = text; return e; }
const replay = () => data?.replays?.[0];
const isReplay = () => $('evaluation-mode').value === 'replay';
function download(content, name, type) { const a=el('a'), url=URL.createObjectURL(new Blob([content],{type})); a.href=url; a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); }

export function updateEvaluation(value) {
  data = value;
  $('evaluation-content').hidden = !value;
  $('evaluation-export').disabled = !value;
  $('evaluation-json').disabled = !value;
  $('evaluation-mode').disabled = !value;
  if (!value) { rows=[]; $('evaluation-status').textContent='等待同一发布版本的评估数据…'; return; }
  render();
}
function render() {
  const historic = isReplay(), r = replay();
  rows = (historic ? r?.rows || [] : liveEvaluationRows(data)).map(evaluateRow);
  selected = Math.max(0, rows.length - 1);
  const s = evaluationSummary(rows), show = n => Number.isFinite(n) ? number(n,2)+'%' : '待到期';
  $('evaluation-export').disabled = !rows.length;
  $('evaluation-json').disabled = historic ? !r : !data;
  $('evaluation-status').textContent = historic
    ? r ? `事后回放 · ${r.targetStart} — ${r.targetEnd} · ${rows.length} 个目标日 · 重建于 ${r.reconstructedAt.slice(0,10)}（UTC），不计入真实留档成绩。` : '尚未发布历史回放。'
    : `真实留档 · ${s.total} 个 30 天目标，${s.count} 个已到期。实际值只在精确目标日到齐后加入图表。`;
  $('evaluation-metrics').replaceChildren(...[
    ['模型 + agent · MAPE',show(s.mape)], ['不加事件 · MAPE',show(s.noEventsMape)], ['币价不变 · MAPE',show(s.unchangedMape)], ['平均绝对价差',s.count?usd(s.maeUSD):'待到期']
  ].map(([label,value])=>{ const d=el('div'); d.append(el('span','muted',label),el('strong','',value)); return d; }));
  const gain = s.count ? s.noEventsMape - s.mape : null;
  $('evaluation-verdict').textContent = s.count ? `事件调整使平均误差${gain>=0?'减少':'增加'} ${number(Math.abs(gain),3)} 个百分点；平均${s.biasPct>=0?'高估':'低估'} ${number(Math.abs(s.biasPct),2)}%。情景范围内 ${number(s.envelopeHitPct,1)}%（非置信区间）。` : '尚无到期样本；未来目标只显示留档点，不提前计算成绩。';
  $('evaluation-day').replaceChildren(...rows.map((r,i)=>{const o=el('option','',r.targetDate+' ← '+r.asOf.slice(0,10));o.value=i;o.selected=i===selected;return o;}));
  $('evaluation-day').disabled = !rows.length;
  $('evaluation-body').replaceChildren(...rows.map(r=>{
    const tr=el('tr'); [r.targetDate,r.asOf.slice(0,10),usd(r.actualPrice),usd(r.base),usd(r.base-r.actualPrice),pct(r.signedErrorPct),pct(r.noEventsErrorPct),pct(r.unchangedErrorPct)].forEach((t,i)=>tr.append(el('td','',r.actualPrice===null && [2,4,5,6,7].includes(i)?'待到期':t)));return tr;
  }));
  $('evaluation-chart').dataset.mode=historic?'retrospective':'live';
  draw(); details();
}
function details() {
  const r=rows[selected], box=$('evaluation-detail');box.replaceChildren(); if(!r)return;
  const line=el('p','evaluation-readout'); line.append(el('strong','',r.targetDate+' · '), document.createTextNode(`实际 ${usd(r.actualPrice)} / 预测 ${usd(r.base)} / 偏差 ${pct(r.signedErrorPct)}`));
  box.append(line,el('p','muted',`${isReplay()?'模拟截止':'真实签发'} ${r.asOf} · 原价格基准 ${r.anchor.date} / ${usd(r.anchor.price)} · 事件调整 ${pct(r.eventAdjustmentPct)}`));
  const detail=el('details'), summary=el('summary','','当日采用的 agent 事件判断'); detail.append(summary);
  for(const selectedEvent of r.events || []) {
    const e=isReplay()?replay().evidence.events.find(e=>e.id===selectedEvent.id):selectedEvent;
    if(!e) continue;
    const c=isReplay()?selectedEvent:e.classifications.find(c=>c.horizon===30);
    const p=el('p');p.append(el('strong','',e.title+' · '+(c.level?'L'+c.level:'待积累')),el('br'),document.createTextNode(e.fact),el('br'),el('span','muted','判断：'+e.inference+' '));
    const a=el('a','','原始来源 ↗'); if(/^https:\/\//.test(e.url))a.href=e.url;a.target='_blank';a.rel='noreferrer';p.append(a,el('br'),el('small','muted',`方向 ${e.direction} · 相似度 ${e.similarity} · 影响把握 ${e.confidence} · 未消化比例 ${e.novelty} · 衰减后贡献 ${number(c.contribution,4)}`),el('br'),el('small','muted',`公开 ${e.publishedAt} · ${isReplay()?'回放可用 '+e.availableAt+' · ':''}实际核查 ${e.verifiedAt}`));detail.append(p);
  }
  if(!r.events?.length)detail.append(el('p','muted','该截止日的研究包没有可用事件；调整为零不表示没有外部影响。'));
  box.append(detail);
  $('evaluation-day').value=selected;
}
function draw() {
  const svg=$('evaluation-chart'), error=$('evaluation-error-chart');svg.replaceChildren();error.replaceChildren();if(!rows.length)return;
  const width=Math.max(svg.clientWidth,300), height=width<520?280:310, left=width<520?54:70, right=18, top=20, bottom=35;
  const baselines=$('evaluation-baselines').checked;
  const start=Date.parse(rows[0].targetDate),end=Date.parse(rows.at(-1).targetDate),span=end-start||DAY;
  const x=d=>left+(Date.parse(d)-start)/span*(width-left-right);
  const values=rows.flatMap(r=>[r.actualPrice,r.base,...(baselines?[r.noEvents,r.unchanged]:[])]).filter(v=>Number.isFinite(v)&&v>0);
  const low=Math.min(...values)*.97,high=Math.max(...values)*1.03,y=v=>top+(high-v)/(high-low||1)*(height-top-bottom);
  svg.setAttribute('viewBox',`0 0 ${width} ${height}`);svg.setAttribute('height',height);svg.dataset.count=rows.length;
  svg.append(svgNode('title',{},'每日实际价格与提前30天的预测'),svgNode('desc',{},'实线为目标日实际收盘，虚线连接各目标日提前30天的预测。方向键或日期下拉框查看每日明细。'));
  for(let i=0;i<=4;i++){const p=low+(high-low)*i/4;svg.append(svgNode('line',{x1:left,x2:width-right,y1:y(p),y2:y(p),class:'outlook-grid'}),svgNode('text',{x:left-8,y:y(p)+4,'text-anchor':'end',class:'outlook-axis'},'$'+Math.round(p/1000)+'k'));}
  const indices=[0,Math.floor((rows.length-1)/2),rows.length-1].filter((v,i,a)=>a.indexOf(v)===i);
  const labels=(s,h)=>indices.forEach((i,k)=>s.append(svgNode('text',{x:x(rows[i].targetDate),y:h-10,'text-anchor':k===0?'start':k===indices.length-1?'end':'middle',class:'outlook-axis'},rows[i].targetDate.slice(5))));
  labels(svg,height);
  const fields=['actualPrice','base',...(baselines?['noEvents','unchanged']:[])];
  for(const field of fields){
    let d='',previous=null;
    for(const r of rows){const p=r[field];if(!Number.isFinite(p)||p<=0){previous=null;continue;}d+=`${previous&&Date.parse(r.targetDate)-Date.parse(previous)===DAY?'L':'M'}${x(r.targetDate).toFixed(2)},${y(p).toFixed(2)} `;previous=r.targetDate;}
    svg.append(svgNode('path',{d:d.trim(),class:'evaluation-line '+field,'stroke-dasharray':field==='actualPrice'?'none':field==='base'?'7 5':field==='noEvents'?'3 4':'1 5','data-series':field}));
    // Isolated real forecasts remain visible as points; do not connect missing dates.
    rows.forEach((r,i)=>{if(!(r[field]>0))return;const dot=svgNode('circle',{cx:x(r.targetDate),cy:y(r[field]),r:field==='base'?3:2,class:'evaluation-dot '+field,'data-series-point':field,'data-date':r.targetDate,'data-value':r[field]});dot.append(svgNode('title',{},`${r.targetDate} · ${field} ${usd(r[field])}`));dot.addEventListener('click',()=>select(i));svg.append(dot);});
  }
  svg.append(svgNode('line',{x1:x(rows[selected].targetDate),x2:x(rows[selected].targetDate),y1:top,y2:height-bottom,class:'outlook-boundary','stroke-dasharray':'3 5'}));
  const eh=185,et=18,eb=32,max=Math.max(1,...rows.map(r=>Math.abs(r.signedErrorPct||0)))*1.15,ey=v=>et+(max-v)/(2*max)*(eh-et-eb);
  error.setAttribute('viewBox',`0 0 ${width} ${eh}`);error.setAttribute('height',eh);
  error.append(svgNode('title',{},'每日预测相对实际价格的百分比偏差；正值高估，负值低估'));
  for(const v of [-max,0,max])error.append(svgNode('line',{x1:left,x2:width-right,y1:ey(v),y2:ey(v),class:v===0?'evaluation-zero':'outlook-grid'}),svgNode('text',{x:left-8,y:ey(v)+4,'text-anchor':'end',class:'outlook-axis'},(v>0?'+':'')+number(v,1)+'%'));
  const bw=Math.max(3,Math.min(18,(width-left-right)/(rows.length+2)*.65));
  rows.forEach((r,i)=>{if(!Number.isFinite(r.signedErrorPct))return;const bar=svgNode('rect',{x:x(r.targetDate)-bw/2,y:Math.min(ey(0),ey(r.signedErrorPct)),width:bw,height:Math.max(1,Math.abs(ey(r.signedErrorPct)-ey(0))),class:'evaluation-bar '+(r.signedErrorPct>=0?'over':'under'),'data-error':r.signedErrorPct});bar.append(svgNode('title',{},r.targetDate+' · '+pct(r.signedErrorPct)));bar.addEventListener('click',()=>select(i));error.append(bar);});
  if(!rows.some(r=>Number.isFinite(r.signedErrorPct)))error.append(svgNode('text',{x:(width+left-right)/2,y:eh/2,'text-anchor':'middle',class:'outlook-axis'},'尚无到期误差'));
  labels(error,eh);
  $('evaluation-baseline-legend').hidden=!baselines;
}
function select(i){selected=Math.max(0,Math.min(rows.length-1,i));draw();details();}
$('evaluation-mode').addEventListener('change',()=>{if(data)render();});
$('evaluation-baselines').addEventListener('change',draw);
$('evaluation-day').addEventListener('change',e=>select(Number(e.target.value)));
$('evaluation-chart').addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();select(e.key==='Home'?0:e.key==='End'?rows.length-1:selected+(e.key==='ArrowRight'?1:-1));}});
$('evaluation-export').addEventListener('click',()=>download(evaluationCsv(rows,isReplay()?replay():{}),'BitIndex_30day_'+(isReplay()?'replay':'live')+'.csv','text/csv;charset=utf-8'));
$('evaluation-json').addEventListener('click',()=>download(JSON.stringify(isReplay()?replay():{mode:'live',rows},null,2),'BitIndex_30day_'+(isReplay()?'replay':'live')+'.json','application/json'));
new ResizeObserver(draw).observe($('evaluation-chart'));
