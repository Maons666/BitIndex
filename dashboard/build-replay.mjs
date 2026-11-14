import { readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReplay } from './replay.mjs';
import { writeOnce } from './tracking.mjs';
import { fingerprint } from './event-model.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../event-predictions/replays');
const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
const report = buildReplay(input);
await mkdir(root, { recursive: true });
// Unique replay IDs; corrections use a new ID, preserving the original experiment.
for (const [suffix, value] of [['input', input], ['report', report]]) {
  const path = join(root, `${input.id}.${suffix}.json`);
  const text = JSON.stringify(value, null, 2) + '\n';
  try { if (await readFile(path, 'utf8') !== text) throw new Error('回放留档不能覆盖：' + path); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  await writeOnce(path, text);
}
console.log(JSON.stringify({ id: report.id, targets: [report.targetStart, report.targetEnd], count: report.rows.length, fingerprint: fingerprint(report) }));
