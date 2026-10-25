import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVix, parseEffr, alignMacro, buildMacroModel } from '../macro.mjs';
import { createModelStore } from '../model.mjs';
import { DAY } from '../public/core.mjs';

test('官方数据解析保留真实日期、利率零值，并拒绝 HTML', () => {
  assert.deepEqual(parseVix('DATE,OPEN,HIGH,LOW,CLOSE\n10/16/2026,1,1,1,19.99\n02/30/2026,1,1,1,22'), [{ date: '2026-10-16', value: 19.99 }]);
  assert.throws(() => parseVix('<html>blocked</html>'));
  assert.deepEqual(parseEffr({ refRates: [{ effectiveDate: '2026-10-16', type: 'EFFR', percentRate: 0 }] }), [{ date: '2026-10-16', value: 0 }]);
});
test('外部因子按可用日期滞后，节假日只沿用过去值，过期不无限填充', () => {
  const macro = { vix: [{ date: '2026-10-10', value: 10 }, { date: '2026-10-16', value: 20 }], effr: [{ date: '2026-10-10', value: 1 }, { date: '2026-10-16', value: 2 }] };
  const rows = alignMacro(['2026-10-16', '2026-10-17', '2026-10-19', '2026-10-20', '2026-11-01'], macro);
  assert.equal(rows.get('2026-10-16').vix, 10); assert.equal(rows.get('2026-10-17').vix, 20);
  assert.equal(rows.get('2026-10-19').effr, 1); assert.equal(rows.get('2026-10-20').effr, 2);
  assert.equal(rows.get('2026-11-01').vix, null); assert.equal(rows.get('2026-11-01').effr, null);
});
test('加入未来外部冲击不改变旧因子和旧预测；配对回测日期一致', () => {
  const rows = Array.from({ length: 1900 }, (_, i) => { const price = 100 * Math.exp(.001 * i + .2 * Math.sin(i / 70)); return { date: new Date(Date.UTC(2010, 0, 1) + i * DAY).toISOString().slice(0, 10), price, mvrv: 2 + .3 * Math.sin(i / 90), issuanceUSD: price * 100, issuance: 100, hashrate: 1000 + i }; });
  const macro = { fetchedAt: 'test', state: 'fresh', sources: {}, vix: rows.map((r, i) => ({ date: r.date, value: 20 + 5 * Math.sin(i / 33) })), effr: rows.map((r, i) => ({ date: r.date, value: 1 + i / 10000 })) };
  const prefix = { source: 'test', fetchedAt: 'test', rows: rows.slice(0, 1800) }, full = { ...prefix, rows };
  const a = buildMacroModel(prefix, { ...macro, vix: macro.vix.slice(0, 1800), effr: macro.effr.slice(0, 1800) }, createModelStore()(prefix));
  const b = buildMacroModel(full, { ...macro, vix: macro.vix.map((r, i) => i < 1800 ? r : { ...r, value: 500 }), effr: macro.effr }, createModelStore()(full));
  assert.deepEqual(b.history.filter(r => r.targetDate <= rows[1799].date), a.history);
  assert.equal(b.paired.original.n, b.paired.candidate.n); assert.equal(b.features.length, 13);
  assert.equal(a.current.featureDate, rows[1798].date);
});
