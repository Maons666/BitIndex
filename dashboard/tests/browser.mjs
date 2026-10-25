import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, mkdtemp, readdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.env.BITINDEX_TEST_URL || 'http://127.0.0.1:8787';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = join(root, '.cache', 'qa-selector');
await mkdir(join(output, 'downloads'), { recursive: true });
const downloadDir = await mkdtemp(join(output, 'downloads', 'run-'));
const profile = await mkdtemp(join(output, 'chrome-profile-'));
const executable = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
assert.equal((await fetch(base + '/api/health')).status, 200, '先运行 npm start');
const proc = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore', windowsHide: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [], errors = [], requests = [];
let ws, sid, counter = 0;
const pending = new Map();
async function wait(fn, label, timeout = 45000) { const start = Date.now(); while (Date.now() - start < timeout) { const r = await fn(); if (r) return r; await sleep(100); } throw new Error('等待超时：' + label); }
function send(method, params = {}, sessionId = sid) {
  return new Promise((resolvePromise, reject) => {
    const id = ++counter, timeout = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 20000);
    pending.set(id, { resolvePromise, reject, timeout }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function click(selector) { return evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); }
async function ready() { await wait(() => evaluate(`document.querySelectorAll('[data-metric]').length === 12 && !document.querySelector('#refresh').disabled && document.querySelector('#btc-price').textContent !== '—'`), '真实数据'); }
async function trackingReady() { await wait(() => evaluate(`document.querySelectorAll('#tracking-body tr').length > 0 && !document.querySelector('#forecast-refresh').disabled`), '历史预测对照'); }
async function shot(name, target = null) {
  await wait(() => evaluate(`document.querySelector('#toast').hidden`), '提示收起', 5000);
  if (target) await evaluate(`document.documentElement.style.scrollBehavior='auto';document.querySelector(${JSON.stringify(target)}).scrollIntoView({behavior:'instant',block:'start'})`);
  await sleep(200);
  const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(join(output, name + '.png'), Buffer.from(image.data, 'base64'));
}
function check(name, ok) { assert.ok(ok, name); results.push(name); console.log('PASS ' + name); }
try {
  const portText = await wait(async () => { try { return await readFile(join(profile, 'DevToolsActivePort'), 'utf8'); } catch { return null; } }, 'Chrome 启动', 15000);
  const [port, endpoint] = portText.trim().split(/\r?\n/); ws = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
  await new Promise((r, reject) => { ws.onopen = r; ws.onerror = reject; });
  ws.onmessage = event => {
    const m = JSON.parse(event.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); clearTimeout(p.timeout); pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolvePromise(m.result); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Network.requestWillBeSent') requests.push({ url: m.params.request.url, method: m.params.request.method });
  };
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir }, null);
  const target = await send('Target.createTarget', { url: 'about:blank' }, null);
  const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, null); sid = attached.sessionId;
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: base }); await ready();
  check('12 项指标从真实接口加载', await evaluate(`document.querySelectorAll('.selector-value').length === 12 && Array.from(document.querySelectorAll('.selector-value')).every(x=>x.textContent !== '—')`));
  check('页面没有损坏的中文文案', await evaluate(`!document.body.innerText.includes('???') && !document.body.innerText.includes('\u0024{state')`));
  const initial = await (await fetch(base + '/api/data')).json(); check('全历史及来源标识', initial.rows.length > 5000 && initial.source.includes('community-api.coinmetrics.io'));
  check('初始页面没有脚本异常', errors.length === 0); await shot('desktop');
  await trackingReady();
  check('原模型、候选模型和预测导出接口已关闭', (await Promise.all(['/api/model', '/api/macro', '/api/model.csv'].map(p => fetch(base + p)))).every(r => r.status === 410));
  const tracking = await (await fetch(base + '/api/tracking')).json();
  check('仅对照模式保留两版历史预测且没有提前结算', tracking.mode === 'comparison-only' && tracking.newForecastsEnabled === false && tracking.total >= 2 && tracking.forecasts.some(f => f.modelVersion === 'ridge-30d-macro-v1') && tracking.forecasts.filter(f => f.prediction.targetDate > initial.rows.at(-1).date).every(f => f.comparison?.absoluteErrorPct === null));
  const immutable = tracking.forecasts.map(f => [f.id, f.issuedAt, f.prediction.predictedPrice]);
  check('界面显示停用状态、实际日期与期间价差', await evaluate(`document.querySelector('#forecast-title').textContent.includes('已停止新增预测') && document.querySelector('#forecast-status').textContent.includes(${JSON.stringify(tracking.latestActual.date)}) && document.querySelector('#tracking-body tr').children.length === 8 && document.querySelector('#forecast-refresh').textContent.includes('更新实际数据')`));
  await shot('tracking', '#forecast-section');
  await click('#tracking-export');
  const trackingFile = await wait(async () => (await readdir(downloadDir)).find(f => f === 'BitIndex_daily_comparison.csv'), '每日对照 CSV');
  const trackingCsv = await readFile(join(downloadDir, trackingFile), 'utf8');
  check('每日对照导出含模型版本、实际日期和到期误差', trackingCsv.includes('actualObservedAt') && trackingCsv.includes('absoluteErrorPct') && trackingCsv.includes('ridge-30d-macro-v1'));
  await evaluate(`window.scrollTo(0,0)`);

  check('默认五项同图', await evaluate(`document.querySelector('#chart').dataset.series.split(',').length === 5 && document.querySelectorAll('#chart-legend button').length === 5`));
  await click('[data-metric="rsi"]'); await click('[data-metric="nupl"]');
  check('追加选择不替换原曲线', await evaluate(`document.querySelector('#chart').dataset.series.split(',').length === 7`));
  await evaluate(`document.querySelector('#metric-search').value='rsi';document.querySelector('#metric-search').dispatchEvent(new Event('input'))`);
  check('搜索不改变选择', await evaluate(`document.querySelectorAll('[data-metric]').length === 1 && document.querySelector('#chart').dataset.series.split(',').length === 7`));
  await evaluate(`document.querySelector('#metric-search').value='';document.querySelector('#metric-search').dispatchEvent(new Event('input'))`);
  await click('#select-all'); check('12 项同时叠图', await evaluate(`document.querySelectorAll('#chart-legend button').length === 12`)); await shot('all-indicators');
  await click('#select-none'); check('空选择提示且禁止导出', await evaluate(`!document.querySelector('#chart-empty').hidden && document.querySelector('#export').disabled`));
  await send('Page.reload'); await ready(); check('空选择持久保存', await evaluate(`document.querySelectorAll('[data-metric]:checked').length === 0`));
  await click('[data-metric="pi"]');
  await evaluate(`document.querySelector('#compare-mode').value='raw';document.querySelector('#compare-mode').dispatchEvent(new Event('change'))`);
  await shot('pi-cycle');
  await click('[data-range="all"]');
  check('全历史范围', (await evaluate(`document.querySelector('#range-label').textContent`)).startsWith('2010-07-18'));
  await click('#log-scale'); await click('#show-price');
  check('Pi 图保留两条均线', await evaluate(`document.querySelectorAll('#chart-legend > span').length === 2`));
  await click('#view-toggle'); check('表格分页', await evaluate(`!document.querySelector('#history-wrap').hidden && document.querySelectorAll('#history-body tr').length === 30`));
  const firstDate = await evaluate(`document.querySelector('#history-body tr td').textContent`); await click('#next-page');
  check('下一页日期发生变化', firstDate !== await evaluate(`document.querySelector('#history-body tr td').textContent`));
  await click('#view-toggle'); await click('#show-price'); await click('#log-scale'); await click('[data-range="365"]');
  await send('Runtime.evaluate', { expression: `document.querySelector('#chart').focus()` });
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
  check('键盘查看图表日期和数值', await evaluate(`!document.querySelector('#chart-tooltip').hidden && document.querySelector('#chart-tooltip').textContent.includes('111 日均线')`));

  await click('#select-none'); await click('[data-metric="mining"]'); const miningBefore = await evaluate(`parseFloat(document.querySelector('.selector-item:has([data-metric="mining"]) .selector-value').textContent)`);
  await click('#model-settings'); await evaluate(`document.querySelector('[name="electricity"]').value='0.075';document.querySelector('#settings-form').requestSubmit()`);
  const miningAfter = await evaluate(`parseFloat(document.querySelector('.selector-item:has([data-metric="mining"]) .selector-value').textContent)`);
  check('电价上升 50% 时币价成本比降至 2/3', Math.abs(miningAfter / miningBefore - 2 / 3) < .002);
  await send('Page.reload'); await ready();
  check('参数在刷新后保留', await evaluate(`JSON.parse(localStorage.getItem('bitindex.real.settings.v1')).electricity === .075`));
  await click('#model-settings'); await click('#reset-settings'); await evaluate(`document.querySelector('#settings-form').requestSubmit()`);
  await click('#export');
  const csvFile = await wait(async () => (await readdir(downloadDir)).find(f => f.endsWith('.csv') && !f.includes('daily_comparison')), 'CSV 下载');
  const csv = await readFile(join(downloadDir, csvFile), 'utf8');
  check('CSV 仅导出勾选指标及分位', csv.includes('date,price,mining,p_mining,cost') && csv.includes('Coin Metrics Community') && !csv.split('\n')[0].includes('ahr999'));

  const before = await (await fetch(base + '/api/data')).json(); await click('#refresh'); await ready();
  const after = await (await fetch(base + '/api/data')).json();
  check('刷新按钮重新请求服务器及官方数据', requests.some(r => r.url.endsWith('/api/refresh') && r.method === 'POST') && after.fetchedAt > before.fetchedAt);
  const preservedPrice = await evaluate(`document.querySelector('#btc-price').textContent`);
  await send('Network.setBlockedURLs', { urls: ['*/api/refresh'] }); await click('#refresh'); await ready();
  check('网络失败显示提示并保留原数值', await evaluate(`!document.querySelector('#notice').hidden && document.querySelector('#status-text').textContent.includes('连接失败')`) && preservedPrice === await evaluate(`document.querySelector('#btc-price').textContent`));
  await send('Network.setBlockedURLs', { urls: [] }); await click('#refresh'); await ready();
  check('恢复网络后清除失败状态', await evaluate(`!document.querySelector('#status-text').textContent.includes('失败')`));
  await trackingReady();
  const synced = await (await fetch(base + '/api/data')).json();
  const trackedAfter = await (await fetch(base + '/api/tracking')).json();
  check('多次刷新既不新增也不改写原预测', trackedAfter.total === immutable.length && immutable.every(([id, issuedAt, price]) => trackedAfter.forecasts.some(f => f.id === id && f.issuedAt === issuedAt && f.prediction.predictedPrice === price)));
  check('刷新已保存本次真实获取时间并更新对照', trackedAfter.lastRun.mode === 'comparison-only' && trackedAfter.lastRun.archived === false && trackedAfter.lastRun.sourceFetchedAt === synced.fetchedAt && trackedAfter.latestActual.date === synced.rows.at(-1).date);
  const disk = JSON.parse(await readFile(join(root, '.cache/coinmetrics-btc.json'), 'utf8'));
  check('刷新真实数据可持久保存离线缓存', disk.fetchedAt === synced.fetchedAt);
  await send('Network.setBlockedURLs', { urls: ['*/api/tracking'] }); await click('#forecast-refresh'); await ready();
  await wait(() => evaluate(`document.querySelector('#forecast-status').textContent.includes('暂不可用')`), '对照断网提示');
  check('对照读取失败不展示过期关联结果', await evaluate(`document.querySelectorAll('#tracking-body tr').length === 0`));
  await send('Network.setBlockedURLs', { urls: [] }); await click('#forecast-refresh'); await ready(); await trackingReady();
  check('更新实际数据按钮未调用预测接口', requests.every(r => !/\/api\/(model|macro)/.test(new URL(r.url).pathname)));
  await evaluate(`window.scrollTo(0,0)`);
  await click('#open-info'); check('统一说明集中在一个对话框', await evaluate(`document.querySelector('#info-dialog').open && document.querySelectorAll('.method-list article').length === 12`));
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  check('说明支持 Esc 关闭', await evaluate(`!document.querySelector('#info-dialog').open`));
  await click('#select-none'); await click('[data-metric="nupl"]'); await click('[data-metric="momentum"]');
  await evaluate(`document.querySelector('#compare-mode').value='raw';document.querySelector('#compare-mode').dispatchEvent(new Event('change'))`);
  await click('[data-range="all"]');
  check('负数原值禁用对数刻度', await evaluate(`document.querySelector('#log-scale').disabled && !document.querySelector('#log-scale').checked && !document.querySelector('#comparison-note').hidden`));
  await click('#select-default');
  await evaluate(`document.querySelector('#compare-mode').value='percentile';document.querySelector('#compare-mode').dispatchEvent(new Event('change'))`);
  await click('[data-range="365"]'); await click('#theme'); await shot('desktop-dark');
  await send('Emulation.setDeviceMetricsOverride', { width: 400, height: 900, deviceScaleFactor: 1, mobile: false }); await sleep(300); await shot('mobile-dark');
  check('400px 窄屏无页面横向溢出', await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`));
  await click('#theme'); await shot('mobile');
  await evaluate(`document.querySelector('#forecast-section').scrollIntoView()`); await shot('forecast-mobile');
  check('400px 对照表格无页面横向溢出', await evaluate(`document.documentElement.scrollWidth <= window.innerWidth && document.querySelectorAll('#tracking-body tr').length > 0`));
  await evaluate(`window.scrollTo(0,0)`);
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 760, deviceScaleFactor: 1, mobile: false }); await sleep(300); await shot('desktop-1280');
  check('1280px 无横向溢出', await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`));
  check('全程没有未捕获脚本异常', errors.length === 0);
  await writeFile(join(output, 'report.json'), JSON.stringify({ passed: results.length, results, errors, dataThrough: after.rows.at(-1).date, rows: after.rows.length, fetchedAt: after.fetchedAt }, null, 2));
  console.log(`\n${results.length} checks passed. Screenshots: ${output}`);
} finally {
  if (ws?.readyState === WebSocket.OPEN) { try { await send('Browser.close', {}, null); } catch {} ws.close(); }
  proc.kill();
  // Leave the isolated profile with the QA artifacts; no recursive cleanup.
}
