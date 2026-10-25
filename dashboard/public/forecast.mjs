import { number, usd } from './chart.mjs';
import { readComparisons } from './data-client.mjs';
const $ = id => document.getElementById(id);
const percent = n => Number.isFinite(n) ? number(n, 2) + '%' : '—';
let requestId = 0;
export async function loadForecast(snapshot) {
  const id = ++requestId;
  $('forecast-status').textContent = '正在读取历史预测与实际对照…';
  $('forecast-status').classList.remove('warn');
  $('forecast-refresh').disabled = true;
  $('tracking-body').replaceChildren();
  $('tracking-scores').replaceChildren();
  $('tracking-status').textContent = '';
  try {
    const data = await readComparisons(snapshot);
    if (id !== requestId) return;
    if (data.newForecastsEnabled !== false) throw new Error('请重启本地服务以应用停止新增预测的设置');
    $('tracking-export').href = snapshot?.trackingCsvUrl || '/api/tracking.csv';
    const a = data.latestActual, run = data.lastRun;
    $('forecast-status').textContent = a
      ? '实际日线截至 ' + a.date + '（UTC） · ' + usd(a.price) + (run?.sourceFetchedAt ? ' · 最近获取 ' + new Date(run.sourceFetchedAt).toLocaleString('zh-CN', { timeZone: 'America/New_York', hour12: false }) + '（纽约）' : '')
      : '尚未记录实际日线，点击更新实际数据。';
    if (run && run.status !== 'success') {
      $('forecast-status').textContent += ' · ' + (run.error || run.status);
      $('forecast-status').classList.add('warn');
    }
    $('tracking-status').textContent = '已留档 ' + data.total + ' 份 · 待验证 ' + data.pending + ' 份 · 已验证 ' + data.settled + ' 份';
    const name = v => v.includes('macro') ? '外部因素候选' : '原模型';
    $('tracking-scores').replaceChildren(...data.versions.map(v => {
      const text = document.createElement('span');
      text.textContent = name(v.version) + '：' + (v.settled ? v.settled + ' 期到期 · 误差 ' + percent(v.mape) + ' · 基准 ' + percent(v.baselineMape) : '尚无到期结果');
      return text;
    }));
    $('tracking-body').replaceChildren(...data.forecasts.slice(0, 60).map(f => {
      const tr = document.createElement('tr'), c = f.comparison;
      const status = c?.status === 'settled' ? '已到期 · ' + percent(c.absoluteErrorPct) : '待目标日数据';
      for (const value of [new Date(f.issuedAt).toLocaleString('zh-CN', { timeZone: 'America/New_York', hour12: false }), name(f.modelVersion), f.prediction.targetDate, usd(f.prediction.predictedPrice), c?.date ?? '—', usd(c?.actualPrice), percent(c?.targetGapPct), status]) {
        const cell = document.createElement('td'); cell.textContent = value; tr.append(cell);
      }
      return tr;
    }));
  } catch (e) {
    if (id !== requestId) return;
    $('forecast-status').textContent = '对照记录暂不可用：' + e.message;
    $('forecast-status').classList.add('warn');
  } finally { if (id === requestId) $('forecast-refresh').disabled = false; }
}
