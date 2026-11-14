const http = require('node:http');
const { parseBrief, catalogFor, record } = require('./lib/providers.ts');
const { Router, requestRequirements } = require('./lib/router.ts');
const { invoke } = require('./lib/wires.ts');

const envUrl = (process.env.MAKEFUN_ENV_URL || '').replace(/\/+$/, '');
const promptFile = process.env.MAKEFUN_PROMPT_FILE || '';
const json = value => JSON.stringify(value);
const freeIds = catalog => [...new Set(catalog.providers.flatMap(p => p.models.filter(m => m.free).map(m => m.id)))].sort();

function modelDocument(ids, api) {
  if (api === 'anthropic') return { data: ids.map(id => ({ type: 'model', id, display_name: id, created_at: '2026-01-01T00:00:00Z', free: true })), has_more: false };
  return { object: 'list', data: ids.map(id => ({ id, object: 'model', created: 1767225600, owned_by: 'makefun-aggregator', free: true })) };
}
function send(res, status, body, contentType = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(body);
}
function clientError(api, message) {
  return api === 'anthropic' ? { type: 'error', error: { type: 'api_error', message } } : { error: { message, type: 'api_error', code: null } };
}
async function readBody(req) {
  const parts = []; let size = 0;
  for await (const part of req) { size += part.length; if (size > 4 * 1024 * 1024) throw new Error('request body too large'); parts.push(part); }
  const value = JSON.parse(Buffer.concat(parts).toString('utf8'));
  if (!record(value)) throw new Error('request must be a JSON object');
  return value;
}
function authApi(req) {
  return req.headers['x-api-key'] ? 'anthropic' : 'openai';
}
async function answer(req, res, router, brief, state) {
  const api = req.url === '/v1/messages' ? 'anthropic' : 'openai';
  let body;
  try { body = await readBody(req); }
  catch (e) { send(res, 400, json(clientError(api, String(e)))); return; }
  const row = brief.workload[state.index] || null;
  state.index++;
  const requirements = requestRequirements(body, row);
  const jsonMode = !!(body.response_format && ['json_object','json_schema'].includes(body.response_format.type));
  const attempted = new Set();
  let lastFailure = 'No eligible free model was available.';
  for (let n = 0; n < 6; n++) {
    const choice = router.choose(requirements, jsonMode, attempted);
    if (!choice) break;
    attempted.add(choice.provider.id + '/' + choice.model.id);
    const result = await invoke(choice, api, body, req.headers);
    router.note(choice.provider.id, result.status, result.bodyText || '');
    if (result.ok) {
      send(res, result.status, result.raw, result.contentType || (body.stream ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8'));
      return;
    }
    lastFailure = 'Provider ' + choice.provider.id + ' refused with HTTP ' + result.status + '.';
  }
  send(res, 503, json(clientError(api, lastFailure)));
}
async function run() {
  const brief = parseBrief(promptFile);
  if (!envUrl || !promptFile) {
    process.stdout.write('{"providers":[]}\n');
    return;
  }
  const state = await catalogFor(brief, envUrl);
  const catalog = { providers: state.providers.map(p => p.report) };
  if (process.argv.includes('--list')) { process.stdout.write(json(catalog) + '\n'); return; }

  const router = new Router(brief, state.providers);
  const ids = freeIds(catalog);
  const server = http.createServer(async (req, res) => {
    const path = (req.url || '').split('?')[0];
    if (req.method === 'GET' && path === '/v1/models') {
      send(res, 200, json(modelDocument(ids, authApi(req)))); return;
    }
    if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/v1/messages')) {
      await answer(req, res, router, brief, state); return;
    }
    send(res, 404, json({ error: { message: 'not found', type: 'invalid_request_error', code: null } }));
  });
  server.listen(0, '0.0.0.0');
  await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port;
  const reg = await fetch(envUrl + '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ protocol_version: 1, port, catalog }) });
  if (!reg.ok) throw new Error('register returned HTTP ' + reg.status);
  let done = false;
  while (!done) {
    const work = await fetch(envUrl + '/work');
    if (!work.ok) throw new Error('work poll returned HTTP ' + work.status);
    const value = await work.json();
    done = value.done === true;
    if (!done) await new Promise(resolve => setTimeout(resolve, 100));
  }
  await new Promise(resolve => server.close(resolve));
}

run().catch(error => { process.stderr.write('aggregator: ' + String(error) + '\n'); process.exitCode = 1; });
