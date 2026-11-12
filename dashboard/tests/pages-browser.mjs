import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, mkdtemp, readdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = (process.env.BITINDEX_TEST_URL || 'http://127.0.0.1:8788/BitIndex/').replace(/\/?$/, '/');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = join(root, '.cache', 'qa-pages');
await mkdir(join(output, 'downloads'), { recursive: true });
const downloadDir = await mkdtemp(join(output, 'downloads', 'run-'));
const profile = await mkdtemp(join(output, 'chrome-profile-'));
const executable = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
assert.equal((await fetch(base + 'data/manifest.json')).status, 200, '先运行 npm run build:pages 和 npm run preview:pages');
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
async function ready() { await wait(() => evaluate(`!!document.querySelector('#refresh') && !document.querySelector('#refresh').disabled && document.querySelector('#btc-price').textContent !== '—'`), '真实数据'); }
async function trackingReady() { if (!await evaluate(`!!document.querySelector('#forecast-refresh')`)) return; await evaluate(`document.querySelector('#legacy-section').open=true`); await wait(() => evaluate(`document.querySelectorAll('#tracking-body tr').length > 0 && !document.querySelector('#forecast-refresh').disabled`), '历史预测对照'); }
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
  const manifest = await (await fetch(base + 'data/manifest.json')).json();
  const market = await (await fetch(base + manifest.market)).json();
  const tracking = await (await fetch(base + manifest.tracking)).json();
  await trackingReady();
  check('Pages 子路径加载全部 12 项真实数据', await evaluate(`document.querySelectorAll('.selector-value').length === 12 && Array.from(document.querySelectorAll('.selector-value')).every(x=>x.textContent !== '—')`) && market.rows.length > 5000);
  check('同一发布版本包含原预测和实际对照', market.publicationVersion === tracking.publicationVersion && tracking.newForecastsEnabled === false && tracking.total === 14);
  check('显示真实获取时间和静态刷新说明', await evaluate(`document.querySelector('.publication-note').textContent.includes('刷新读取最新发布数据') && document.querySelector('#checked-time').textContent !== '—'`));
  check('默认五项同图', await evaluate(`document.querySelectorAll('#chart-legend button').length === 5`));
  await click('#select-all'); check('全部 12 项可叠图', await evaluate(`document.querySelectorAll('#chart-legend button').length === 12`));
  await click('#select-none'); check('空选择禁止导出', await evaluate(`document.querySelector('#export').disabled && !document.querySelector('#chart-empty').hidden`));
  await send('Page.reload'); await ready(); await trackingReady();
  check('选择状态刷新后保留', await evaluate(`document.querySelectorAll('[data-metric]:checked').length === 0`));
  await click('[data-metric="pi"]');
  await evaluate(`document.querySelector('#compare-mode').value='raw';document.querySelector('#compare-mode').dispatchEvent(new Event('change'))`);
  await click('[data-range="all"]');
  check('完整历史可以查看', (await evaluate(`document.querySelector('#range-label').textContent`)).startsWith('2010-07-18'));
  await click('#export');
  const indicatorFile = await wait(async () => (await readdir(downloadDir)).find(f=>f.endsWith('.csv')), '指标 CSV');
  check('指标 CSV 包含真实指标值', (await readFile(join(downloadDir, indicatorFile), 'utf8')).includes('pi'));
  check('指数页只展示指数，不加载预测数据', await evaluate(`!document.querySelector('#outlook-section') && !document.querySelector('#event-section') && !!document.querySelector('nav a[href="./prediction.html"]')`) && !requests.some(r=>/\/(tracking|events)\.json/.test(r.url)));
  await click('#select-default'); await click('[data-range="365"]');
  await evaluate(`document.querySelector('#compare-mode').value='percentile';document.querySelector('#compare-mode').dispatchEvent(new Event('change'))`);
  await shot('index-desktop');
  await click('nav a[href="./prediction.html"]'); await ready();
  await wait(()=>evaluate(`!!document.querySelector('#event-section') && !document.querySelector('#event-content').hidden`),'事件分析');
  const events = await (await fetch(base+manifest.events)).json(), issue=events.forecasts[0];
  check('预测页读取签发结果且保留返回入口', await evaluate(`!!document.querySelector('nav a[href="./index.html"]') && document.querySelector('#event-chart').dataset.forecastId===${JSON.stringify(issue.id)} && !document.querySelector('#legacy-section').open`));
  check('实线与三条虚线按原始签发价格绘制', await evaluate(`document.querySelector('#event-chart [data-role="actual"]').getAttribute('stroke-dasharray')==='none' && document.querySelectorAll('#event-chart [data-scenario]').length===3 && Number(document.querySelector('#event-chart [data-scenario="base"]').dataset.price)===${issue.horizons[0].base}`));
  await click('[data-event-horizon="30"]');
  check('30 天情景切换取自已签发目标', await evaluate(`document.querySelector('#event-chart').dataset.targetDate===${JSON.stringify(issue.horizons[1].targetDate)} && Number(document.querySelector('#event-chart [data-scenario="base"]').dataset.price)===${issue.horizons[1].base}`));
  check('事件库、来源和待核查行情可见', await evaluate(`document.querySelectorAll('#library-body tr').length===4 && document.querySelectorAll('#event-evidence article').length===4 && document.querySelectorAll('#event-research article').length===4 && document.querySelectorAll('#library-queue li').length>0 && document.querySelector('#event-evidence').textContent.includes('待积累')`));
  await click('#event-export');
  const eventFile=await wait(async()=> (await readdir(downloadDir)).find(f=>f===issue.id+'.json'),'事件分析导出');
  check('导出保留事件证据与不可重算的原价格', JSON.stringify(JSON.parse(await readFile(join(downloadDir,eventFile),'utf8')))===JSON.stringify(issue));
  await click('#library-export');
  const libraryFile=await wait(async()=> (await readdir(downloadDir)).find(f=>f==='BitIndex_event_library.json'),'事件库导出');
  check('导出的事件库包含分级与未归因线索', JSON.parse(await readFile(join(downloadDir,libraryFile),'utf8')).cases.length===4);
  await click('#event-comparison-export');
  const eventCsvFile=await wait(async()=> (await readdir(downloadDir)).find(f=>f==='BitIndex_event_comparisons.csv'),'新模型对照导出');
  check('新对照导出包含无事件基准和不变价误差', (await readFile(join(downloadDir,eventCsvFile),'utf8')).includes('noEventsErrorPct'));
  await shot('event-desktop','#event-section');
  await send('Network.setBlockedURLs',{urls:['*/data/*/events.json*']});await click('#refresh');await ready();
  check('事件数据失败时隐藏旧分析并提示失败',await evaluate(`document.querySelector('#event-content').hidden && document.querySelector('#event-export').disabled && document.querySelector('#event-status').textContent.includes('暂不可用')`));
  await send('Network.setBlockedURLs',{urls:[]});await click('#refresh');await ready();
  check('刷新只更新行情，不改变原事件预测',await evaluate(`Number(document.querySelector('#event-chart [data-scenario="base"]').dataset.price)===${issue.horizons[1].base}`));
  await trackingReady();
  await click('#tracking-export');
  const csvFile = await wait(async () => (await readdir(downloadDir)).find(f=>f==='BitIndex_daily_comparison.csv'), '对照 CSV');
  check('对照 CSV 可下载', (await readFile(join(downloadDir, csvFile), 'utf8')).includes('actualSourceFetchedAt'));
  const beforeChecks = requests.filter(r=>r.url.includes('data/manifest.json')).length;
  await click('#forecast-refresh'); await ready(); await trackingReady();
  check('刷新按钮重新读取发布清单', requests.filter(r=>r.url.includes('data/manifest.json')).length > beforeChecks);
  check('仅发出静态 GET 请求，没有预测或实时后台请求', requests.every(r=>r.method==='GET' && !new URL(r.url).pathname.includes('/api/')));
  const price = await evaluate(`document.querySelector('#btc-price').textContent`);
  await send('Network.setBlockedURLs', { urls: ['*/data/manifest.json*'] });
  await click('#refresh'); await ready();
  check('断网保留实际值并提示失败', await evaluate(`document.querySelector('#status-text').textContent.includes('失败')`) && price === await evaluate(`document.querySelector('#btc-price').textContent`));
  await send('Network.setBlockedURLs', { urls: [] }); await click('#refresh'); await ready(); await trackingReady();
  check('恢复网络可以继续读取对照', await evaluate(`document.querySelectorAll('#tracking-body tr').length === 14`));
  await click('#open-info');
  check('统一说明解释云端定时更新', await evaluate(`document.querySelector('#info-dialog').textContent.includes('无需保持本机开机')`));
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await wait(() => evaluate(`!document.querySelector('#outlook-content').hidden && document.querySelector('#outlook-chart [data-role="forecast"]') !== null`), '我的模型留档');
  const original = tracking.forecasts.filter(f => f.modelVersion === 'ridge-30d-v1').sort((a,b)=>b.issuedAt.localeCompare(a.issuedAt))[0];
  const macro = tracking.forecasts.filter(f => f.modelVersion === 'ridge-30d-macro-v1').sort((a,b)=>b.issuedAt.localeCompare(a.issuedAt))[0];
  check('默认我的模型价格、基准日与目标日和原留档一致', await evaluate(`document.querySelector('#outlook-chart').dataset.model==='ridge' && document.querySelector('#outlook-chart').dataset.anchor===${JSON.stringify(original.prediction.date)} && document.querySelector('#outlook-chart').dataset.target===${JSON.stringify(original.prediction.targetDate)} && Number(document.querySelector('#outlook-price').textContent.replace(/[^0-9.]/g,''))===${Number(original.prediction.predictedPrice.toFixed(2))}`));
  const originalPoints = tracking.forecasts.filter(f=>f.modelVersion==='ridge-30d-v1').sort((a,b)=>a.prediction.targetDate.localeCompare(b.prediction.targetDate));
  const expectedPoints = originalPoints.map(f=>({date:f.prediction.targetDate,price:f.prediction.predictedPrice,issuedAt:f.issuedAt}));
  const drawnPoints = await evaluate(`Array.from(document.querySelectorAll('#outlook-chart [data-role="forecast-point"]')).map(p=>({date:p.dataset.date,price:Number(p.dataset.price),issuedAt:p.dataset.issuedAt}))`);
  check('默认曲线包含原模型全部 7 期真实目标，日期、价格与签发时间逐点一致', drawnPoints.length===7 && JSON.stringify(drawnPoints)===JSON.stringify(expectedPoints) && await evaluate(`document.querySelector('#outlook-chart').dataset.archiveView==='curve' && document.querySelector('#outlook-anchor').textContent===document.querySelector('#btc-price').textContent`));
  check('预测曲线只连接目标价点，不从当前价格补造预测线段', await evaluate(`(()=>{const p=document.querySelector('#outlook-chart [data-role="forecast"]');const d=document.querySelector('#outlook-chart [data-role="forecast-point"]');return p.getAttribute('d').split(' ').length===7 && p.getAttribute('d').split(' ')[0]==='M'+Number(d.getAttribute('cx')).toFixed(2)+','+Number(d.getAttribute('cy')).toFixed(2)})()`));
  await click('#outlook-export');
  const curveFile = await wait(async () => (await readdir(downloadDir)).find(f=>f.startsWith('BitIndex_archive_curve_')), '历次预测 CSV');
  const curveCsv = await readFile(join(downloadDir, curveFile), 'utf8');
  check('曲线 CSV 导出全部目标且保留各自的原始签发信息', curveCsv.split('\r\n').filter(l=>l.includes('"archived_target"')).length===7 && originalPoints.every(f=>curveCsv.includes(f.issuedAt) && curveCsv.includes(String(f.prediction.predictedPrice))));
  await evaluate(`document.querySelector('#outlook-chart').focus()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
  if (market.rows.filter(r=>r.price>0).at(-1).date < original.prediction.targetDate) {
    check('曲线提示框区分目标日期、签发日期和原始预测期', await evaluate(`document.querySelector('#outlook-tooltip').textContent.includes('签发（纽约）') && document.querySelector('#outlook-tooltip').textContent.includes('原基准日') && document.querySelector('#outlook-tooltip').textContent.includes('30 天')`));
  }
  await shot('my-model-curve', '#outlook-section');
  await click('[data-outlook-model="macro"]');
  const macroPoints = tracking.forecasts.filter(f=>f.modelVersion==='ridge-30d-macro-v1').sort((a,b)=>a.prediction.targetDate.localeCompare(b.prediction.targetDate));
  check('外部因素曲线也使用各自 7 期原始预测', JSON.stringify(await evaluate(`Array.from(document.querySelectorAll('#outlook-chart [data-role="forecast-point"]')).map(p=>Number(p.dataset.price))`)) === JSON.stringify(macroPoints.map(f=>f.prediction.predictedPrice)));
  await click('[data-archive-view="single"]'); await click('[data-outlook-model="ridge"]');
  check('原模型仅画两个原始端点，实际日线继续更新', await evaluate(`document.querySelector('#outlook-chart [data-role="forecast"]').getAttribute('d').split(' ').length===2 && document.querySelector('#outlook-chart').dataset.actualThrough===${JSON.stringify(market.rows.filter(r=>r.price>0).at(-1).date)} && document.querySelector('#outlook-future-legend').textContent.includes('非逐日预测') && !!document.querySelector('#outlook-chart [data-role="archived-target"]')`));
  check('留档固定期限且不混用 GBM 区间', await evaluate(`Array.from(document.querySelectorAll('[data-outlook-horizon]')).every(b=>b.disabled) && document.querySelector('#outlook-lookback').disabled && document.querySelector('#outlook-band').disabled && !document.querySelector('#outlook-chart [data-role="interval"]') && document.querySelector('#outlook-range-label').textContent.includes('80%')`));
  await click('[data-outlook-model="macro"]');
  check('外部因素版价格取自它自己的留档', await evaluate(`document.querySelector('#outlook-chart').dataset.model==='macro' && Number(document.querySelector('#outlook-price').textContent.replace(/[^0-9.]/g,''))===${Number(macro.prediction.predictedPrice.toFixed(2))}`));
  await evaluate(`document.querySelector('#outlook-chart').focus()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
  if (market.rows.filter(r=>r.price>0).at(-1).date < macro.prediction.targetDate) {
    check('目标日提示框显示真实留档目标价', await evaluate(`document.querySelector('#outlook-tooltip').textContent.includes('留档目标价')`));
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
    check('中间日期不显示插值冒充的模型价格', await evaluate(`document.querySelector('#outlook-tooltip').textContent.includes('无逐日价格') && !document.querySelector('#outlook-tooltip').textContent.includes('$')`));
  }
  await click('#outlook-export');
  const archiveFile = await wait(async () => (await readdir(downloadDir)).find(f=>f.startsWith('BitIndex_archive_single_')), '原模型 CSV');
  const archiveCsv = await readFile(join(downloadDir, archiveFile), 'utf8');
  check('原模型 CSV 只含一个预测目标并保留签发时间', archiveCsv.split('\r\n').filter(l=>l.includes('"archived_target"')).length===1 && archiveCsv.includes(String(macro.prediction.predictedPrice)) && archiveCsv.includes(macro.issuedAt));
  await click('[data-outlook-model="ridge"]'); await shot('my-model', '#outlook-section');
  await send('Network.setBlockedURLs', { urls: ['*/data/*/tracking.json*'] });
  await click('#refresh'); await ready();
  await wait(()=>evaluate(`!document.querySelector('#forecast-refresh').disabled && document.querySelector('#forecast-status').textContent.includes('暂不可用')`), '留档失败提示');
  check('留档加载失败时不继续显示旧预测或冒用金融模型', await evaluate(`document.querySelector('#outlook-content').hidden && document.querySelector('#outlook-export').disabled && document.querySelectorAll('[data-outlook-model]').length===5`));
  await click('[data-outlook-model="gbm"]');
  check('留档加载失败时仍可使用金融模型', await evaluate(`!document.querySelector('#outlook-content').hidden && document.querySelector('#outlook-chart').dataset.model==='gbm'`));
  await send('Network.setBlockedURLs', { urls: [] }); await click('#refresh'); await ready(); await trackingReady();
  check('新看板使用同批实际收盘价并呈现实线与虚线', await evaluate(`document.querySelector('#outlook-anchor').textContent === document.querySelector('#btc-price').textContent && document.querySelector('#outlook-chart [data-role="actual"]').getAttribute('stroke-dasharray') === 'none' && document.querySelector('#outlook-chart [data-role="forecast"]').getAttribute('stroke-dasharray') === '7 5'`));
  check('历史终点和预测起点准确相接', await evaluate(`(()=>{const a=document.querySelector('#outlook-chart [data-role="actual"]').getAttribute('d').split(' ').at(-1).slice(1);const b=document.querySelector('#outlook-chart [data-role="forecast"]').getAttribute('d').split(' ')[0].slice(1);return a===b})()`));
  check('两种我的模型、三种金融模型及 GBM 条件区间均可见', await evaluate(`document.querySelectorAll('[data-outlook-model]').length===5 && !!document.querySelector('#outlook-chart [data-role="interval"]') && document.querySelector('#outlook-range-label').textContent.includes('95% 条件')`));
  await click('[data-outlook-horizon="7"]');
  check('7 天预测期更新价格和曲线', await evaluate(`document.querySelector('#outlook-chart').dataset.horizon==='7' && document.querySelector('#outlook-price-label').textContent.startsWith('7 日')`));
  await click('[data-outlook-horizon="90"]');
  await evaluate(`document.querySelector('#outlook-chart').focus()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
  check('键盘可查看未来 90 天预测及区间', await evaluate(`document.querySelector('#outlook-chart').dataset.horizon==='90' && !document.querySelector('#outlook-tooltip').hidden && document.querySelector('#outlook-tooltip').textContent.includes('模型预期') && document.querySelector('#outlook-tooltip').textContent.includes('95% 条件区间')`));
  await click('[data-outlook-model="baseline"]');
  check('不变价基准等于真实起点且不冒用 GBM 区间', await evaluate(`document.querySelector('#outlook-price').textContent===document.querySelector('#outlook-anchor').textContent && !document.querySelector('#outlook-chart [data-role="interval"]') && document.querySelector('#outlook-band').disabled`));
  await click('[data-outlook-model="trend"]');
  check('对数趋势模型可切换', await evaluate(`document.querySelector('#outlook-chart').dataset.model==='trend' && document.querySelector('#outlook-future-legend').textContent.includes('对数趋势')`));
  await evaluate(`document.querySelector('#outlook-lookback').value='90';document.querySelector('#outlook-lookback').dispatchEvent(new Event('change'))`);
  await send('Page.reload'); await ready(); await trackingReady();
  check('模型、预测期和估计窗口可持久保存', await evaluate(`document.querySelector('#outlook-chart').dataset.model==='trend' && document.querySelector('#outlook-chart').dataset.horizon==='90' && document.querySelector('#outlook-lookback').value==='90'`));
  await click('[data-outlook-model="gbm"]'); await click('[data-outlook-horizon="30"]');
  await evaluate(`document.querySelector('#outlook-lookback').value='365';document.querySelector('#outlook-lookback').dispatchEvent(new Event('change'))`);
  await click('#outlook-band');
  check('可关闭条件区间', await evaluate(`!document.querySelector('#outlook-chart [data-role="interval"]')`));
  await click('#outlook-band'); await click('#outlook-export');
  const outlookFile = await wait(async () => (await readdir(downloadDir)).find(f=>f.startsWith('BitIndex_outlook_')), '模型预期 CSV');
  const outlookCsv = await readFile(join(downloadDir, outlookFile), 'utf8');
  check('预期 CSV 包含实际价格、未来模型值与数据来源', outlookCsv.includes('"actual_price"') && outlookCsv.includes('"model","",') && outlookCsv.includes('"gbm_lower95"') && outlookCsv.includes('community-api.coinmetrics.io'));
  await click('#outlook-methodology');
  check('统一模型说明明确区间假设和均值口径', await evaluate(`document.querySelector('#info-dialog').open && document.querySelector('#outlook-methodology-section').textContent.includes('不包含参数估计误差')`));
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await shot('outlook', '#outlook-section');
  await shot('desktop'); await shot('tracking', '#forecast-section');
  await click('#theme');
  await send('Emulation.setDeviceMetricsOverride', { width: 400, height: 900, deviceScaleFactor: 1, mobile: false });
  await shot('event-mobile','#event-section');
  check('400px 事件页面没有溢出且导航可见',await evaluate(`document.documentElement.scrollWidth<=window.innerWidth && document.querySelector('nav').getBoundingClientRect().height>0`));
  await shot('mobile', '#forecast-section');
  await click('[data-outlook-model="ridge"]');
  await click('[data-archive-view="curve"]');
  await shot('outlook-mobile', '#outlook-section');
  check('400px 模型卡片与曲线无页面溢出', await evaluate(`document.documentElement.scrollWidth <= window.innerWidth && document.querySelector('#outlook-chart').clientWidth > 0 && document.querySelectorAll('#outlook-models button').length===5`));
  check('400px 窄屏没有页面横向溢出', await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`));
  check('全程无未捕获脚本异常', errors.length === 0);
  await writeFile(join(output, 'report.json'), JSON.stringify({ base, checks: results.length, results, errors, version: manifest.version, dataThrough: manifest.dataThrough }, null, 2));
  console.log(results.length + ' Pages checks passed.');
} finally {
  if (ws?.readyState === WebSocket.OPEN) { try { await send('Browser.close', {}, null); } catch {} ws.close(); }
  proc.kill();
}
