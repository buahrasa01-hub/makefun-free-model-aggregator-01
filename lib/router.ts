const { ratingFor } = require('./providers.ts');

function canServe(row, req) {
  if (!row || row.free !== true) return false;
  if (req.tools && row._tools !== true) return false;
  if (req.vision && row._vision !== true) return false;
  if (req.json && row._json !== true) return false;
  if (req.min_context != null && (!Number.isFinite(row.context_length) || row.context_length < req.min_context)) return false;
  return true;
}
function requestRequirements(body, manifest) {
  const req = { ...((manifest && manifest.requires) || {}) };
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.some(x => Array.isArray(x?.content) && x.content.some(y => y?.type === 'image' || y?.type === 'image_url'))) req.vision = true;
  if (Array.isArray(body.tools) && body.tools.length) req.tools = true;
  if (body.response_format && ['json_object','json_schema'].includes(body.response_format.type)) req.json = true;
  return req;
}
function errorMessage(bodyText) {
  try { const j = JSON.parse(bodyText); return String(j?.error?.message || j?.error?.type || j?.error?.status || j?.message || ''); }
  catch { return bodyText || ''; }
}
class Router {
  constructor(brief, providers) { this.brief = brief; this.providers = providers; this.calls = new Map(); this.exhausted = new Set(); }
  candidates(req, jsonMode) {
    const out = [];
    for (const p of this.providers) for (const m of p.models) {
      if (!canServe(m, req)) continue;
      if (jsonMode && p.provider.wire !== 'openai') continue;
      const rating = ratingFor(this.brief.ratings, p.provider.id, m.id);
      out.push({ provider: p.provider, model: m, rating: rating?.rating_milli || 0 });
    }
    return out.sort((a,b) => b.rating - a.rating || a.provider.id.localeCompare(b.provider.id) || a.model.id.localeCompare(b.model.id));
  }
  choose(req, jsonMode, attempted) {
    const c = this.candidates(req, jsonMode).filter(x => !this.exhausted.has(x.provider.id) && !attempted.has(x.provider.id + '/' + x.model.id));
    if (!c.length) return null;
    const ceiling = c[0].rating;
    const band = c.filter(x => ceiling - x.rating <= 12);
    band.sort((a,b) => (this.calls.get(a.provider.id) || 0) - (this.calls.get(b.provider.id) || 0) || b.rating - a.rating || a.provider.id.localeCompare(b.provider.id));
    return band[0];
  }
  note(provider, status, bodyText) {
    this.calls.set(provider, (this.calls.get(provider) || 0) + 1);
    const msg = errorMessage(bodyText).toLowerCase();
    if (status >= 500 || msg.includes('budget is spent') || msg.includes(' is out')) this.exhausted.add(provider);
  }
}
module.exports = { Router, requestRequirements };
