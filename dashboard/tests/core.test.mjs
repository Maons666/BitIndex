import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compute, rolling, miningCost, DEFAULTS, validateSettings, toCsv, DAY, rsiWilder, realizedVolatility, historicalPercentiles, withPercentiles, METRICS, cleanSelection } from '../public/core.mjs';
import { normalize, fetchHistory, createDataStore, SOURCE } from '../data.mjs';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function near(a, b, eps = 1e-9) { assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} != ${b}`); }
function fixture(n = 450) {
  return Array.from({ length: n }, (_, i) => ({ date: new Date(Date.UTC(2010, 6, 18) + i * DAY).toISOString().slice(0, 10), price: 100 + i * .1, mvrv: 2, issuance: 100, issuanceUSD: (100 + i * .1) * 100, hashrate: 1000 }));
}
function apiFixture(n = 450) { return fixture(n).map(r => ({ time: r.date + 'T00:00:00Z', PriceUSD: String(r.price), CapMVRVCur: '2', IssTotUSD: String(r.issuanceUSD), IssTotNtv: '100', HashRate: '1000' })); }
const response = data => ({ ok: true, json: async () => ({ data }) });
test('新增指数的单位、窗口和代数定义', () => {
  const rows = fixture(800).map(r => ({ ...r, price: 100, mvrv: .8 })), out = compute(rows);
  near(out[730].mayer, 1); near(out[730].ma2y, 1); near(out[730].hashRibbon, 1);
  near(out[730].nupl, -.25); near(out[730].momentum, 0); near(out[730].rsi, 50); near(out[730].volatility, 0);
  assert.equal(out[728].ma2y, null); assert.equal(out[59].momentum, null);
  assert.equal(out[58].hashRibbon, null); assert.equal(METRICS.length, 12);
});
test('Wilder RSI 趋势、递推和缺失后重置', () => {
  assert.equal(rsiWilder(Array.from({ length: 16 }, (_, i) => i + 1))[14], 100);
  assert.equal(rsiWilder(Array.from({ length: 16 }, (_, i) => 100 - i))[14], 0);
  const p = [10, 12, 11, 13, 12]; const out = rsiWilder(p, 3);
  near(out[3], 80); near(out[4], 100 * (8 / 9) / (8 / 9 + 5 / 9));
  assert.equal(rsiWilder([...p, null, 10, 11], 3).at(-1), null);
});
test('波动率为样本对数收益标准差，以 365 日年化', () => {
  const out = realizedVolatility([100, 100 * Math.exp(.1), 100 * Math.exp(.3)], 2);
  near(out[2], Math.sqrt(.005 * 365) * 100);
  assert.equal(realizedVolatility([100, null, 200], 2)[2], null);
});
test('历史分位中位秩保留负数零值且不偷看未来', () => {
  const values = historicalPercentiles([-1, 0, 0, null, 2], 1);
  [50, 75, 200 / 3, null, 87.5].forEach((v, i) => v === null ? assert.equal(values[i], null) : near(values[i], v));
  const rows = compute(fixture(800)); const before = withPercentiles(rows.slice(0, 500));
  assert.deepEqual(withPercentiles(rows).slice(0, 500), before);
  assert.deepEqual(cleanSelection(['nupl', 'unknown', 'nupl']), ['nupl']); assert.deepEqual(cleanSelection([]), []);
});
test('选择导出仅包含勾选原值与相同日期分位', () => {
  const csv = toCsv(withPercentiles(compute(fixture(800))).slice(-1), DEFAULTS, ['nupl', 'rsi']);
  assert.ok(csv.split('\r\n')[0].includes('nupl,rsi,p_nupl,p_rsi'));
  assert.ok(!csv.split('\r\n')[0].includes('ahr999'));
});

test('定投成本为调和均值，几何和算术口径分别计算', () => {
  near(rolling([100, 200], 2, 'harmonic')[1], 400 / 3);
  near(rolling([100, 200], 2, 'geometric')[1], Math.sqrt(20000));
  near(rolling([100, 200], 2)[1], 150);
});
test('缺失或零值不能被均线当成完整日历窗口', () => {
  assert.deepEqual(rolling([1, null, 3, 4, 5], 2), [null, null, null, 3.5, 4.5]);
  assert.deepEqual(rolling([0, 2], 2, 'harmonic'), [null, null]);
});
test('TH/s 与 J/TH 单位换算：1000 TH/s、10 J/TH、0.1 美元电价、2 BTC 发行 => 12 美元/枚', () => {
  near(miningCost(1000, 2, { electricity: .1, efficiency: 10, pue: 1 }), 12);
  assert.equal(miningCost(null, 2), null); assert.equal(miningCost(1000, 0), null);
});
test('Pi、Puell 和 AHR999 使用足额窗口和明确公式', () => {
  const rows = fixture().map(r => ({ ...r, price: 100, issuanceUSD: 10000 })), out = compute(rows);
  assert.equal(out[198].ahr999, null); assert.equal(out[348].pi, null); assert.equal(out[363].puell, null);
  near(out[364].pi, .5); near(out[364].puell, 1);
  const age = (Date.parse(rows[364].date) - Date.UTC(2009, 0, 3)) / DAY;
  near(out[364].ahr999, 100 / 10 ** (5.84 * Math.log10(age) - 17.01));
  assert.equal(out[364].piCross, false);
});
test('Pi 上穿只在首次交叉当天发生，而非每个线上日期', () => {
  const rows = fixture(600).map((r, i) => ({ ...r, price: i < 400 ? 100 : 10000 }));
  const out = compute(rows), crossings = out.filter(r => r.piCross);
  assert.equal(crossings.length, 1);
  const i = out.indexOf(crossings[0]); assert.ok(out[i - 1].pi < 1); assert.ok(out[i].pi >= 1); assert.equal(out[i + 1].piCross, false);
});
test('未来价格改变不影响任何已计算的历史值', () => {
  const rows = fixture(600), prefix = compute(rows.slice(0, 400)), full = compute(rows.map((r, i) => i < 400 ? r : { ...r, price: 100000, issuanceUSD: 1e10 }));
  assert.deepEqual(full.slice(0, 400), prefix);
});
test('参数拒绝无效值，CSV 含参数、来源和数值精度', () => {
  assert.throws(() => validateSettings({ pue: 0 })); assert.throws(() => validateSettings({ electricity: 'bad' }));
  const csv = toCsv(compute(fixture()).slice(-1), DEFAULTS);
  assert.match(csv, /electricity_USD_kWh,efficiency_J_TH,PUE,ahr_cost_mean,source/);
  assert.match(csv, /0.05,25,1.1,harmonic,Coin Metrics Community/);
  assert.equal(csv.split('\r\n').length, 2); assert.ok(!csv.includes('undefined'));
});
test('UTC 归一化：排序、排除未结束日线、缺日留空', () => {
  const input = [
    { time: '2026-10-17T00:00:00Z', PriceUSD: '80000' },
    { time: '2026-10-15T00:00:00Z', PriceUSD: '82000', HashRate: '' },
    { time: '2026-10-18T00:00:00Z', PriceUSD: '99999' },
    { time: '2026-02-30T00:00:00Z', PriceUSD: '99999' }
  ];
  const rows = normalize(input, '2026-10-18');
  assert.equal(rows.length, 3); assert.equal(rows[1].date, '2026-10-16'); assert.equal(rows[1].price, null);
  assert.equal(rows[0].hashrate, null); assert.equal(rows.at(-1).price, 80000);
});
test('分页地址限制到官方端点，拒绝截断历史', async () => {
  await assert.rejects(fetchHistory(async () => ({ ok: true, json: async () => ({ data: apiFixture(), next_page_url: 'https://untrusted.example/test' }) })), /分页/);
  await assert.rejects(fetchHistory(async () => response(apiFixture(10))), /历史不完整/);
});
test('并发刷新合并；刷新确实重新取数；失败保留原始时间及真实缓存', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'bitindex-test-'));
  let calls = 0, fail = false;
  const fetcher = async () => { calls++; await new Promise(r => setTimeout(r, 10)); if (fail) throw new Error('offline'); return response(apiFixture()); };
  const store = createDataStore(join(folder, 'cache.json'), fetcher);
  try {
    const [a, b] = await Promise.all([store.refresh(), store.refresh()]);
    assert.equal(calls, 1); assert.deepEqual(a.rows, b.rows); assert.equal(a.state, 'fresh'); assert.equal(a.source, SOURCE);
    const fresh = await store.refresh(); assert.equal(calls, 2);
    fail = true; const fallback = await store.refresh(); assert.equal(calls, 3); assert.equal(fallback.state, 'stale');
    assert.equal(fallback.fetchedAt, fresh.fetchedAt); assert.deepEqual(fallback.rows, fresh.rows); assert.match(fallback.error, /无法连接/);
    const newStore = createDataStore(join(folder, 'cache.json'), fetcher); const persisted = await newStore.get(); assert.equal(persisted.state, 'cached'); assert.deepEqual(persisted.rows, fresh.rows);
  } finally {
    // Only unlink known files; no recursive directory deletion.
    for (const name of await readdir(folder)) if (['cache.json', 'cache.json.tmp'].includes(name)) await rm(join(folder, name));
  }
});
test('首次失败不给出模拟值或成功状态', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'bitindex-empty-'));
  const store = createDataStore(join(folder, 'none.json'), async () => { throw new Error('offline'); });
  await assert.rejects(store.get(), /无法连接/);
});

test('两个服务同时写同一缓存不会争抢临时文件', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'bitindex-concurrent-')), file = join(folder, 'cache.json');
  const fetcher = async () => response(apiFixture());
  const stores = [createDataStore(file, fetcher), createDataStore(file, fetcher)];
  const results = await Promise.all(stores.map(store => store.refresh()));
  assert.ok(results.every(r => !r.persistenceWarning));
  assert.equal((await createDataStore(file, fetcher).get()).rows.length, 450);
  assert.deepEqual(await readdir(folder), ['cache.json']);
  await rm(file);
});
