import { readMarket, readEvents, isStatic } from './data-client.mjs';
import { usd, number } from './chart.mjs';
import { updateOutlook } from './outlook.mjs';
import { loadForecast } from './forecast.mjs';
import { updateEvaluation } from './evaluation.mjs';
const $ = id => document.getElementById(id), DAY = 86400000;
const state = { snapshot: null, events: null, horizon: 7, id: null, busy: false };
const pct = v => Number.isFinite(v) ? (v > 0 ? '+' : '') + number(v, 2) + '%' : '—';
const time = v => new Date(v).toLocaleString('zh-CN', { timeZone: 'America/New_York', hour12: false }) + '（纽约）';
function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
function link(url, title) { const a = el('a', '', title + ' ↗'); a.href = /^https:\/\//.test(url) ? url : '#'; a.target = '_blank'; a.rel = 'noreferrer'; return a; }
const chosen = () => state.events?.forecasts.find(f => f.id === state.id);
function theme() { const dark = document.documentElement.dataset.theme === 'dark'; $('theme').setAttribute('aria-label', dark ? '切换浅色主题' : '切换深色主题'); }
try { document.documentElement.dataset.theme = localStorage.getItem('bitindex.real.theme') === 'dark' ? 'dark' : 'light'; } catch {}
theme();
$('theme').addEventListener('click', () => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; try { localStorage.setItem('bitindex.real.theme', document.documentElement.dataset.theme); } catch {} theme(); });
for (const id of ['open-info', 'open-info-footer']) $(id).addEventListener('click', () => $('info-dialog').showModal());
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
$('info-dialog').addEventListener('click', e => { const d = e.currentTarget, r = d.getBoundingClientRect(); if (e.target === d && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) d.close(); });

function market(data) {
  const rows = data.rows.filter(r => r.price > 0), last = rows.at(-1), prev = rows.at(-2);
  $('btc-price').textContent = usd(last?.price); $('price-date').textContent = last?.date || '—';
  $('btc-change').textContent = pct(prev ? (last.price / prev.price - 1) * 100 : null) + ' · 较前一日';
  $('btc-change').classList.toggle('negative', last?.price < prev?.price);
  $('checked-time').textContent = time(data.fetchedAt);
  const old = !last || Date.now() - Date.parse(last.date) > 3 * DAY;
  $('status-text').textContent = `行情截至 ${last?.date || '—'}（UTC） · 分析单独签发`;
  $('status-dot').classList.toggle('warn', old || data.state === 'stale');
  const notices = [old ? '行情已超过 3 天，请以实际日期为准。' : '', data.error, data.trackingWarning].filter(Boolean);
  $('notice').textContent = notices.join(' '); $('notice').hidden = !notices.length;
}
function render() {
  const f = chosen();
  $('event-content').hidden = !f; $('event-export').disabled = !f;
  if (!f) { $('event-status').textContent = '尚未发布事件分析。需要在对话中触发 agent 核查后发布。'; return; }
  const h = f.horizons.find(h => h.horizon === state.horizon), age = Math.floor((Date.now() - Date.parse(f.issuedAt)) / DAY);
  const expired = new Date().toISOString().slice(0, 10) > h.targetDate;
  $('event-status').textContent = `${expired ? '本期目标已过期 · 保留原始预测等待或查看结算' : age > 7 ? '分析超过 7 天 · 请触发 agent 复核' : '已发布 agent 分析 · 页面刷新不重算预测'} · 目标 ${h.targetDate}（UTC）`;
  $('event-status').classList.toggle('warn', expired || age > 7);
  $('event-issued').textContent = '签发 ' + time(f.issuedAt) + ' · 证据截止 ' + time(f.analysisCutoffAt);
  $('event-summary').textContent = f.summary;
  $('event-anchor').textContent = '原价格基准 ' + f.anchor.date + ' · ' + usd(f.anchor.price);
  const scenarios = [['weak', '偏弱', '压力持续'], ['base', '基准', '当前证据'], ['strong', '偏强', '压力缓和']];
  $('event-scenarios').replaceChildren(...scenarios.map(([key, name, label]) => {
    const card = el('article', 'scenario-card ' + key); card.append(el('span', 'scenario-label', name + ' · ' + label), el('strong', '', usd(h[key])), el('span', 'muted', pct((h[key] / f.anchor.price - 1) * 100) + ' · 相对原基准'), el('p', '', f.conditions?.[key] || '按该方向的波动情景观察')); return card;
  }));
  $('event-decomposition').replaceChildren(...[
    ['纯价格基准', usd(h.noEvents), '近 7 / 28 日趋势 · 60 日波动窗口'],
    ['事件调整', pct(h.eventAdjustmentPct), '方向、影响把握与时间衰减 · 未校准'],
    ['情景范围', usd(h.weak) + ' — ' + usd(h.strong), '没有分配概率 · 不是置信区间']
  ].map(([title, value, note]) => { const d = el('div'); d.append(el('span', 'muted', title), el('strong', '', value), el('small', 'muted', note)); return d; }));
  $('event-evidence').replaceChildren(...f.events.map(e => {
    const classification = e.classifications.find(c => c.horizon === state.horizon);
    const article = el('article', 'evidence-item');
    const header = el('div', 'evidence-heading'); header.append(el('h3', '', e.title), el('span', 'badge', classification.label + ' · ' + classification.count + ' 例'));
    article.append(header, el('p', '', '事实：' + e.fact), el('p', 'muted', '判断：' + e.inference));
    const detail = el('details'), summary = el('summary', '', '量化假设与来源');
    const p = el('p', '', `方向 ${e.direction} / 相似度 ${e.similarity} / 影响把握 ${e.confidence} / 未消化比例 ${e.novelty} / 衰减后贡献 ${number(classification.contribution, 4)}。${e.rationale}`);
    detail.append(summary, p, el('p', 'muted', `公开时间 ${e.publishedAt} · 核查 ${time(e.verifiedAt)}${e.publicationTimeNote ? ' · ' + e.publicationTimeNote : ''}`), link(e.url, e.sourceName || '查看来源'));
    for (const s of e.additionalSources || []) detail.append(document.createTextNode(' · '), link(s.url, s.title));
    for (const m of classification.matches) detail.append(el('p', 'muted', `参考案例：${m.title} · ${state.horizon} 天 ${pct(m.returnPct)} · L${m.level} · 标准化偏离 ${number(m.standardizedMove, 2)}。`));
    article.append(detail); return article;
  }));
  if (!f.events.length) $('event-evidence').append(el('p', 'muted', '暂无可核实事件；事件调整为零，不代表市场没有外部风险。'));
  $('event-gaps').replaceChildren(...f.coverageGaps.map(s => el('li', '', s)));
  document.querySelectorAll('[data-event-horizon]').forEach(b => { const on = Number(b.dataset.eventHorizon) === state.horizon; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); });
  draw();
}
const svgNode = (tag, attrs = {}, text) => { const n = document.createElementNS('http://www.w3.org/2000/svg', tag); Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v)); if (text !== undefined) n.textContent = text; return n; };
function draw() {
  const f = chosen(); if (!f || !state.snapshot) return;
  const h = f.horizons.find(h => h.horizon === state.horizon), svg = $('event-chart');
  const rows = state.snapshot.rows.filter(r => Date.parse(r.date) >= Date.parse(f.anchor.date) - 90 * DAY);
  const prices = rows.filter(r => r.price > 0); if (!prices.length) return;
  const width = Math.max(svg.clientWidth, 300), height = width < 520 ? 300 : 360, left = width < 520 ? 58 : 76, right = 20, top = 28, bottom = 40;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`); svg.dataset.forecastId = f.id; svg.dataset.targetDate = h.targetDate; svg.dataset.actualThrough = prices.at(-1).date;
  const start = Date.parse(rows[0].date), end = Math.max(Date.parse(h.targetDate), Date.parse(prices.at(-1).date));
  const values = [...prices.map(r => r.price), h.weak, h.strong, f.anchor.price], low = Math.min(...values) * .97, high = Math.max(...values) * 1.03;
  const x = d => left + (Date.parse(d) - start) / (end - start || DAY) * (width - left - right), y = p => top + (high - p) / (high - low || 1) * (height - top - bottom);
  svg.replaceChildren(svgNode('title', { id: 'event-chart-title' }, '实际价格与事件情景目标'), svgNode('desc', { id: 'event-chart-desc' }, `实线为真实日收盘；${f.anchor.date} 起点连接 ${h.targetDate} 三个目标，虚线中间不代表逐日预测。`));
  for (let i = 0; i <= 4; i++) { const p = low + (high - low) * i / 4; svg.append(svgNode('line', { x1: left, x2: width - right, y1: y(p), y2: y(p), class: 'outlook-grid' }), svgNode('text', { x: left - 8, y: y(p) + 4, 'text-anchor': 'end', class: 'outlook-axis' }, '$' + Math.round(p / 1000) + 'k')); }
  const labels = [rows[0].date, ...(x(h.targetDate) - x(f.anchor.date) > 80 ? [f.anchor.date] : []), h.targetDate];
  labels.forEach((d, i) => svg.append(svgNode('text', { x: x(d), y: height - 12, 'text-anchor': i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle', class: 'outlook-axis' }, d.slice(5))));
  svg.append(svgNode('line', { x1: x(f.anchor.date), x2: x(f.anchor.date), y1: top, y2: height - bottom, class: 'outlook-boundary', 'stroke-dasharray': '3 5' }));
  let path = '', previous = null;
  for (const r of rows) { if (!(r.price > 0)) { previous = null; continue; } path += `${previous && Date.parse(r.date) - Date.parse(previous) === DAY ? 'L' : 'M'}${x(r.date).toFixed(2)},${y(r.price).toFixed(2)} `; previous = r.date; }
  svg.append(svgNode('path', { d: path.trim(), class: 'outlook-actual-path', 'stroke-dasharray': 'none', 'data-role': 'actual' }));
  for (const key of ['weak', 'strong', 'base']) {
    svg.append(svgNode('path', { d: `M${x(f.anchor.date)},${y(f.anchor.price)} L${x(h.targetDate)},${y(h[key])}`, class: 'scenario-path ' + key, 'stroke-dasharray': '7 5', 'data-scenario': key, 'data-price': h[key] }));
    const point = svgNode('circle', { cx: x(h.targetDate), cy: y(h[key]), r: 4, class: 'scenario-point ' + key, tabindex: '0', 'data-scenario-target': key, 'aria-label': `${h.targetDate} ${key} ${usd(h[key])}` }); point.append(svgNode('title', {}, `${h.targetDate} · ${key} ${usd(h[key])} · 签发 ${f.issuedAt}`)); svg.append(point);
  }
}
function comparisons() {
  const data = state.events;
  const settled = data.comparisons.filter(c => c.status === 'settled');
  $('event-comparison-status').textContent = `${data.forecasts.length} 份事件分析 · ${settled.length} 个到期目标 · ${settled.length ? '分别与不加事件及不变价基准比较' : '尚无到期结果，暂不能评价准确率'}。完整逐日记录可导出。`;
  $('event-comparison-body').replaceChildren(...data.forecasts.flatMap(f => f.horizons.map(h => {
    const c = data.comparisons.filter(c => c.forecastId === f.id && c.horizon === h.horizon).at(-1), done = c?.status === 'settled';
    const tr = el('tr');
    [f.issuedAt.slice(0, 10) + ' / ' + h.horizon + ' 天', h.targetDate, usd(h.base), c ? c.date + ' / ' + usd(c.actualPrice) : '等待签发后的日线', done ? number(c.absoluteErrorPct, 2) + '%' : '—', done ? number(c.noEventsErrorPct, 2) + '% / ' + number(c.unchangedErrorPct, 2) + '%' : '到期后计算', done ? (c.envelopeHit ? '已结算 · 范围内' : '已结算 · 范围外') : '待精确目标日'].forEach(v => tr.append(el('td', '', v))); return tr;
  })));
  $('event-comparison-export').href = state.snapshot.eventCsvUrl || '/api/events.csv';
}
function research() {
  const r = state.events.research;
  $('event-research').replaceChildren(...(r.periods || []).map(p => {
    const card = el('article', 'research-card'); card.append(el('p', 'eyebrow', p.start + ' → ' + p.end), el('h3', '', p.title), el('strong', 'research-return', pct(p.returnPct)), el('p', 'muted', usd(p.startPrice) + ' → ' + usd(p.endPrice) + ' · UTC 日收盘'), el('p', '', p.conclusion));
    const details = el('details'), summary = el('summary', '', '查看事件证据与限制'); details.append(summary);
    for (const e of p.events) { const item = el('p', '', `${e.date} · ${e.fact} `); item.append(link(e.url, e.sourceName)); details.append(item); }
    details.append(el('p', 'muted', p.limitation), el('p', 'muted', '复核 ' + r.reviewedAt + ' · 行情取自看板 Coin Metrics 存档')); card.append(details); return card;
  }));
  $('library-body').replaceChildren(...state.events.library.cases.map(c => {
    const tr = el('tr'), out = h => c.outcomes.find(o => o.horizon === h), summary = o => o.status === 'observed' ? pct(o.returnPct) + ' / L' + o.level : '待观察';
    const kind = { 'monetary-tightening':'货币政策趋紧', 'geopolitical-easing':'地缘风险缓和', 'fund-outflow':'资金持续流出', 'liquidity-support':'流动性支持', 'security-breach':'安全事件', 'regulation-easing':'监管预期改善' }[c.kind] || '其他事件';
    [c.title + ' / ' + kind, c.cofactors, summary(out(7)), summary(out(30))].forEach(t => tr.append(el('td', '', t))); return tr;
  }));
  const candidates = state.events.candidates || [];
  $('library-queue-title').textContent = `2026 年显著波动线索 ${candidates.length} 次 · ${candidates.filter(c=>c.status==='needs-research').length} 次待归因核查`;
  $('library-queue').replaceChildren(...candidates.map(c => el('li', '', `${c.date} · ${pct(c.returnPct)} · 事前波动 ${number(c.z, 2)} 倍 · ${c.status === 'needs-research' ? '待核查主导事件' : '邻近已记录案例，仍需确认归因'}`)));
}
async function load(force = false) {
  if (state.busy) return; state.busy = true; $('refresh').disabled = true; $('refresh-label').textContent = '刷新中';
  try {
    const data = await readMarket(force); state.snapshot = data; market(data); updateOutlook(data);
    void loadForecast(data);
    state.events = null; updateEvaluation(null); $('event-content').hidden = true; $('event-export').disabled = true; $('event-status').textContent = '正在读取对应版本的分析…';
    $('event-comparison-body').replaceChildren(); $('event-research').replaceChildren(); $('library-body').replaceChildren(); $('library-queue').replaceChildren(); $('event-comparison-status').textContent = '正在读取…'; $('event-comparison-export').removeAttribute('href');
    try {
      state.events = await readEvents(data);
      if (!state.events.forecasts.some(f => f.id === state.id)) state.id = state.events.forecasts[0]?.id;
      $('event-issue').replaceChildren(...state.events.forecasts.map(f => { const n = el('option', '', time(f.issuedAt)); n.value = f.id; n.selected = f.id === state.id; return n; }));
      render(); comparisons(); research(); updateEvaluation(state.events);
    } catch (e) { $('event-status').textContent = '事件分析暂不可用：' + e.message; $('event-status').classList.add('warn'); $('event-comparison-status').textContent = '未取得同一发布版本的对照记录'; }
  } catch (e) { $('notice').textContent = '刷新失败：' + e.message + '。已显示内容保留原时间。'; $('notice').hidden = false; $('status-text').textContent = '连接失败 · 保留上次数据和签发时间'; $('status-dot').classList.add('warn'); }
  finally { state.busy = false; $('refresh').disabled = false; $('refresh-label').textContent = '刷新数据'; }
}
$('refresh').addEventListener('click', () => load(true));
$('forecast-refresh').addEventListener('click', () => load(true));
$('event-issue').addEventListener('change', e => { state.id = e.target.value; render(); });
$('event-horizons').addEventListener('click', e => { const b = e.target.closest('[data-event-horizon]'); if (b) { state.horizon = Number(b.dataset.eventHorizon); render(); } });
$('event-export').addEventListener('click', () => { const f = chosen(); if (!f) return; const a = el('a'), url = URL.createObjectURL(new Blob([JSON.stringify(f, null, 2)], { type: 'application/json' })); a.href = url; a.download = f.id + '.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
$('library-export').addEventListener('click', e => { e.preventDefault(); if (!state.events) return; const a = el('a'), url = URL.createObjectURL(new Blob([JSON.stringify({ ...state.events.library, candidates: state.events.candidates }, null, 2)], { type: 'application/json' })); a.href = url; a.download = 'BitIndex_event_library.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
new ResizeObserver(draw).observe($('event-chart'));
load();
