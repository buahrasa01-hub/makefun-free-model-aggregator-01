const fs = require('node:fs');

const SCHEMAS = {
  providers: 'free-model-aggregator-01/providers/v1',
  ratings: 'free-model-aggregator-01/ratings/v1',
  workload: 'free-model-aggregator-01/workload/v1',
};
const record = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const str = (x) => typeof x === 'string' ? x : '';
const num = (x) => typeof x === 'number' && Number.isFinite(x) ? x : null;

function objectEnd(s, start) {
  let depth = 0, quoted = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (quoted) { if (c === '\\') i++; else if (c === '"') quoted = false; }
    else if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}
function documents(text) {
  const found = [];
  for (let i = text.indexOf('{'); i >= 0; i = text.indexOf('{', i + 1)) {
    const end = objectEnd(text, i);
    if (end < 0) continue;
    try { const v = JSON.parse(text.slice(i, end + 1)); if (record(v) && typeof v.schema === 'string') found.push(v); }
    catch {}
  }
  return found;
}
function parseBrief(path) {
  if (!path) return { directory: { providers: [] }, ratings: [], workload: [] };
  const docs = documents(fs.readFileSync(path, 'utf8'));
  const directory = docs.find(x => x.schema === SCHEMAS.providers) || { providers: [] };
  const rates = docs.find(x => x.schema === SCHEMAS.ratings) || { ratings: [] };
  const tasks = docs.find(x => x.schema === SCHEMAS.workload) || { manifest: [] };
  const providers = (directory.providers || []).filter(record).map(p => ({
    id: str(p.id), name: str(p.name) || str(p.id), wire: p.wire, auth: p.auth,
    base: str(p.path) || str(p.base_path) || str(p.base_url) || str(p.base),
    key_env: str(p.key_env), key: str(p.key),
  })).filter(p => p.id && ['openai','anthropic','gemini'].includes(p.wire));
  return { directory: { providers }, ratings: (rates.ratings || []).filter(record), workload: (tasks.manifest || []).filter(record) };
}
function endpoint(env, base, suffix) {
  const root = /^https?:\/\//i.test(base) ? base.replace(/\/+$/, '') : env.replace(/\/+$/, '') + '/' + base.replace(/^\/+|\/+$/g, '');
  return root + suffix;
}
function headersFor(p) {
  if (!p.key || p.auth === 'none') return {};
  if (p.auth === 'bearer') return { authorization: 'Bearer ' + p.key };
  if (p.auth === 'x-api-key' || p.auth === 'x-goog-api-key') return { [p.auth]: p.key };
  return {};
}
function listingRows(wire, body) {
  const arr = wire === 'gemini' ? body?.models : body?.data;
  if (!Array.isArray(arr)) return [];
  return arr.filter(record).map(x => {
    const id = wire === 'gemini' ? str(x.name).replace(/^models\//, '') : str(x.id);
    const pricing = record(x.pricing) ? Object.values(x.pricing) : [];
    const pricedFree = pricing.length > 0 && pricing.every(v => Number(v) === 0);
    return { id, free: typeof x.free === 'boolean' ? x.free : pricedFree ? true : null,
      context_length: num(x.context_length) ?? num(x.context_window) ?? num(x.inputTokenLimit),
      tools: typeof x.tools === 'boolean' ? x.tools : null, vision: typeof x.vision === 'boolean' ? x.vision : null,
      json: typeof x.json === 'boolean' ? x.json : null, display_name: str(x.display_name) || str(x.displayName) || id };
  }).filter(x => x.id);
}
async function probe(p, env) {
  const url = endpoint(env, p.base, p.wire === 'gemini' ? '/v1beta/models' : '/v1/models');
  const headers = { accept: 'application/json', ...headersFor(p) };
  if (p.wire === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(4500) });
    if (!r.ok) return { provider: p, rows: [], status: r.status };
    return { provider: p, rows: listingRows(p.wire, await r.json()), status: r.status };
  } catch { return { provider: p, rows: [], status: 0 }; }
}
function ratingFor(ratings, provider, model) {
  return ratings.find(r => r.provider === provider && r.model === model) || null;
}
function mergedModels(p, probeResult, ratings) {
  const rows = new Map(probeResult.rows.map(x => [x.id, x]));
  for (const r of ratings) if (r.provider === p.id && !rows.has(r.model)) rows.set(r.model, { id: r.model, free: null });
  return [...rows.values()].map(m => {
    const r = ratingFor(ratings, p.id, m.id);
    return { id: m.id, free: typeof r?.free === 'boolean' ? r.free : m.free === true,
      context_length: r?.context_length ?? m.context_length ?? null,
      _rating: r?.rating_milli ?? 0, _tools: r?.tools ?? m.tools ?? false,
      _vision: r?.vision ?? m.vision ?? false, _json: r?.json ?? m.json ?? false,
      display_name: m.display_name || m.id };
  }).sort((a,b) => a.id.localeCompare(b.id));
}
async function catalogFor(brief, env) {
  const probed = await Promise.all(brief.directory.providers.map(p => probe(p, env)));
  const providers = probed.map(x => {
    const models = mergedModels(x.provider, x, brief.ratings);
    return { provider: x.provider, models, report: { id: x.provider.id, base_url: x.provider.base, key_env: x.provider.key_env, wire: x.provider.wire,
      models: models.map(m => ({ id: m.id, free: m.free, context_length: m.context_length })) } };
  });
  return { providers };
}
module.exports = { SCHEMAS, record, parseBrief, endpoint, headersFor, catalogFor, ratingFor };
