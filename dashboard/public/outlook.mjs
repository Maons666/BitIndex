import { buildOutlook, outlookOptions, outlookCsv, MODELS } from './outlook-core.mjs';
import { usd, number } from './chart.mjs';

const $ = id => document.getElementById(id), svgNS = 'http://www.w3.org/2000/svg';
let options = outlookOptions(), snapshot = null, result = null, active = -1, chartGeometry = null;
try { options = outlookOptions(JSON.parse(localStorage.getItem('bitindex.outlook.v1') || '{}')); } catch {}
const svg = $('outlook-chart'), tip = $('outlook-tooltip');
const percent = v => (v > 0 ? '+' : '') + number(v, 2) + '%';
const element = (name, attrs = {}, text = null) => {
  const node = document.createElementNS(svgNS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (text !== null) node.textContent = text;
  return node;
};
function save() { try { localStorage.setItem('bitindex.outlook.v1', JSON.stringify(options)); } catch {} }
function render() {
  if (!snapshot) return;
  $('outlook-status').classList.remove('warn');
  $('outlook-content').hidden = true; $('outlook-export').disabled = true;
  try {
    result = buildOutlook(snapshot.rows, options); active = -1;
    const end = result.future.at(-1), model = MODELS.find(m => m.id === options.model);
    const oldDays = Math.floor((Date.now() - Date.parse(result.anchor.date)) / 86400000);
    $('outlook-status').textContent = `基于 ${result.anchor.date} UTC 日收盘 · 估计样本 ${result.sampleStart} — ${result.anchor.date} · 非实时行情` + (oldDays > 2 ? ' · 日线已滞后，请刷新检查' : '');
    $('outlook-status').classList.toggle('warn', oldDays > 2 || snapshot.state === 'stale');
    $('outlook-anchor').textContent = usd(result.anchor.price);
    $('outlook-anchor-date').textContent = result.anchor.date + ' · UTC';
    $('outlook-price-label').textContent = `${options.horizon} 日${options.model === 'gbm' ? '模型均值' : '模型价格'}`;
    $('outlook-price').textContent = usd(end[options.model]);
    $('outlook-change').textContent = percent((end[options.model] / result.anchor.price - 1) * 100) + ' · ' + end.date;
    $('outlook-range-label').textContent = options.model === 'gbm' ? '95% 条件价格区间' : '样本年化波动率';
    $('outlook-range').textContent = options.model === 'gbm' ? usd(end.lower) + ' – ' + usd(end.upper) : number(result.parameters.annualVolatility * 100, 2) + '%';
    $('outlook-range-note').textContent = options.model === 'gbm' ? '参数固定、正态独立收益假设下' : '描述历史波动，不是预测准确率';
    $('outlook-future-legend').textContent = model.name + (options.model === 'gbm' ? '均值' : '价格');
    $('outlook-band-legend').hidden = options.model !== 'gbm' || !options.band;
    $('outlook-band').disabled = options.model !== 'gbm'; $('outlook-band').checked = options.band;
    $('outlook-lookback').value = String(options.lookback);
    document.querySelectorAll('[data-outlook-horizon]').forEach(button => { const on = Number(button.dataset.outlookHorizon) === options.horizon; button.classList.toggle('active', on); button.setAttribute('aria-pressed', String(on)); });
    document.querySelectorAll('[data-outlook-model]').forEach(button => {
      const id = button.dataset.outlookModel, on = id === options.model;
      button.classList.toggle('active', on); button.setAttribute('aria-pressed', String(on));
      button.querySelector('.outlook-model-price').textContent = usd(end[id]);
      button.querySelector('.outlook-model-change').textContent = percent((end[id] / result.anchor.price - 1) * 100);
    });
    $('outlook-content').hidden = false; $('outlook-export').disabled = false;
    draw();
  } catch (error) {
    result = null; tip.hidden = true;
    $('outlook-status').textContent = '价格预期暂不可用：' + error.message;
    $('outlook-status').classList.add('warn');
  }
}
export function updateOutlook(data) { snapshot = data; render(); }
function draw() {
  if (!result || $('outlook-content').hidden) return;
  const width = svg.clientWidth, height = width < 600 ? 290 : 350;
  if (!width) return;
  const left = width < 600 ? 52 : 66, right = 22, top = 34, bottom = 35;
  const past = result.history, future = result.future, boundary = past.length - 1, n = boundary + result.horizon;
  const showBand = options.model === 'gbm' && options.band;
  const values = [...past.map(r => r.price), ...future.flatMap(r => showBand ? [r[options.model], r.lower, r.upper] : [r[options.model]])];
  const min = Math.min(...values), max = Math.max(...values), pad = Math.max((max - min) * .1, max * .025);
  const lo = Math.max(0, min - pad), hi = max + pad;
  const x = i => left + i / n * (width - left - right), y = v => top + (hi - v) / (hi - lo) * (height - top - bottom);
  chartGeometry = { left, right, width, n, boundary, x, y };
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('aria-label', `历史价格实线与${MODELS.find(m => m.id === options.model).name}未来 ${options.horizon} 日虚线；预测起点 ${result.anchor.date}，使用方向键查看价格`);
  svg.dataset.model = options.model; svg.dataset.horizon = String(options.horizon); svg.dataset.anchor = result.anchor.date;
  svg.replaceChildren();
  svg.append(element('rect', { x: x(boundary), y: top, width: x(n) - x(boundary), height: height - top - bottom, class: 'outlook-future-background' }));
  for (let i = 0; i <= 4; i++) {
    const value = lo + (hi - lo) * i / 4, yy = y(value);
    svg.append(element('line', { x1: left, y1: yy, x2: width - right, y2: yy, class: 'outlook-grid' }));
    svg.append(element('text', { x: left - 9, y: yy + 4, 'text-anchor': 'end', class: 'outlook-axis' }, '$' + (value >= 1000 ? number(value / 1000, 1) + 'k' : number(value, 0))));
  }
  const path = (rows, key, offset = 0) => rows.map((r, i) => `${i ? 'L' : 'M'}${x(i + offset).toFixed(2)},${y(r[key]).toFixed(2)}`).join(' ');
  if (showBand) {
    const upper = path(future, 'upper', boundary), lower = future.slice().reverse().map((r, i) => `L${x(n - i).toFixed(2)},${y(r.lower).toFixed(2)}`).join(' ');
    svg.append(element('path', { d: upper + lower + ' Z', class: 'outlook-band-path', 'data-role': 'interval' }));
  }
  svg.append(element('path', { d: path(past, 'price'), class: 'outlook-actual-path', 'data-role': 'actual', 'stroke-dasharray': 'none' }));
  svg.append(element('path', { d: path(future, options.model, boundary), class: 'outlook-forecast-path', 'data-role': 'forecast', 'stroke-dasharray': '7 5' }));
  svg.append(element('line', { x1: x(boundary), y1: top, x2: x(boundary), y2: height - bottom, class: 'outlook-boundary', 'stroke-dasharray': '3 4' }));
  svg.append(element('circle', { cx: x(boundary), cy: y(result.anchor.price), r: 4, class: 'outlook-anchor-dot' }));
  svg.append(element('text', { x: Math.min(width - 74, Math.max(left + 44, x(boundary))), y: 18, 'text-anchor': 'middle', class: 'outlook-axis' }, '预测起点 ' + result.anchor.date.slice(5)));
  for (let i = 0; i <= 4; i++) {
    const index = Math.round(n * i / 4), date = index <= boundary ? past[index].date : future[index - boundary].date;
    svg.append(element('text', { x: x(index), y: height - 9, 'text-anchor': i === 0 ? 'start' : i === 4 ? 'end' : 'middle', class: 'outlook-axis' }, date.slice(5)));
  }
  tip.hidden = active < 0;
  if (active >= 0) {
    const actual = active <= boundary, row = actual ? past[active] : future[active - boundary], value = actual ? row.price : row[options.model];
    svg.append(element('line', { x1: x(active), y1: top, x2: x(active), y2: height - bottom, class: 'outlook-boundary' }));
    svg.append(element('circle', { cx: x(active), cy: y(value), r: 4, class: 'outlook-anchor-dot' }));
    const lines = [[row.date, actual ? '实际收盘' : '模型预期'], ['价格', usd(value)]];
    if (!actual && showBand) lines.push(['95% 条件区间', usd(row.lower) + ' – ' + usd(row.upper)]);
    tip.replaceChildren(...lines.map(([key, text]) => { const line = document.createElement('div'); line.className = 'tip-line'; const label = document.createElement('span'), val = document.createElement('b'); label.textContent = key; val.textContent = text; line.append(label, val); return line; }));
    tip.style.top = '35px'; tip.style.left = Math.max(4, Math.min(width - tip.offsetWidth - 4, x(active) + 12)) + 'px';
    svg.setAttribute('aria-label', `${row.date} ${actual ? '实际收盘' : '模型预期'} ${usd(value)}`);
  }
}
$('outlook-horizons').addEventListener('click', event => { const button = event.target.closest('[data-outlook-horizon]'); if (button) { options.horizon = Number(button.dataset.outlookHorizon); save(); render(); } });
$('outlook-models').addEventListener('click', event => { const button = event.target.closest('[data-outlook-model]'); if (button) { options.model = button.dataset.outlookModel; save(); render(); } });
$('outlook-lookback').addEventListener('change', event => { options.lookback = Number(event.target.value); save(); render(); });
$('outlook-band').addEventListener('change', event => { options.band = event.target.checked; save(); render(); });
$('outlook-methodology').addEventListener('click', () => { $('info-dialog').showModal(); $('outlook-methodology-section').scrollIntoView({ block: 'start' }); });
$('outlook-export').addEventListener('click', () => {
  if (!result) return;
  const url = URL.createObjectURL(new Blob([outlookCsv(result, snapshot)], { type: 'text/csv;charset=utf-8' })), a = document.createElement('a');
  a.href = url; a.download = `BitIndex_outlook_${result.anchor.date}_${result.horizon}d.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
svg.addEventListener('pointermove', event => { if (!result || !chartGeometry) return; const { left, right, width, n } = chartGeometry; active = Math.max(0, Math.min(n, Math.round((event.clientX - svg.getBoundingClientRect().left - left) / (width - left - right) * n))); draw(); });
svg.addEventListener('pointerleave', () => { active = -1; draw(); });
svg.addEventListener('keydown', event => {
  if (!result || !chartGeometry || !['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(event.key)) return;
  event.preventDefault(); const { n, boundary } = chartGeometry;
  active = event.key === 'Escape' ? -1 : event.key === 'Home' ? 0 : event.key === 'End' ? n : active < 0 ? boundary : Math.max(0, Math.min(n, active + (event.key === 'ArrowLeft' ? -1 : 1))); draw();
});
new ResizeObserver(draw).observe(svg);
