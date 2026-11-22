import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeHourly, hourlyFeatures, collectHourly, readIntraday, readHourlyArchive } from '../intraday.mjs';
const receivedAt = '2026-11-22T16:32:00.000Z', end = Date.parse('2026-11-22T16:00:00Z') / 1000;
const raw = Array.from({ length: 201 }, (_, i) => [end - (200 - i) * 3600, '100', '101', '99', '100', '100', '10', 5]);
const payload = rows => ({ error: [], result: { XXBTZUSD: rows, last: end } });
const fetcher = async () => ({ ok: true, json: async () => payload(raw) });
test('小时数据剔除当前未完成 K 线，拒绝非法 OHLC 与冲突', () => {
  const rows = normalizeHourly(payload(raw), receivedAt);
  assert.equal(rows.length, 200); assert.equal(rows.at(-1).time, '2026-11-22T15:00:00.000Z');
  assert.throws(() => normalizeHourly(payload([[...raw[0].slice(0, 2), '90', ...raw[0].slice(3)], ...raw.slice(1)]), receivedAt));
  const changed = [...raw[0]]; changed[4] = '100.5';
  assert.throws(() => normalizeHourly(payload([raw[0], changed, ...raw.slice(1)]), receivedAt), /冲突/);
});
test('已实现波动率、成交量比和缺口处理具有独立数学预期', () => {
  const rows = normalizeHourly(payload(raw), receivedAt), f = hourlyFeatures(rows);
  assert.equal(f.return24hPct, 0); assert.equal(f.realizedVolatility24hPct, 0); assert.equal(f.volumeRatio, 1); assert.equal(f.vwap24h, 100);
  const gap = rows.filter((_, i) => i !== rows.length - 12), gf = hourlyFeatures(gap);
  assert.equal(gf.return24hPct, null); assert.equal(gf.realizedVolatility24hPct, null); assert.equal(gf.volumeRatio, null); assert.equal(gf.return6hPct, 0);
  const ramp = rows.map((r, i) => ({ ...r, close: Math.exp(i * 0.01) * 100 }));
  assert.ok(Math.abs(hourlyFeatures(ramp).realizedVolatility24hPct - Math.sqrt(24)) < 1e-10);
});
test('每天只采集一次，失败保留旧小时，后续修订不改首次记录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bitindex-hourly-'));
  await collectHourly(root, { fetcher, now: new Date('2026-11-22T16:31:00Z'), receivedAt });
  assert.equal((await collectHourly(root, { fetcher: () => { throw new Error('不应调用'); }, now: new Date(receivedAt) })).status, 'skipped');
  const next = new Date('2026-11-23T16:32:00Z');
  await assert.rejects(collectHourly(root, { now: next, fetcher: async () => { throw new Error('offline'); } }));
  assert.equal((await readIntraday(root)).count, 200); assert.equal((await readIntraday(root)).lastAttempt.status, 'failed');
  const revised = raw.map(r => [...r]); revised[0][4] = '100.5';
  for (let i = 1; i <= 24; i++) revised.push([end + i * 3600, '100', '101', '99', '100', '100', '10', 5]);
  await collectHourly(root, { now: next, receivedAt: next.toISOString(), fetcher: async () => ({ ok: true, json: async () => payload(revised) }) });
  const archive = await readHourlyArchive(root); assert.equal(archive.rows[0].close, 100); assert.equal(archive.rows.length, 224); assert.equal(archive.batches[1].revisions.length, 1);
  const path = join(root, 'intraday/batches/2026-11-22.json'), saved = JSON.parse(await readFile(path, 'utf8')); saved.newRows[0].close = 50;
  await writeFile(path, JSON.stringify(saved)); await assert.rejects(readIntraday(root), /校验/);
});
