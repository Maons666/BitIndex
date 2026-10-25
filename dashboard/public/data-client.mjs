import { deployment } from './runtime.mjs';

export const isStatic = deployment.mode === 'pages';
const base = new URL('./', import.meta.url);
async function json(url, options = {}) {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(90000), ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
function asset(path) {
  // Manifest paths must stay inside this Pages project directory.
  if (!/^data\/[a-f0-9]{64}\/[a-z-]+\.(json|csv)$/.test(path)) throw new Error('发布数据路径无效');
  return new URL(path, base).href;
}
export async function readMarket(force = false) {
  if (!isStatic) return json(force ? '/api/refresh' : '/api/data', { method: force ? 'POST' : 'GET' });
  const url = new URL('data/manifest.json', base);
  url.searchParams.set('check', Date.now());
  const manifest = await json(url);
  if (!/^[a-f0-9]{64}$/.test(manifest.version)) throw new Error('发布版本无效');
  const data = await json(asset(manifest.market));
  if (data.publicationVersion !== manifest.version) throw new Error('数据版本不一致，请重试');
  return { ...data, state: 'published', publication: manifest, trackingCsvUrl: asset(manifest.csv) };
}
export async function readComparisons(snapshot) {
  if (!isStatic) return json('/api/tracking');
  if (!snapshot?.publication) throw new Error('请先加载已发布数据');
  const data = await json(asset(snapshot.publication.tracking));
  if (data.publicationVersion !== snapshot.publication.version) throw new Error('对照版本不一致，请重试');
  return data;
}
