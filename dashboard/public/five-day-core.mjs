import { evaluateRow, evaluationSummary, evaluationCsv } from './evaluation-core.mjs';
export function fiveDayRows(issues, metadata = {}) {
  return issues.flatMap(issue=>issue.targets.map(t=>evaluateRow({...metadata,...t,forecastId:issue.id,mode:issue.mode,asOf:issue.asOf,source:issue.source||metadata.source,sourceFetchedAt:issue.sourceFetchedAt||metadata.sourceFetchedAt,modelVersion:issue.modelVersion||metadata.modelVersion,agentAnalysisAt:issue.agentSource?.analysisCutoffAt||metadata.reconstructedAt})));
}
export function fiveDaySummaries(issues) {
  const rows=fiveDayRows(issues);
  return [1,2,3,4,5].map(horizon=>({horizon,...evaluationSummary(rows.filter(r=>r.horizon===horizon))}));
}
export function fiveDayCsv(issues, metadata = {}) {
  // Retain the existing metadata columns and add the issue / horizon that identify each forecast.
  const rows=fiveDayRows(issues,metadata), base=evaluationCsv(rows,metadata).split('\r\n');
  return base.map((line,i)=>i===0?line+',forecastId,horizon,agentAnalysisAt':line+','+[rows[i-1].forecastId,rows[i-1].horizon,rows[i-1].agentAnalysisAt||''].join(',')).join('\r\n');
}
