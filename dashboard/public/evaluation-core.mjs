// Shared, deterministic arithmetic for tables, charts and exports.
export function evaluateRow(row) {
  const paired = Number.isFinite(row.actualPrice) && row.actualPrice > 0;
  const error = p => paired && Number.isFinite(p) ? (p / row.actualPrice - 1) * 100 : null;
  return { ...row, signedErrorPct: error(row.base), dollarError: paired ? row.base - row.actualPrice : null,
    noEventsErrorPct: error(row.noEvents), unchangedErrorPct: error(row.unchanged),
    envelopeHit: paired ? row.actualPrice >= row.weak && row.actualPrice <= row.strong : null };
}
export function evaluationSummary(rows) {
  const paired = rows.map(evaluateRow).filter(r => [r.signedErrorPct, r.noEventsErrorPct, r.unchangedErrorPct].every(Number.isFinite));
  const avg = fn => paired.length ? paired.reduce((s, r) => s + fn(r), 0) / paired.length : null;
  return { count: paired.length, total: rows.length, mape: avg(r => Math.abs(r.signedErrorPct)), noEventsMape: avg(r => Math.abs(r.noEventsErrorPct)), unchangedMape: avg(r => Math.abs(r.unchangedErrorPct)), maeUSD: avg(r => Math.abs(r.dollarError)), biasPct: avg(r => r.signedErrorPct), envelopeHitPct: avg(r => Number(r.envelopeHit) * 100), eventWinPct: avg(r => Number(Math.abs(r.signedErrorPct) < Math.abs(r.noEventsErrorPct)) * 100) };
}
export function liveEvaluationRows(data) {
  return data.forecasts.flatMap(f => f.horizons.filter(h => h.horizon === 30).map(h => {
    const c = data.comparisons.find(c => c.forecastId === f.id && c.horizon === 30 && c.date === h.targetDate && c.status === 'settled');
    return { mode: 'live', forecastId: f.id, modelVersion: f.modelVersion, source: f.source, sourceFetchedAt: f.sourceFetchedAt, asOf: f.issuedAt, targetDate: h.targetDate, anchor: f.anchor, ...h, actualPrice: c?.actualPrice ?? null, actualObservedAt: c?.actualObservedAt ?? null, actualSourceFetchedAt: c?.actualSourceFetchedAt ?? null, events: f.events };
  })).sort((a, b) => a.targetDate.localeCompare(b.targetDate) || a.asOf.localeCompare(b.asOf));
}
export function evaluationCsv(rows, metadata = {}) {
  const columns = ['mode','modelVersion','reconstructedAt','asOf','targetDate','actualPrice','base','weak','strong','noEvents','unchanged','dollarError','signedErrorPct','noEventsErrorPct','unchangedErrorPct','envelopeHit','source','sourceFetchedAt','actualSourceFetchedAt'];
  const cell = v => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? '"' + s.replaceAll('"','""') + '"' : s; };
  return '\uFEFF' + [columns.join(','), ...rows.map(evaluateRow).map(r => columns.map(k => cell(r[k] ?? metadata[k])).join(','))].join('\r\n');
}
