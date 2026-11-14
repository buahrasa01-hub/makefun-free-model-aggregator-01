const { endpoint, headersFor } = require('./providers.ts');
const rec = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const arr = x => Array.isArray(x) ? x : [];
const txt = x => typeof x === 'string' ? x : '';
const number = x => typeof x === 'number' && Number.isFinite(x) ? x : 0;

function textBlocks(v) {
  if (typeof v === 'string') return v;
  if (!Array.isArray(v)) return '';
  return v.filter(x => rec(x) && x.type === 'text' && typeof x.text === 'string').map(x => x.text).join('\n');
}
function imagePart(x) {
  if (!rec(x)) return null;
  if (x.type === 'image_url' && rec(x.image_url) && typeof x.image_url.url === 'string') return { type: 'image_url', image_url: { url: x.image_url.url } };
  if (x.type === 'image' && rec(x.source)) {
    if (x.source.type === 'base64') return { type: 'image_url', image_url: { url: 'data:' + (x.source.media_type || 'image/png') + ';base64,' + x.source.data } };
    if (x.source.type === 'url') return { type: 'image_url', image_url: { url: x.source.url } };
  }
  return null;
}
function openPartsToAnthropic(content) {
  if (typeof content === 'string') return content;
  return arr(content).flatMap(x => {
    if (rec(x) && x.type === 'text') return [{ type: 'text', text: txt(x.text) }];
    if (rec(x) && x.type === 'image_url' && rec(x.image_url)) {
      const u = txt(x.image_url.url);
      const m = /^data:([^;]+);base64,(.*)$/s.exec(u);
      if (m) return [{ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }];
      return [{ type: 'image', source: { type: 'url', url: u } }];
    }
    return [];
  });
}
function anthropicToOpenAI(body, model) {
  const messages = [];
  if (body.system !== undefined) messages.push({ role: 'system', content: textBlocks(body.system) });
  for (const m of arr(body.messages)) {
    if (!rec(m)) continue;
    if (typeof m.content === 'string') { messages.push({ role: m.role, content: m.content }); continue; }
    const blocks = arr(m.content);
    if (m.role === 'assistant') {
      const tools = blocks.filter(x => rec(x) && x.type === 'tool_use').map(x => ({ id: txt(x.id), type: 'function', function: { name: txt(x.name), arguments: JSON.stringify(rec(x.input) ? x.input : {}) } }));
      const text = textBlocks(blocks);
      messages.push({ role: 'assistant', content: text || null, ...(tools.length ? { tool_calls: tools } : {}) });
    } else {
      const toolResults = blocks.filter(x => rec(x) && x.type === 'tool_result');
      for (const t of toolResults) messages.push({ role: 'tool', tool_call_id: txt(t.tool_use_id), content: typeof t.content === 'string' ? t.content : textBlocks(t.content) || JSON.stringify(t.content ?? '') });
      const parts = blocks.flatMap(x => {
        if (rec(x) && x.type === 'text') return [{ type: 'text', text: txt(x.text) }];
        if (rec(x) && x.type === 'image') { const p = imagePart(x); return p ? [p] : []; }
        return [];
      });
      if (parts.length) messages.push({ role: m.role || 'user', content: parts });
    }
  }
  const out = { model, messages };
  for (const [a,b] of [['max_tokens','max_tokens'],['temperature','temperature'],['top_p','top_p'],['stop_sequences','stop']]) if (body[a] !== undefined) out[b] = body[a];
  if (Array.isArray(body.tools)) out.tools = body.tools.map(t => ({ type: 'function', function: { name: txt(t.name), description: txt(t.description), parameters: t.input_schema || { type: 'object', properties: {} } } }));
  if (rec(body.tool_choice)) {
    if (body.tool_choice.type === 'auto') out.tool_choice = 'auto';
    else if (body.tool_choice.type === 'any') out.tool_choice = 'required';
    else if (body.tool_choice.type === 'tool') out.tool_choice = { type: 'function', function: { name: txt(body.tool_choice.name) } };
  }
  if (body.stream === true) { out.stream = true; out.stream_options = { include_usage: true }; }
  return out;
}
function openAIToAnthropic(body, model) {
  let system = '';
  const messages = [];
  for (const m of arr(body.messages)) {
    if (!rec(m)) continue;
    if (m.role === 'system' || m.role === 'developer') { system += (system ? '\n' : '') + textBlocks(m.content); continue; }
    if (m.role === 'tool' || m.role === 'function') {
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: txt(m.tool_call_id), content: txt(m.content) }] }); continue;
    }
    if (m.role === 'assistant') {
      const content = [];
      const text = textBlocks(m.content);
      if (text) content.push({ type: 'text', text });
      for (const c of arr(m.tool_calls)) if (rec(c) && rec(c.function)) {
        let input = {}; try { input = JSON.parse(c.function.arguments || '{}'); } catch {}
        content.push({ type: 'tool_use', id: txt(c.id), name: txt(c.function.name), input: rec(input) ? input : {} });
      }
      messages.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] }); continue;
    }
    messages.push({ role: 'user', content: openPartsToAnthropic(m.content) });
  }
  const out = { model, max_tokens: number(body.max_tokens ?? body.max_completion_tokens) || 1024, messages };
  if (system) out.system = system;
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (body.stop !== undefined) out.stop_sequences = body.stop;
  if (Array.isArray(body.tools)) out.tools = body.tools.map(t => ({ name: txt(t?.function?.name), description: txt(t?.function?.description), input_schema: t?.function?.parameters || { type: 'object', properties: {} } }));
  if (body.tool_choice === 'auto') out.tool_choice = { type: 'auto' };
  else if (body.tool_choice === 'required') out.tool_choice = { type: 'any' };
  else if (rec(body.tool_choice) && rec(body.tool_choice.function)) out.tool_choice = { type: 'tool', name: txt(body.tool_choice.function.name) };
  if (body.stream === true) out.stream = true;
  return out;
}
function toGemini(body, api, model, jsonMode) {
  const contents = [];
  let systemText = '';
  if (api === 'anthropic') {
    systemText = textBlocks(body.system);
    for (const m of arr(body.messages)) {
      if (!rec(m)) continue;
      const role = m.role === 'assistant' ? 'model' : 'user';
      const parts = [];
      if (typeof m.content === 'string') parts.push({ text: m.content });
      else for (const b of arr(m.content)) {
        if (rec(b) && b.type === 'text') parts.push({ text: txt(b.text) });
        else if (rec(b) && b.type === 'image' && rec(b.source)) {
          if (b.source.type === 'base64') parts.push({ inlineData: { mimeType: b.source.media_type || 'image/png', data: b.source.data } });
          else if (b.source.type === 'url') parts.push({ fileData: { mimeType: 'image/*', fileUri: b.source.url } });
        } else if (rec(b) && b.type === 'tool_result') parts.push({ text: typeof b.content === 'string' ? b.content : textBlocks(b.content) });
        else if (rec(b) && b.type === 'tool_use') parts.push({ functionCall: { name: b.name, args: b.input || {} } });
      }
      contents.push({ role, parts });
    }
  } else {
    for (const m of arr(body.messages)) {
      if (!rec(m)) continue;
      if (m.role === 'system' || m.role === 'developer') { systemText += (systemText ? '\n' : '') + textBlocks(m.content); continue; }
      const role = m.role === 'assistant' ? 'model' : 'user';
      const parts = [];
      if (typeof m.content === 'string') parts.push({ text: m.content });
      else for (const b of arr(m.content)) {
        if (rec(b) && b.type === 'text') parts.push({ text: txt(b.text) });
        else if (rec(b) && b.type === 'image_url' && rec(b.image_url)) {
          const match = /^data:([^;]+);base64,(.*)$/s.exec(txt(b.image_url.url));
          if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
          else parts.push({ fileData: { mimeType: 'image/*', fileUri: b.image_url.url } });
        }
      }
      for (const c of arr(m.tool_calls)) if (rec(c) && rec(c.function)) { let args = {}; try { args = JSON.parse(c.function.arguments || '{}'); } catch {} parts.push({ functionCall: { name: c.function.name, args } }); }
      if (m.role === 'tool') parts.push({ functionResponse: { name: txt(m.name), response: { content: txt(m.content) } } });
      contents.push({ role, parts });
    }
  }
  const config = {};
  const max = api === 'anthropic' ? body.max_tokens : (body.max_tokens ?? body.max_completion_tokens);
  if (typeof max === 'number') config.maxOutputTokens = max;
  const temp = body.temperature;
  if (typeof temp === 'number') config.temperature = temp;
  const topP = body.top_p;
  if (typeof topP === 'number') config.topP = topP;
  const stops = api === 'anthropic' ? body.stop_sequences : body.stop;
  if (stops !== undefined) config.stopSequences = Array.isArray(stops) ? stops : [stops];
  if (jsonMode) config.responseMimeType = 'application/json';
  const tools = [];
  if (api === 'anthropic') for (const t of arr(body.tools)) tools.push({ name: txt(t?.name), description: txt(t?.description), parameters: t?.input_schema || { type: 'object', properties: {} } });
  else for (const t of arr(body.tools)) if (rec(t?.function)) tools.push({ name: txt(t.function.name), description: txt(t.function.description), parameters: t.function.parameters || { type: 'object', properties: {} } });
  const request = { contents, generationConfig: config };
  if (systemText) request.systemInstruction = { parts: [{ text: systemText }] };
  if (tools.length) request.tools = [{ functionDeclarations: tools }];
  if (body.stream === true) request.generationConfig = config;
  return request;
}
function parseSse(text) {
  return text.replace(/\r\n/g,'\n').split('\n\n').flatMap(frame => {
    const data = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n');
    if (!data || data === '[DONE]') return [];
    try { const x = JSON.parse(data); return rec(x) ? [x] : []; } catch { return []; }
  });
}
function normalize(wire, data, stream) {
  if (wire === 'openai') {
    if (stream) {
      let text = '', finish = null, input = 0, output = 0, id = '';
      const calls = new Map();
      for (const c of data) {
        id ||= txt(c.id);
        if (rec(c.usage)) { input = number(c.usage.prompt_tokens); output = number(c.usage.completion_tokens); }
        const choice = arr(c.choices)[0]; if (!rec(choice)) continue;
        if (rec(choice.delta) && typeof choice.delta.content === 'string') text += choice.delta.content;
        if (typeof choice.finish_reason === 'string') finish = choice.finish_reason;
        for (const t of arr(choice.delta?.tool_calls)) {
          const i = number(t.index); const old = calls.get(i) || { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (t.id) old.id = t.id; if (t.function?.name) old.function.name += t.function.name;
          if (t.function?.arguments) old.function.arguments += t.function.arguments; calls.set(i, old);
        }
      }
      return { text, finish: finish || 'stop', usage: { input, output }, id, tools: [...calls.values()] };
    }
    const c = arr(data.choices)[0] || {}, m = c.message || {};
    return { text: typeof m.content === 'string' ? m.content : textBlocks(m.content), finish: c.finish_reason || 'stop', usage: { input: number(c.usage?.prompt_tokens ?? data.usage?.prompt_tokens), output: number(c.usage?.completion_tokens ?? data.usage?.completion_tokens) }, id: txt(data.id), tools: arr(m.tool_calls) };
  }
  if (wire === 'anthropic') {
    if (stream) {
      let text = '', finish = 'end_turn', input = 0, output = 0, id = '';
      const tools = new Map();
      for (const e of data) {
        if (e.type === 'message_start' && rec(e.message)) { id = txt(e.message.id); input = number(e.message.usage?.input_tokens); }
        if (e.type === 'content_block_start' && rec(e.content_block) && e.content_block.type === 'tool_use') tools.set(e.index, { id: e.content_block.id, type: 'function', function: { name: e.content_block.name, arguments: '' } });
        if (e.type === 'content_block_delta' && rec(e.delta)) {
          if (e.delta.type === 'text_delta') text += txt(e.delta.text);
          if (e.delta.type === 'input_json_delta' && tools.has(e.index)) tools.get(e.index).function.arguments += txt(e.delta.partial_json);
        }
        if (e.type === 'message_delta') { finish = e.delta?.stop_reason || finish; output = number(e.usage?.output_tokens); }
      }
      return { text, finish, usage: { input, output }, id, tools: [...tools.values()] };
    }
    const c = arr(data.content);
    return { text: c.filter(x => x.type === 'text').map(x => txt(x.text)).join(''), finish: data.stop_reason || 'end_turn', usage: { input: number(data.usage?.input_tokens), output: number(data.usage?.output_tokens) }, id: txt(data.id), tools: c.filter(x => x.type === 'tool_use').map(x => ({ id: x.id, type: 'function', function: { name: x.name, arguments: JSON.stringify(x.input || {}) } })) };
  }
  const responses = stream ? data : [data];
  let text = '', finish = 'STOP', input = 0, output = 0, id = '', tools = [];
  for (const c of responses) {
    id ||= txt(c.modelVersion);
    const candidate = arr(c.candidates)[0] || {};
    if (candidate.finishReason) finish = candidate.finishReason;
    for (const p of arr(candidate.content?.parts)) {
      if (typeof p.text === 'string') text += p.text;
      if (rec(p.functionCall)) tools.push({ id: 'call_' + tools.length, type: 'function', function: { name: txt(p.functionCall.name), arguments: JSON.stringify(p.functionCall.args || {}) } });
    }
    if (rec(c.usageMetadata)) { input = number(c.usageMetadata.promptTokenCount); output = number(c.usageMetadata.candidatesTokenCount); }
  }
  return { text, finish, usage: { input, output }, id, tools };
}
function openFinish(f) {
  if (['MAX_TOKENS','max_tokens','length'].includes(f)) return 'length';
  if (['FUNCTION_CALL','tool_use','tool_calls'].includes(f)) return 'tool_calls';
  if (['SAFETY','content_filter','refusal'].includes(f)) return 'content_filter';
  return 'stop';
}
function anthropicFinish(f) {
  if (['MAX_TOKENS','length','max_tokens'].includes(f)) return 'max_tokens';
  if (['FUNCTION_CALL','tool_calls','tool_use'].includes(f)) return 'tool_use';
  if (['SAFETY','content_filter','refusal'].includes(f)) return 'refusal';
  return 'end_turn';
}
function openJson(answer, model) {
  const message = { role: 'assistant', content: answer.text };
  if (answer.tools.length) message.tool_calls = answer.tools;
  return { id: 'chatcmpl_' + (answer.id || 'aggregate'), object: 'chat.completion', created: 1767225600, model,
    choices: [{ index: 0, message, finish_reason: openFinish(answer.finish) }],
    usage: { prompt_tokens: answer.usage.input, completion_tokens: answer.usage.output, total_tokens: answer.usage.input + answer.usage.output } };
}
function anthropicJson(answer, model) {
  const content = [];
  if (answer.text !== '') content.push({ type: 'text', text: answer.text });
  for (const t of answer.tools) {
    let input = {}; try { input = JSON.parse(t.function.arguments || '{}'); } catch {}
    content.push({ type: 'tool_use', id: t.id || 'toolu_unknown', name: t.function.name, input: rec(input) ? input : {} });
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  return { id: 'msg_' + (answer.id || 'aggregate'), type: 'message', role: 'assistant', model, content,
    stop_reason: anthropicFinish(answer.finish), stop_sequence: null,
    usage: { input_tokens: answer.usage.input, output_tokens: answer.usage.output } };
}
function sse(event, data) { return (event ? 'event: ' + event + '\n' : '') + 'data: ' + JSON.stringify(data) + '\n\n'; }
function openStream(answer, model) {
  const id = 'chatcmpl_' + (answer.id || 'aggregate'), created = 1767225600;
  let out = sse(null, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
  if (answer.text) out += sse(null, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: answer.text }, finish_reason: null }] });
  for (let i = 0; i < answer.tools.length; i++) {
    const t = answer.tools[i];
    out += sse(null, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: t.id || 'call_' + i, type: 'function', function: { name: t.function.name, arguments: t.function.arguments || '{}' } }] }, finish_reason: null }] });
  }
  out += sse(null, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: openFinish(answer.finish) }] });
  out += sse(null, { id, object: 'chat.completion.chunk', created, model, choices: [], usage: { prompt_tokens: answer.usage.input, completion_tokens: answer.usage.output, total_tokens: answer.usage.input + answer.usage.output } });
  return out + 'data: [DONE]\n\n';
}
function anthropicStream(answer, model) {
  let out = sse('message_start', { type: 'message_start', message: { id: 'msg_' + (answer.id || 'aggregate'), type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: answer.usage.input, output_tokens: 0 } } });
  let index = 0;
  if (answer.text !== '') {
    out += sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
    out += sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: answer.text } });
    out += sse('content_block_stop', { type: 'content_block_stop', index }); index++;
  }
  for (const t of answer.tools) {
    let args = t.function.arguments || '{}';
    out += sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: t.id || 'toolu_' + index, name: t.function.name, input: {} } });
    out += sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: args } });
    out += sse('content_block_stop', { type: 'content_block_stop', index }); index++;
  }
  out += sse('message_delta', { type: 'message_delta', delta: { stop_reason: anthropicFinish(answer.finish), stop_sequence: null }, usage: { output_tokens: answer.usage.output } });
  return out + sse('message_stop', { type: 'message_stop' });
}
async function invoke(choice, api, body, headers) {
  const p = choice.provider, model = choice.model.id;
  const jsonMode = !!(body.response_format && ['json_object','json_schema'].includes(body.response_format.type));
  const sameWire = api === p.wire;
  let upstreamBody;
  if (p.wire === 'openai') {
    upstreamBody = api === 'anthropic' ? anthropicToOpenAI(body, model) : { ...body, model };
    if (upstreamBody.stream === true) upstreamBody.stream_options = { ...(upstreamBody.stream_options || {}), include_usage: true };
  } else if (p.wire === 'anthropic') {
    upstreamBody = api === 'anthropic' ? { ...body, model } : openAIToAnthropic(body, model);
  } else upstreamBody = toGemini(body, api, model, jsonMode);

  const auth = headersFor(p);
  const outHeaders = { 'content-type': 'application/json', ...auth };
  let url;
  if (p.wire === 'openai') url = endpoint(process.env.MAKEFUN_ENV_URL || '', p.base, '/v1/chat/completions');
  else if (p.wire === 'anthropic') {
    url = endpoint(process.env.MAKEFUN_ENV_URL || '', p.base, '/v1/messages');
    outHeaders['anthropic-version'] = headers['anthropic-version'] || '2023-06-01';
  } else {
    const action = body.stream === true ? 'streamGenerateContent?alt=sse' : 'generateContent';
    url = endpoint(process.env.MAKEFUN_ENV_URL || '', p.base, '/v1beta/models/' + encodeURIComponent(model) + ':' + action);
  }
  let response;
  try {
    response = await fetch(url, { method: 'POST', headers: outHeaders, body: JSON.stringify(upstreamBody), signal: AbortSignal.timeout(25000) });
  } catch (e) { return { ok: false, status: 503, bodyText: String(e), provider: p, model }; }
  const raw = await response.text();
  if (!response.ok) return { ok: false, status: response.status, bodyText: raw, provider: p, model };
  if (sameWire && p.wire !== 'gemini') return { ok: true, status: response.status, raw, contentType: response.headers.get('content-type') || '', passthrough: true, provider: p, model };
  let parsed;
  if (body.stream === true) parsed = normalize(p.wire, parseSse(raw), true);
  else {
    let data = {}; try { data = JSON.parse(raw); } catch {}
    parsed = normalize(p.wire, data, false);
  }
  const result = api === 'openai' ? (body.stream ? openStream(parsed, model) : JSON.stringify(openJson(parsed, model))) :
    (body.stream ? anthropicStream(parsed, model) : JSON.stringify(anthropicJson(parsed, model)));
  return { ok: true, status: 200, raw: result, contentType: body.stream ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8', passthrough: false, provider: p, model };
}
module.exports = { invoke };
