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
  await click('#select-default'); await click('[data-range="365"]');
  await evaluate(`document.querySelector('#compare-mode').value='percentile';document.querySelector('#compare-mode').dispatchEvent(new Event('change'))`);
  await shot('desktop'); await shot('tracking', '#forecast-section');
  await click('#theme');
  await send('Emulation.setDeviceMetricsOverride', { width: 400, height: 900, deviceScaleFactor: 1, mobile: false });
  await shot('mobile', '#forecast-section');
  check('400px 窄屏没有页面横向溢出', await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`));
  check('全程无未捕获脚本异常', errors.length === 0);
  await writeFile(join(output, 'report.json'), JSON.stringify({ base, checks: results.length, results, errors, version: manifest.version, dataThrough: manifest.dataThrough }, null, 2));
  console.log(results.length + ' Pages checks passed.');
} finally {
  if (ws?.readyState === WebSocket.OPEN) { try { await send('Browser.close', {}, null); } catch {} ws.close(); }
  proc.kill();
}
