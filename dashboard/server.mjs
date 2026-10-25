import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { createDataStore } from './data.mjs';
import { readTracking, trackingCsv, recordRun, TRACKING_MODE } from './tracking.mjs';
import { createTrackingJob } from './tracking-job.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8787);
const store = createDataStore(join(root, '..', '.cache', 'coinmetrics-btc.json'));
const trackingRoot = join(root, '..', 'predictions');
const trackingJob = createTrackingJob(join(root, '..'));
const files = new Map([
  ['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']],
  ['/style.css', ['style.css', 'text/css']], ['/app.mjs', ['app.mjs', 'text/javascript']],
  ['/core.mjs', ['core.mjs', 'text/javascript']], ['/chart.mjs', ['chart.mjs', 'text/javascript']],
  ['/forecast.mjs', ['forecast.mjs', 'text/javascript']],
  ['/runtime.mjs', ['runtime.mjs', 'text/javascript']], ['/data-client.mjs', ['data-client.mjs', 'text/javascript']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']]
]);
function json(res, code, body) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  const host = req.headers.host || '';
  if (!['127.0.0.1', 'localhost'].some(h => host === `${h}:${port}`)) return json(res, 403, { error: '仅允许本机访问' });
  const url = new URL(req.url, `http://${host}`);
  try {
    if (url.pathname === '/api/data' && req.method === 'GET') return json(res, 200, await store.get());
    if (['/api/model', '/api/model.csv', '/api/macro'].includes(url.pathname)) {
      return json(res, 410, { mode: TRACKING_MODE, newForecastsEnabled: false, error: '已停止新增预测；请查看 /api/tracking 中的原预测与实际数据对照' });
    }
    if (['/api/tracking', '/api/tracking.csv'].includes(url.pathname) && req.method === 'GET') {
      const tracking = await readTracking(trackingRoot);
      if (url.pathname.endsWith('.csv')) {
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="BitIndex_daily_comparison.csv"' });
        return res.end(trackingCsv(tracking.comparisons));
      }
      const { comparisons, ...summary } = tracking;
      return json(res, 200, { ...summary, forecasts: summary.forecasts.slice(0, 60).map(({ model, ...f }) => f) });
    }
    if (url.pathname === '/api/refresh' && req.method === 'POST') {
      if (req.headers.origin && req.headers.origin !== `http://${host}`) return json(res, 403, { error: '请求来源不匹配' });
      const snapshot = await store.refresh();
      try {
        snapshot.trackingRun = await trackingJob.run(snapshot, 'dashboard');
      } catch (e) {
        snapshot.trackingWarning = e.message;
        await recordRun(trackingRoot, { scope: 'daily', mode: TRACKING_MODE, archived: false, status: 'failed', trigger: 'dashboard', error: e.message }).catch(() => {});
      }
      return json(res, 200, snapshot);
    }
    if (url.pathname === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true, mode: TRACKING_MODE, newForecastsEnabled: false });
    if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Method not allowed' });
    if (!files.has(url.pathname)) return json(res, 404, { error: 'Not found' });
    const [file, mime] = files.get(url.pathname);
    const body = await readFile(join(root, 'public', file));
    res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8`, 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (e) { json(res, 502, { error: e.message || '数据加载失败' }); }
});
server.listen(port, '127.0.0.1', () => console.log(`BitIndex · http://127.0.0.1:${port}\n按 Ctrl+C 停止服务。`));
server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `端口 ${port} 已被占用；已有看板可直接打开 http://127.0.0.1:${port}` : e.message); process.exitCode = 1; });
