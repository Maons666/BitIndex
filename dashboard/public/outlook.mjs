import { buildOutlook, outlookOptions, outlookCsv, MODELS, ARCHIVE_MODELS, latestArchivedForecast, buildArchivedOutlook, archivedOutlookCsv } from './outlook-core.mjs';
import { usd, number } from './chart.mjs';

const $ = id => document.getElementById(id), svgNS = 'http://www.w3.org/2000/svg';
let options = outlookOptions(), snapshot = null, result = null, active = -1, chartGeometry = null;
let archives = null, archiveError = null;
try { options = outlookOptions(JSON.parse(localStorage.getItem('bitindex.outlook.v2') || '{}')); } catch {}
const svg = $('outlook-chart'), tip = $('outlook-tooltip');
const percent = v => (v > 0 ? '+' : '') + number(v, 2) + '%';
const element = (name, attrs = {}, text = null) => {
  const node = document.createElementNS(svgNS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (text !== null) node.textContent = text;
  return node;
};
function save() { try { localStorage.setItem('bitindex.outlook.v2', JSON.stringify(options)); } catch {} }
function render() {
  if (!snapshot) return;
  const archived = ARCHIVE_MODELS.some(m => m.id === options.model);
  const model = [...ARCHIVE_MODELS, ...MODELS].find(m => m.id === options.model);
  let financial = null, financialError = null;
  try { financial = buildOutlook(snapshot.rows, options); } catch (error) { financialError = error; }
  $('outlook-lookback').disabled = archived;
  $('outlook-lookback').value = String(options.lookback);
  $('outlook-band').disabled = options.model !== 'gbm'; $('outlook-band').checked = options.band;
  document.querySelectorAll('[data-outlook-horizon]').forEach(button => {
    const on = Number(button.dataset.outlookHorizon) === (archived ? 30 : options.horizon);
    button.disabled = archived; button.classList.toggle('active', on); button.setAttribute('aria-pressed', String(on));
  });
  document.querySelectorAll('[data-outlook-model]').forEach(button => {
    const id = button.dataset.outlookModel, on = id === options.model, saved = ARCHIVE_MODELS.some(m => m.id === id);
    const f = saved ? latestArchivedForecast(archives?.forecasts, id) : null;
    const price = saved ? f?.prediction.predictedPrice : financial?.future.at(-1)[id];
    const base = saved ? f?.prediction.price : financial?.anchor.price;
    button.classList.toggle('active', on); button.setAttribute('aria-pressed', String(on));
    button.querySelector('.outlook-model-price').textContent = usd(price);
    button.querySelector('.outlook-model-change').textContent = price && base ? percent((price / base - 1) * 100) : '';
    if (saved) button.querySelector('.outlook-model-formula').textContent = f ? '目标日 ' + f.prediction.targetDate + ' · UTC' : archiveError ? '留档加载失败，可刷新重试' : archives ? '暂无留档' : '正在读取留档…';
  });
  $('outlook-status').classList.remove('warn');
  $('outlook-content').hidden = true; $('outlook-export').disabled = true;
  tip.hidden = true;
  try {
    if (archived) {
      if (archiveError) throw new Error(archiveError);
      if (!archives) { result = null; $('outlook-status').textContent = '正在读取我的模型预测留档…'; return; }
      result = buildArchivedOutlook(snapshot.rows, latestArchivedForecast(archives.forecasts, options.model), options.model);
    } else {
      if (financialError) throw financialError;
      result = financial;
    }
    active = -1;
    const end = result.future.at(-1), latest = archived ? result.latest : result.anchor;
    const oldDays = Math.floor((Date.now() - Date.parse(latest.date)) / 86400000);
    $('outlook-status').textContent = archived
      ? `留档于 ${new Date(result.forecast.issuedAt).toLocaleString('zh-CN', { timeZone: 'America/New_York', hour12: false })}（纽约） · 原始 30 日预测 · 实际日线截至 ${latest.date} UTC`
      : `基于 ${result.anchor.date} UTC 日收盘 · 估计样本 ${result.sampleStart} — ${result.anchor.date} · 非实时行情`;
    if (oldDays > 2) $('outlook-status').textContent += ' · 日线已滞后，请刷新检查';
    $('outlook-status').classList.toggle('warn', oldDays > 2 || snapshot.state === 'stale');
    $('outlook-anchor-label').textContent = archived ? '原预测基准价 · 留档值' : '基准价格 · 实际收盘';
    $('outlook-anchor').textContent = usd(result.anchor.price);
    $('outlook-anchor-date').textContent = result.anchor.date + ' · UTC';
    $('outlook-price-label').textContent = archived ? '我的模型 · 30 日目标价' : `${options.horizon} 日${options.model === 'gbm' ? '模型均值' : '模型价格'}`;
    $('outlook-price').textContent = usd(end[options.model]);
    $('outlook-change').textContent = percent((end[options.model] / result.anchor.price - 1) * 100) + ' · ' + end.date;
    $('outlook-range-label').textContent = archived ? '留档经验区间 · 目标覆盖 80%' : options.model === 'gbm' ? '95% 条件价格区间' : '样本年化波动率';
    $('outlook-range').textContent = archived ? usd(result.forecast.prediction.lower) + ' – ' + usd(result.forecast.prediction.upper) : options.model === 'gbm' ? usd(end.lower) + ' – ' + usd(end.upper) : number(result.parameters.annualVolatility * 100, 2) + '%';
    $('outlook-range-note').textContent = archived ? '原预测时的残差区间，非保证命中率' : options.model === 'gbm' ? '参数固定、正态独立收益假设下' : '描述历史波动，不是预测准确率';
    $('outlook-future-legend').textContent = model.name + (archived ? '起点—目标连线（非逐日预测）' : options.model === 'gbm' ? '均值' : '价格');
    $('outlook-band-legend').hidden = options.model !== 'gbm' || !options.band;
    $('outlook-content').hidden = false; $('outlook-export').disabled = false;
    draw();
  } catch (error) {
    result = null; tip.hidden = true;
    $('outlook-status').textContent = '价格预期暂不可用：' + error.message;
    $('outlook-status').classList.add('warn');
  }
}
export function updateOutlook(data) { snapshot = data; archives = null; archiveError = null; render(); }
export function updateOutlookArchives(data, source, error = null) {
  if (source !== snapshot) return;
  archives = data; archiveError = error; render();
}
function draw() {
  if (!result || $('outlook-content').hidden) return;
  const width = svg.clientWidth, height = width < 600 ? 290 : 350;
  if (!width) return;
  const left = width < 600 ? 52 : 66, right = 22, top = 34, bottom = 35;
  const past = result.history, future = result.future, start = Date.parse(past[0].date), day = 86400000;
  const indexOf = date => (Date.parse(date) - start) / day;
  const boundary = indexOf(result.anchor.date), actualEnd = indexOf(past.at(-1).date);
  const n = Math.max(actualEnd, indexOf(future.at(-1).date)), archived = result.kind === 'archive';
  const showBand = options.model === 'gbm' && options.band;
  const values = [...past.map(r => r.price), ...future.flatMap(r => showBand ? [r[options.model], r.lower, r.upper] : [r[options.model]])];
  const min = Math.min(...values), max = Math.max(...values), pad = Math.max((max - min) * .1, max * .025);
  const lo = Math.max(0, min - pad), hi = max + pad;
  const x = i => left + i / n * (width - left - right), y = v => top + (hi - v) / (hi - lo) * (height - top - bottom);
  chartGeometry = { left, right, width, n, boundary, x, y };
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('aria-label', `历史价格实线与${[...ARCHIVE_MODELS, ...MODELS].find(m => m.id === options.model).name}${archived ? '原始目标价连线，非逐日预测' : '未来 ' + result.horizon + ' 日虚线'}；预测起点 ${result.anchor.date}，使用方向键查看价格`);
  svg.dataset.model = options.model; svg.dataset.horizon = String(result.horizon); svg.dataset.anchor = result.anchor.date;
  svg.dataset.target = future.at(-1).date; svg.dataset.actualThrough = past.at(-1).date;
  svg.replaceChildren();
  svg.append(element('rect', { x: x(actualEnd), y: top, width: x(n) - x(actualEnd), height: height - top - bottom, class: 'outlook-future-background' }));
  for (let i = 0; i <= 4; i++) {
    const value = lo + (hi - lo) * i / 4, yy = y(value);
    svg.append(element('line', { x1: left, y1: yy, x2: width - right, y2: yy, class: 'outlook-grid' }));
    svg.append(element('text', { x: left - 9, y: yy + 4, 'text-anchor': 'end', class: 'outlook-axis' }, '$' + (value >= 1000 ? number(value / 1000, 1) + 'k' : number(value, 0))));
  }
  const path = (rows, key) => rows.map((r, i) => `${i && Date.parse(r.date) - Date.parse(rows[i - 1].date) === day ? 'L' : 'M'}${x(indexOf(r.date)).toFixed(2)},${y(r[key]).toFixed(2)}`).join(' ');
  const futurePath = (rows, key) => rows.map((r, i) => `${i ? 'L' : 'M'}${x(indexOf(r.date)).toFixed(2)},${y(r[key]).toFixed(2)}`).join(' ');
  if (showBand) {
    const upper = futurePath(future, 'upper'), lower = future.slice().reverse().map(r => `L${x(indexOf(r.date)).toFixed(2)},${y(r.lower).toFixed(2)}`).join(' ');
    svg.append(element('path', { d: upper + lower + ' Z', class: 'outlook-band-path', 'data-role': 'interval' }));
  }
  svg.append(element('path', { d: path(past, 'price'), class: 'outlook-actual-path', 'data-role': 'actual', 'stroke-dasharray': 'none' }));
  svg.append(element('path', { d: futurePath(future, options.model), class: 'outlook-forecast-path', 'data-role': 'forecast', 'stroke-dasharray': '7 5' }));
  if (archived) {
    const end = future.at(-1), xx = x(indexOf(end.date)), yy = y(end[options.model]);
    svg.append(element('circle', { cx: xx, cy: yy, r: 5, class: 'outlook-anchor-dot', 'data-role': 'archived-target' }));
    svg.append(element('text', { x: xx - 8, y: yy - 12, 'text-anchor': 'end', class: 'outlook-axis' }, '目标 ' + end.date.slice(5) + ' · ' + usd(end[options.model])));
  }
  svg.append(element('line', { x1: x(boundary), y1: top, x2: x(boundary), y2: height - bottom, class: 'outlook-boundary', 'stroke-dasharray': '3 4' }));
  svg.append(element('circle', { cx: x(boundary), cy: y(result.anchor.price), r: 4, class: 'outlook-anchor-dot' }));
  svg.append(element('text', { x: Math.min(width - 74, Math.max(left + 44, x(boundary))), y: 18, 'text-anchor': 'middle', class: 'outlook-axis' }, '预测起点 ' + result.anchor.date.slice(5)));
  for (let i = 0; i <= 4; i++) {
    const index = Math.round(n * i / 4), date = new Date(start + index * day).toISOString().slice(0, 10);
    svg.append(element('text', { x: x(index), y: height - 9, 'text-anchor': i === 0 ? 'start' : i === 4 ? 'end' : 'middle', class: 'outlook-axis' }, date.slice(5)));
  }
  tip.hidden = active < 0;
  if (active >= 0) {
    const date = new Date(start + active * day).toISOString().slice(0, 10);
    const actual = past.find(r => r.date === date), projected = future.find(r => r.date === date);
    svg.append(element('line', { x1: x(active), y1: top, x2: x(active), y2: height - bottom, class: 'outlook-boundary' }));
    const lines = [[date, actual ? '实际收盘' : projected ? archived ? '留档目标价' : '模型预期' : '无逐日预测']];
    if (actual) { lines.push(['实际价格', usd(actual.price)]); svg.append(element('circle', { cx: x(active), cy: y(actual.price), r: 4, class: 'outlook-anchor-dot' })); }
    if (projected) {
      lines.push([archived ? active === boundary ? '原预测基准' : '留档目标价' : '模型预期', usd(projected[options.model])]);
      svg.append(element('circle', { cx: x(active), cy: y(projected[options.model]), r: 4, class: 'outlook-anchor-dot' }));
    } else if (archived && active > boundary && active < indexOf(future.at(-1).date)) lines.push(['模型输出', '仅预测目标日，无逐日价格']);
    if (!actual && projected && showBand) lines.push(['95% 条件区间', usd(projected.lower) + ' – ' + usd(projected.upper)]);
    tip.replaceChildren(...lines.map(([key, text]) => { const line = document.createElement('div'); line.className = 'tip-line'; const label = document.createElement('span'), val = document.createElement('b'); label.textContent = key; val.textContent = text; line.append(label, val); return line; }));
    tip.style.top = '35px'; tip.style.left = Math.max(4, Math.min(width - tip.offsetWidth - 4, x(active) + 12)) + 'px';
    svg.setAttribute('aria-label', lines.map(row => row.join(' ')).join('；'));
  }
}
$('outlook-horizons').addEventListener('click', event => { const button = event.target.closest('[data-outlook-horizon]'); if (button && !button.disabled) { options.horizon = Number(button.dataset.outlookHorizon); save(); render(); } });
$('outlook-models').addEventListener('click', event => { const button = event.target.closest('[data-outlook-model]'); if (button) { options.model = button.dataset.outlookModel; save(); render(); } });
$('outlook-lookback').addEventListener('change', event => { options.lookback = Number(event.target.value); save(); render(); });
$('outlook-band').addEventListener('change', event => { options.band = event.target.checked; save(); render(); });
$('outlook-methodology').addEventListener('click', () => { $('info-dialog').showModal(); $('outlook-methodology-section').scrollIntoView({ block: 'start' }); });
$('outlook-export').addEventListener('click', () => {
  if (!result) return;
  const archived = result.kind === 'archive';
  const url = URL.createObjectURL(new Blob([(archived ? archivedOutlookCsv : outlookCsv)(result, snapshot)], { type: 'text/csv;charset=utf-8' })), a = document.createElement('a');
  a.href = url; a.download = archived ? `BitIndex_archive_${result.forecast.id}.csv` : `BitIndex_outlook_${result.anchor.date}_${result.horizon}d.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
svg.addEventListener('pointermove', event => { if (!result || !chartGeometry) return; const { left, right, width, n } = chartGeometry; active = Math.max(0, Math.min(n, Math.round((event.clientX - svg.getBoundingClientRect().left - left) / (width - left - right) * n))); draw(); });
svg.addEventListener('pointerleave', () => { active = -1; draw(); });
svg.addEventListener('keydown', event => {
  if (!result || !chartGeometry || !['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(event.key)) return;
  event.preventDefault(); const { n, boundary } = chartGeometry;
  active = event.key === 'Escape' ? -1 : event.key === 'Home' ? 0 : event.key === 'End' ? n : active < 0 ? boundary : Math.max(0, Math.min(n, active + (event.key === 'ArrowLeft' ? -1 : 1))); draw();
});
new ResizeObserver(draw).observe(svg);
