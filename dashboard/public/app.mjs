import { DEFAULTS, METRICS, compute, latest, valid, regime, validateSettings, toCsv, DAY, DEFAULT_SELECTION, cleanSelection, withPercentiles } from './core.mjs';
import { HistoryChart, number, usd } from './chart.mjs';
import { readMarket, isStatic } from './data-client.mjs';
// Existing servers may still have the previous static-file allowlist until restarted.
// Keep the indicator dashboard usable during that upgrade.
const { loadForecast } = await import('./forecast.mjs').catch(() => ({
  loadForecast() { document.getElementById('forecast-status').textContent = '对照模块加载失败，请重启本地服务后刷新页面'; }
}));

const $ = id => document.getElementById(id);
const state = { raw: null, rows: [], selected: [...DEFAULT_SELECTION], mode: 'percentile', search: '', group: '全部', range: '365', showPrice: true, log: false, view: 'chart', page: 0, busy: false, settings: { ...DEFAULTS } };
let toastTimer;
function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
function stored(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }
function save(key, value) { try { localStorage.setItem(key, value); return true; } catch { return false; } }
try { state.settings = validateSettings(JSON.parse(stored('bitindex.real.settings.v1', '{}'))); } catch { /* Keep defaults if a previous setting is invalid. */ }
document.documentElement.dataset.theme = stored('bitindex.real.theme', 'light') === 'dark' ? 'dark' : 'light';
function toast(message) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3800); }
function selectedMetrics() { return METRICS.filter(m => state.selected.includes(m.id)); }
function metric() { return selectedMetrics()[0]; }
try { state.selected = cleanSelection(JSON.parse(stored('bitindex.real.selection.v2', 'null'))); } catch {}
function selectedRows() {
  if (state.range === 'all' || !state.rows.length) return state.rows;
  const end = Date.parse(state.rows.at(-1).date), start = end - (Number(state.range) - 1) * DAY;
  return state.rows.filter(r => Date.parse(r.date) >= start);
}
function change(row, id) {
  if (!row) return null;
  const index = state.rows.indexOf(row), before = state.rows[index - 1];
  return before && valid(before[id]) && before[id] !== 0 ? (row[id] / before[id] - 1) * 100 : null;
}
function percent(v) { return valid(v) ? (v > 0 ? '+' : '') + number(v, 2) + '%' : '—'; }
function badge(id, v) { const r = regime(id, v); return el('span', 'badge ' + r.tone, r.label); }
function sparkline(id, color) {
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 70 30'); svg.setAttribute('aria-hidden', 'true'); svg.classList.add('spark');
  const rows = state.rows.slice(-60), values = rows.map(r => r[id]).filter(valid); if (!values.length) return svg;
  const min = Math.min(...values), max = Math.max(...values); let d = '', start = true;
  rows.forEach((r, i) => { if (!valid(r[id])) { start = true; return; } d += `${start ? 'M' : 'L'}${(i / Math.max(1, rows.length - 1) * 68 + 1).toFixed(1)},${(27 - (r[id] - min) / (max - min || 1) * 24).toFixed(1)} `; start = false; });
  const path = document.createElementNS(ns, 'path'); path.setAttribute('d', d); path.setAttribute('fill', 'none'); path.setAttribute('stroke', color); path.setAttribute('stroke-width', '1.6'); path.setAttribute('stroke-linejoin', 'round'); svg.append(path); return svg;
}
function renderCards() {
  $('selection-count').textContent = `已选 ${state.selected.length} / ${METRICS.length}`;
  const list = METRICS.filter(m => (state.group === '全部' || m.group === state.group) && (m.name + m.en).toLowerCase().includes(state.search.toLowerCase()));
  $('metric-cards').replaceChildren(...list.map(m => {
    const row = latest(state.rows, m.id), label = el('label', 'selector-item' + (state.selected.includes(m.id) ? ' selected' : ''));
    const input = el('input'); input.type = 'checkbox'; input.dataset.metric = m.id; input.checked = state.selected.includes(m.id); input.setAttribute('aria-label', m.name);
    const dot = el('i'); dot.style.background = m.color;
    const name = el('span', 'selector-name', m.name); name.append(el('small', '', row?.date ?? '等待数据'));
    const value = el('span', 'selector-value', number(row?.[m.id], m.digits) + (row ? m.unit : ''));
    input.addEventListener('change', () => { selectMetric(m.id, input.checked); document.querySelector(`[data-metric="${m.id}"]`)?.focus({ preventScroll: true }); });
    label.append(input, dot, name, value); return label;
  }));
  if (!list.length) $('metric-cards').append(el('p', 'selector-empty', '没有匹配的指数'));
}
function renderMarket() {
  const price = latest(state.rows, 'price');
  $('btc-price').textContent = usd(price?.price); $('btc-change').textContent = percent(change(price, 'price'));
  $('btc-change').classList.toggle('negative', change(price, 'price') < 0);
  $('price-date').textContent = price?.date ?? '—'; $('coverage').textContent = state.rows.length ? state.rows[0].date + ' — ' + state.rows.at(-1).date : '—';
}
function renderSummary() {
  $('summary-body').replaceChildren(...METRICS.map(m => {
    const row = latest(state.rows, m.id), tr = el('tr'), nameCell = el('td'), button = el('button', 'metric-link'), dot = el('i'); dot.style.background = m.color;
    button.append(dot, document.createTextNode(m.name)); button.addEventListener('click', () => { selectMetric(m.id, true); document.querySelector('.chart-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }); }); nameCell.append(button);
    const val = el('td', '', number(row?.[m.id], m.digits) + (row ? m.unit : ''));
    const diff = change(row, m.id), delta = el('td', diff > 0 ? 'change-up' : diff < 0 ? 'change-down' : 'muted', percent(diff));
    const zone = el('td'); zone.append(badge(m.id, row?.[m.id]));
    const date = el('td', 'date-text', row?.date ?? '数据不足'), source = el('td'); source.append(el('span', 'source-label', m.id === 'mvrv' ? 'Coin Metrics · 原始序列' : m.id === 'mining' ? 'Coin Metrics · 电费模型' : 'Coin Metrics · 复算'));
    tr.append(nameCell, val, delta, zone, date, source); return tr;
  }));
}
const chart = new HistoryChart($('chart'), $('chart-tooltip'), row => renderDetails(row));
function setSelection(ids) {
  state.selected = cleanSelection(ids); state.page = 0;
  save('bitindex.real.selection.v2', JSON.stringify(state.selected)); renderCards(); renderChart();
}
function selectMetric(id, checked = true) { setSelection(checked ? [...state.selected, id] : state.selected.filter(x => x !== id)); }
function renderLegend() {
  $('chart-legend').replaceChildren(...chart.series().map(s => {
    const item = el(s.rawKey ? 'button' : 'span'), line = el('i'); line.style.background = s.color;
    item.append(line, document.createTextNode(s.label + (s.right ? ' · 右轴' : '')));
    if (s.rawKey) { item.title = '取消勾选 ' + s.label; item.addEventListener('click', () => selectMetric(s.rawKey, false)); }
    return item;
  }));
}
function renderChart() {
  const metrics = selectedMetrics(), rows = selectedRows(), m = metric();
  $('chart-title').textContent = metrics.length === 1 ? m.name : metrics.length ? `${metrics.length} 项指数对比` : '选择要对比的指数';
  $('chart-category').textContent = 'BITCOIN / INDEX COMPARISON';
  document.querySelector('.selected-dot').style.background = m?.color ?? '#5366dc';
  $('model-settings').hidden = !state.selected.some(id => ['mining', 'ahr999'].includes(id));
  $('model-settings').textContent = '计算参数 ↗';
  const signed = state.mode === 'raw' && rows.some(r => metrics.some(m => valid(r[m.id]) && r[m.id] <= 0));
  const logDisabled = signed || (!state.showPrice && state.mode === 'percentile') || !metrics.length;
  $('log-scale').disabled = logDisabled;
  if (logDisabled) { state.log = false; $('log-scale').checked = false; }
  $('log-label').textContent = state.mode === 'percentile' ? '价格对数' : '对数刻度';
  $('comparison-note').textContent = signed ? '原值含零或负数，使用线性刻度。不同单位可切换历史分位比较。' : state.mode === 'raw' && metrics.length > 1 ? '原始数值保留各自单位；不同量纲建议使用历史分位。' : '';
  $('comparison-note').hidden = !$('comparison-note').textContent;
  $('chart-caption').textContent = state.mode === 'percentile' ? '历史分位 · 至少 365 个有效观测' : '原始单位 · 日线';
  $('range-label').textContent = rows.length ? rows[0].date + ' — ' + rows.at(-1).date : '暂无数据';
  $('chart-body').hidden = state.view !== 'chart'; $('history-wrap').hidden = state.view !== 'table';
  $('view-toggle').textContent = state.view === 'table' ? '图表视图' : '表格视图'; $('view-toggle').setAttribute('aria-pressed', String(state.view === 'table'));
  $('chart-empty').hidden = rows.some(r => metrics.some(m => valid(r[state.mode === 'percentile' ? 'p_' + m.id : m.id])));
  $('chart-empty').textContent = !metrics.length ? '勾选左侧指数，在同一张图上对比' : state.busy ? '正在获取真实历史数据…' : '当前区间没有完整数据';
  chart.setData(rows, metrics, { showPrice: state.showPrice, log: state.log, mode: state.mode }); renderLegend(); renderDetails();
  $('export').disabled = !rows.length || !metrics.length;
  if (state.view === 'table') renderHistory();
}
function renderDetails(hoverRow) {
  const metrics = selectedMetrics();
  if (metrics.length !== 1) {
    $('detail-strip').replaceChildren(...metrics.map(m => { const row = hoverRow || latest(selectedRows(), m.id); const d = el('div', 'detail-item', m.name); d.append(el('strong', '', number(row?.[m.id], m.digits) + (row ? m.unit : ''))); return d; })); return;
  }
  const id = metrics[0].id, row = hoverRow || latest(selectedRows(), id), empty = !row;
  let items = [['最新值', number(row?.[id], metrics[0].digits) + (row ? metrics[0].unit : '')], ['历史分位', number(row?.['p_' + id], 1)], ['所选日期', row?.date ?? '—']];
  if (id === 'ahr999') items = [['200 日成本', usd(row?.mean200)], ['增长拟合价格', usd(row?.fitted)], ['所选日期', row?.date ?? '—']];
  if (id === 'mining') items = [['每枚 BTC 电费成本', usd(row?.cost)], ['全网算力', valid(row?.hashrate) ? number(row.hashrate / 1e6, 1) + ' EH/s' : '—'], ['所选日期', row?.date ?? '—']];
  if (id === 'pi') items = [['111 日均线', usd(row?.ma111)], ['350 日均线 × 2', usd(row?.ma350x2)], [row?.piCross ? '当日发生上穿' : '相对交叉线距离', valid(row?.pi) ? percent((row.pi - 1) * 100) : '—']];
  if (id === 'mvrv') items = [['MVRV 比率', number(row?.mvrv) + (empty ? '' : ' ×')], ['隐含已实现价格', valid(row?.price) && valid(row?.mvrv) ? usd(row.price / row.mvrv) : '—'], ['所选日期', row?.date ?? '—']];
  if (id === 'puell') items = [['当日发行价值', usd(row?.issuanceUSD)], ['当日发行量', number(row?.issuance, 2) + (valid(row?.issuance) ? ' BTC' : '')], ['所选日期', row?.date ?? '—']];
  $('detail-strip').replaceChildren(...items.map(([label, value]) => { const d = el('div', 'detail-item', label); d.append(el('strong', '', value)); return d; }));
}
function renderHistory() {
  const rows = [...selectedRows()].reverse(), pageSize = 30, pages = Math.max(1, Math.ceil(rows.length / pageSize)); state.page = Math.max(0, Math.min(state.page, pages - 1));
  const m = metric(), cols = [['date', '日期（UTC）'], ...selectedMetrics().map(m => [m.id, m.name + (m.unit === '%' ? '（%）' : '')]), ['price', 'BTC / USD']];
  if (state.selected.length === 1 && m?.id === 'pi') cols.push(['ma111', '111 日均线'], ['ma350x2', '350 日均线 × 2'], ['piCross', '当日上穿']);
  if (state.selected.length === 1 && m?.id === 'mining') cols.push(['cost', '电费成本 / BTC']);
  const head = el('tr'); cols.forEach(([, label]) => head.append(el('th', '', label))); $('history-head').replaceChildren(head);
  $('history-body').replaceChildren(...rows.slice(state.page * pageSize, (state.page + 1) * pageSize).map(r => { const tr = el('tr'); cols.forEach(([key]) => tr.append(el('td', '', key === 'date' ? r.date : key === 'piCross' ? (r.piCross ? '是' : '—') : ['price', 'cost', 'ma111', 'ma350x2'].includes(key) ? usd(r[key]) : number(r[key], 4)))); return tr; }));
  $('page-text').textContent = `${state.page + 1} / ${pages} · ${rows.length.toLocaleString()} 日`;
  $('prev-page').disabled = state.page === 0; $('next-page').disabled = state.page >= pages - 1;
}
function showStatus() {
  const data = state.raw; if (!data) return;
  const row = latest(state.rows, 'price'), available = METRICS.filter(m => latest(state.rows, m.id)).length;
  const daysOld = row ? Math.floor((Date.now() - Date.parse(row.date + 'T00:00:00Z')) / DAY) : Infinity;
  const stale = data.state === 'stale' || daysOld > 2;
  $('status-dot').classList.toggle('warn', stale);
  $('status-text').textContent = `${data.state === 'stale' ? '刷新失败 · 保留上次数据' : data.state === 'cached' ? '本地记录 · 正在核对' : '数据截至 ' + (row?.date ?? '—')} · ${available}/${METRICS.length} 指标可用`;
  $('checked-time').textContent = new Date(data.fetchedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const notices = [];
  if (data.error) notices.push(data.error + '。当前显示 ' + new Date(data.fetchedAt).toLocaleString('zh-CN', { hour12: false }) + ' 成功获取的数据。');
  if (daysOld > 2) notices.push(`数据源最近日线已距今 ${daysOld} 天，请以“数据截至”日期为准。`);
  if (data.persistenceWarning) notices.push(data.persistenceWarning + '。');
  if (data.trackingWarning) notices.push('实际数据对照失败：' + data.trackingWarning);
  if (data.trackingRun && data.trackingRun.status !== 'success') notices.push('实际数据对照未全部完成：' + (data.trackingRun.error || '请查看每日追踪记录'));
  const delayed = METRICS.filter(m => { const r = latest(state.rows, m.id); return !r || row && r.date < row.date; });
  if (delayed.length) notices.push('部分指标数据较晚或不足：' + delayed.map(m => m.name).join('、') + '，具体日期见下表。');
  $('notice').textContent = notices.join(' '); $('notice').hidden = !notices.length;
}
function applyData(data) { state.raw = data; state.rows = withPercentiles(compute(data.rows, state.settings)); renderMarket(); renderCards(); renderSummary(); renderChart(); showStatus(); }
async function requestData(force = false) {
  const data = await readMarket(force);
  if (!Array.isArray(data.rows)) throw new Error('服务返回的数据格式不正确'); return data;
}
async function load(force = false) {
  if (state.busy) return;
  state.busy = true; $('refresh').disabled = true; $('refresh').classList.add('loading'); $('refresh-label').textContent = '刷新中';
  try {
    const beforeDate = latest(state.rows, 'price')?.date;
    let data = await requestData(force); applyData(data);
    if (!force && data.state === 'cached') { data = await requestData(true); applyData(data); }
    void loadForecast(data);
    if (force) toast(isStatic ? '已读取最新发布的数据，后台定时更新真实日线' : data.state === 'stale' ? '刷新失败，已保留上次数据' : beforeDate === latest(state.rows, 'price')?.date ? '已重新核对真实数据，最新日线日期未变' : `${METRICS.length} 项指数已更新`);
  } catch (e) {
    const message = e.name === 'TimeoutError' ? '数据请求超时，请重试' : e.message === 'Failed to fetch' ? (isStatic ? '无法读取已发布数据，请检查网络后重试' : '无法连接本地服务，请检查启动窗口') : e.message;
    $('notice').textContent = message + (state.rows.length ? '。保留上次成功数据。' : '。点击“刷新数据”重试。'); $('notice').hidden = false;
    $('status-text').textContent = state.rows.length ? '连接失败 · 保留上次数据' : '数据暂不可用'; $('status-dot').classList.add('warn');
    $('chart-empty').textContent = '尚未取得数据，请刷新重试';
  } finally {
    state.busy = false; $('refresh').disabled = false; $('refresh').classList.remove('loading'); $('refresh-label').textContent = '刷新数据';
  }
}

$('metric-search').addEventListener('input', e => { state.search = e.target.value; renderCards(); });
$('metric-groups').addEventListener('click', e => { const b = e.target.closest('[data-group]'); if (!b) return; state.group = b.dataset.group; document.querySelectorAll('[data-group]').forEach(n => { n.classList.toggle('active', n === b); n.setAttribute('aria-pressed', String(n === b)); }); renderCards(); });
$('select-all').addEventListener('click', () => setSelection(METRICS.map(m => m.id)));
$('select-none').addEventListener('click', () => setSelection([]));
$('select-default').addEventListener('click', () => setSelection(DEFAULT_SELECTION));
$('compare-mode').addEventListener('change', e => { state.mode = e.target.value; renderChart(); });
$('refresh').addEventListener('click', () => load(true));
$('forecast-refresh').addEventListener('click', () => load(true));
$('ranges').addEventListener('click', e => { const b = e.target.closest('[data-range]'); if (!b) return; state.range = b.dataset.range; state.page = 0; document.querySelectorAll('[data-range]').forEach(n => { n.classList.toggle('active', n === b); n.setAttribute('aria-pressed', String(n === b)); }); renderChart(); });
$('show-price').addEventListener('change', e => { state.showPrice = e.target.checked; renderChart(); });
$('log-scale').addEventListener('change', e => { state.log = e.target.checked; renderChart(); });
$('view-toggle').addEventListener('click', () => { state.view = state.view === 'chart' ? 'table' : 'chart'; renderChart(); });
$('prev-page').addEventListener('click', () => { state.page--; renderHistory(); $('history-wrap').scrollTop = 0; });
$('next-page').addEventListener('click', () => { state.page++; renderHistory(); $('history-wrap').scrollTop = 0; });
$('export').addEventListener('click', () => {
  const rows = selectedRows(), blob = new Blob([toCsv(rows, state.settings, state.selected)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob), a = el('a'); a.href = url; a.download = `BitIndex_${rows[0].date}_${rows.at(-1).date}.csv`; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast(`已导出 ${rows.length} 日、${state.selected.length} 项已选指标`);
});
function updateThemeButton() { const dark = document.documentElement.dataset.theme === 'dark'; $('theme').textContent = dark ? '☼' : '◐'; $('theme').setAttribute('aria-label', dark ? '切换浅色主题' : '切换深色主题'); }
$('theme').addEventListener('click', () => { const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = next; save('bitindex.real.theme', next); updateThemeButton(); chart.draw(); renderLegend(); });
for (const id of ['open-info', 'open-info-footer']) $(id).addEventListener('click', () => $('info-dialog').showModal());
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) { const r = d.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close(); } }));
function fillSettings(s) { for (const [key, value] of Object.entries(s)) $('settings-form').elements[key].value = value; }
function openSettings() { fillSettings(state.settings); $('settings-error').textContent = ''; $('settings-dialog').showModal(); }
$('model-settings').addEventListener('click', openSettings);
$('settings-from-info').addEventListener('click', () => { $('info-dialog').close(); openSettings(); });
$('reset-settings').addEventListener('click', () => fillSettings(DEFAULTS));
$('settings-form').addEventListener('submit', e => {
  e.preventDefault();
  try {
    state.settings = validateSettings(Object.fromEntries(new FormData(e.target))); const persisted = save('bitindex.real.settings.v1', JSON.stringify(state.settings));
    if (state.raw) applyData(state.raw); $('settings-dialog').close(); toast(persisted ? '参数已保存，指数已重新计算' : '指数已重算；浏览器无法保存参数，本次打开有效');
  } catch (err) { $('settings-error').textContent = err.message; }
});
updateThemeButton(); renderCards(); renderSummary(); renderChart(); load();
