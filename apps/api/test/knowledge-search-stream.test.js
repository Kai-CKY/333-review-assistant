import test from 'node:test';
import assert from 'node:assert/strict';
import { ArkKnowledgeSearch } from '../src/knowledge/providers.js';

const draft = (count = 1) => ({ title: '学习资料', items: Array.from({ length: count }, (_, i) => ({ id: `K${i + 1}`, title: `条目${i + 1}`, text: `原文${i + 1}` })), queries: ['资料 原文'] });
const urlFor = item => `https://source.test/${item.id}`;
function payload(items, options = {}) {
  return { id: options.id || `response-${items[0].id}`, model: 'search-model', status: 'completed', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, output_tokens_details: { reasoning_tokens: 2 } }, output: [
    ...(options.noCalls ? [] : [{ id: `call-${items[0].id}`, type: 'web_search_call', status: 'completed', action: { sources: items.map(item => ({ url: urlFor(item) })) } }]),
    { type: 'message', status: 'completed', content: [{ type: 'output_text', text: options.text ?? JSON.stringify({ checks: options.checks || items.map(item => ({ id: item.id, status: 'supported', text: `${item.text}（核验）`, reason: '来源支持', citations: [urlFor(item)] })) }), annotations: options.annotations || [] }] }
  ] };
}
const eventFrame = (type, extra = {}) => `event: ${type}\r\ndata: ${JSON.stringify({ type, ...extra })}\r\n\r\n`;
function sse(response, { done = true, before = '', after = '', chunkSize = 0, failAfter = false } = {}) {
  const text = before + eventFrame('response.completed', { response }) + (done ? 'data: [DONE]\n\n' : '') + after;
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (offset >= bytes.length) { if (failAfter) controller.error(new Error('connection reset')); else controller.close(); return; }
    const next = chunkSize ? Math.min(bytes.length, offset + chunkSize) : bytes.length;
    controller.enqueue(bytes.slice(offset, next)); offset = next;
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
const adapter = (fetchImpl, options = {}) => new ArkKnowledgeSearch({ apiKey: 'test', model: 'search-model', fetchImpl, retryDelayMs: 0, ...options });
const inputItems = request => JSON.parse(JSON.parse(request.body).input).items;

test('40 items use five independent streaming batches and preserve real evidence and order', async () => {
  const requests = [];
  const search = adapter(async (_url, req) => {
    const body = JSON.parse(req.body), items = inputItems(req); requests.push(items);
    assert.equal(body.stream, true); assert.equal(body.store, false); assert.equal(body.max_tool_calls, 6);
    assert.equal(req.headers.accept, 'text/event-stream');
    return sse(payload(items), { chunkSize: 7, before: eventFrame('response.output_text.delta', { delta: '{irrelevant incremental JSON' }) });
  });
  const result = await search.verify(draft(40));
  assert.deepEqual(requests.map(items => items.length), [8, 8, 8, 8, 8]);
  assert.deepEqual(result.checks.map(check => check.id), draft(40).items.map(item => item.id));
  assert.ok(result.checks.every(check => check.status === 'supported'));
  assert.equal(result.calls.length, 5); assert.equal(result.calls[4].id, 'call-K33');
  assert.equal(result.calls[4].action.sources[0].url, 'https://source.test/K33');
  assert.equal(result.calls[4].batch, 5); assert.equal(result.responseId, null);
  assert.equal(result.responseIds.length, 5); assert.equal(result.sourceUrls.length, 40);
  assert.deepEqual(result.errors, []); assert.equal(result.usage.total_tokens, 75);
  assert.equal(result.usage.output_tokens_details.reasoning_tokens, 10); assert.equal(result.usageIncomplete, false);
});

test('completed Responses payload works without Chat [DONE] and annotations are valid evidence', async () => {
  const items = draft().items, resultPayload = payload(items, { checks: [{ id: 'K1', status: 'corrected', text: '校正文', citations: ['https://annotation.test'] }], annotations: [{ url_citation: { url: 'https://annotation.test' } }] });
  const result = await adapter(async () => sse(resultPayload, { done: false })).verify(draft());
  assert.equal(result.checks[0].status, 'corrected'); assert.equal(result.responseId, 'response-K1');
});

test('missing tool execution retries only to budget and never becomes verified', async () => {
  let calls = 0, delays = 0;
  const result = await adapter(async () => { calls++; return sse(payload(draft().items, { noCalls: true })); }, { sleep: async () => { delays++; } }).verify(draft());
  assert.equal(calls, 3); assert.equal(delays, 2); assert.equal(result.errors[0].code, 'search_not_executed');
  assert.equal(result.errors[0].attempts, 3); assert.equal(result.checks[0].status, 'unresolved');
});

test('citations cannot borrow a URL from another batch and empty text is never supported', async () => {
  const result = await adapter(async (_url, req) => {
    const items = inputItems(req);
    const checks = items.map(item => ({ id: item.id, status: 'supported', text: item.id === 'K3' ? ' ' : item.text,
      citations: [item.id === 'K2' ? 'https://source.test/K1' : item.id === 'K4' ? 'https://forged.test' : urlFor(item)] }));
    return sse(payload(items, { checks }));
  }, { batchSize: 1 }).verify(draft(4));
  assert.deepEqual(result.checks.map(check => check.status), ['supported', 'unresolved', 'unresolved', 'unresolved']);
  assert.deepEqual(result.checks[1].citations, []); assert.deepEqual(result.checks[3].citations, []);
});

test('invalid JSON retries that batch and counts known failed-attempt usage', async () => {
  let count = 0;
  const result = await adapter(async () => sse(payload(draft().items, ++count === 1 ? { id: 'first', text: '{broken' } : { id: 'second' }))).verify(draft());
  assert.equal(count, 2); assert.equal(result.batches[0].attempts, 2); assert.deepEqual(result.errors, []);
  assert.equal(result.usage.total_tokens, 30); assert.deepEqual(result.responseIds, ['first', 'second']);
  assert.equal(result.batches[0].attemptLog[0].code, 'invalid_model_json');
});

test('last failed batch retains earlier verified items and exposes unresolved items', async () => {
  const calls = [];
  const result = await adapter(async (_url, req) => {
    const items = inputItems(req); calls.push(items[0].id);
    if (items[0].id === 'K33') throw new TypeError('fetch failed');
    return sse(payload(items));
  }).verify(draft(40));
  assert.equal(result.checks.filter(check => check.status === 'supported').length, 32);
  assert.equal(result.checks.filter(check => check.status === 'unresolved').length, 8);
  assert.deepEqual(calls, ['K1', 'K9', 'K17', 'K25', 'K33', 'K33', 'K33']);
  assert.deepEqual(result.errors, [{ batch: 5, itemIds: draft(40).items.slice(32).map(item => item.id), code: 'network_error', attempts: 3 }]);
  assert.equal(result.usageIncomplete, true);
});

test('timeouts and temporary HTTP failures retry; configuration and authorization errors do not', async () => {
  for (const failure of [() => { throw new DOMException('deadline', 'TimeoutError'); }, () => new Response('{}', { status: 429 }), () => new Response('{}', { status: 503 })]) {
    let count = 0;
    const result = await adapter(async () => ++count === 1 ? failure() : sse(payload(draft().items))).verify(draft());
    assert.equal(count, 2); assert.equal(result.checks[0].status, 'supported');
  }
  for (const status of [400, 401, 403]) {
    let count = 0;
    await assert.rejects(adapter(async () => { count++; return new Response('{}', { status }); }).verify(draft()), { code: `upstream_${status}` });
    assert.equal(count, 1);
  }
  await assert.rejects(adapter(async () => Response.json({ error: { code: 'ToolNotOpen' } }, { status: 400 })).verify(draft()), { code: 'search_not_enabled' });
});

test('authorization failure after completed batches preserves evidence and halts all remaining requests', async () => {
  const calls = [];
  const result = await adapter(async (_url, req) => {
    const items = inputItems(req); calls.push(items[0].id);
    return items[0].id === 'K17' ? Response.json({ error: { code: 'Forbidden' } }, { status: 403 }) : sse(payload(items));
  }).verify(draft(40));
  assert.deepEqual(calls, ['K1', 'K9', 'K17']);
  assert.equal(result.checks.filter(check => check.status === 'supported').length, 16);
  assert.equal(result.checks.filter(check => check.status === 'unresolved').length, 24);
  assert.deepEqual(result.batches.map(batch => batch.status), ['completed', 'completed', 'failed', 'not_run', 'not_run']);
  assert.deepEqual(result.errors.map(failure => [failure.batch, failure.code, failure.attempts]), [[3, 'upstream_403', 1], [4, 'upstream_403', 0], [5, 'upstream_403', 0]]);
  assert.equal(result.batches[2].attemptLog[0].code, 'upstream_403');
  assert.deepEqual(result.batches[3].attemptLog, []);
  assert.equal(result.calls.length, 2); assert.equal(result.calls[1].action.sources[0].url, 'https://source.test/K9');
  assert.deepEqual(result.responseIds, ['response-K1', 'response-K9']);
  assert.equal(result.usage.total_tokens, 30); assert.equal(result.usageIncomplete, true);
});

test('stream errors, incomplete responses and absent terminal events never use partial text', async () => {
  const variants = [
    () => new Response(eventFrame('response.output_text.delta', { delta: JSON.stringify({ checks: [] }) }), { headers: { 'content-type': 'text/event-stream' } }),
    () => new Response(eventFrame('response.incomplete'), { headers: { 'content-type': 'text/event-stream' } }),
    () => new Response(eventFrame('response.failed'), { headers: { 'content-type': 'text/event-stream' } }),
    () => new Response(new ReadableStream({ pull(controller) { controller.error(new Error('connection reset')); } }), { headers: { 'content-type': 'text/event-stream' } }),
    () => new Response(eventFrame('error'), { headers: { 'content-type': 'text/event-stream' } })
  ];
  for (const response of variants) {
    const result = await adapter(async () => response(), { maxRetries: 0 }).verify(draft());
    assert.equal(result.errors.length, 1); assert.equal(result.checks[0].status, 'unresolved');
    assert.deepEqual(result.calls, []);
  }
});

test('duplicate, unknown and non-string check IDs fail instead of overwriting a result', async () => {
  for (const ids of [['K1', 'K1'], ['K1', 'other'], [1]]) {
    const result = await adapter(async () => sse(payload(draft().items, { checks: ids.map(id => ({ id, status: 'supported', text: 'claimed', citations: ['https://source.test/K1'] })) }))).verify(draft());
    assert.equal(result.errors[0].code, 'invalid_search_checks'); assert.equal(result.errors[0].attempts, 1);
    assert.equal(result.checks[0].status, 'unresolved');
  }
});

test('missing check IDs fail a batch and original order is restored for unordered results', async () => {
  const missing = await adapter(async () => sse(payload(draft(2).items, { checks: [{ id: 'K1', status: 'supported', text: 'valid', citations: ['https://source.test/K1'] }] })), { maxRetries: 0 }).verify(draft(2));
  assert.equal(missing.errors[0].code, 'search_incomplete');
  const result = await adapter(async () => sse(payload([...draft(2).items].reverse()))).verify(draft(2));
  assert.deepEqual(result.checks.map(check => check.id), ['K1', 'K2']);
});

test('total deadline stops later batches and retains completed batches', async () => {
  let now = 0, calls = 0;
  const result = await adapter(async (_url, req) => { calls++; now += 50; return sse(payload(inputItems(req))); }, { now: () => now, batchSize: 1, totalTimeoutMs: 75 }).verify(draft(4));
  assert.equal(calls, 2); assert.equal(result.checks[0].status, 'supported');
  assert.deepEqual(result.batches.map(batch => batch.status), ['completed', 'failed', 'not_run', 'not_run']);
  assert.ok(result.errors.every(failure => failure.code === 'search_budget_exceeded'));
  assert.deepEqual(result.errors.map(failure => failure.attempts), [1, 0, 0]);
});

test('retry delay cannot exceed remaining total budget', async () => {
  let calls = 0, sleeps = 0;
  const result = await adapter(async () => { calls++; throw new TypeError('fetch failed'); }, { totalTimeoutMs: 100, retryDelayMs: 200, sleep: async () => { sleeps++; } }).verify(draft());
  assert.equal(calls, 1); assert.equal(sleeps, 0); assert.equal(result.errors[0].code, 'search_budget_exceeded');
});

test('invalid config, duplicate input IDs and over-budget context fail before a paid request', async () => {
  for (const value of [-1, 0, 0.5, Infinity, 'garbage']) assert.throws(() => adapter(async () => {}, { batchSize: value }), { code: 'invalid_search_config' });
  let calls = 0;
  const search = adapter(async () => { calls++; return sse(payload(draft().items)); });
  await assert.rejects(search.verify({ title: 'empty', items: [] }), { code: 'invalid_draft' });
  await assert.rejects(search.verify({ ...draft(2), items: [draft().items[0], draft().items[0]] }), { code: 'invalid_draft_item' });
  const oversized = draft(8); oversized.items.forEach(item => { item.text = '文'.repeat(6000); });
  const result = await search.verify(oversized);
  assert.equal(result.errors[0].code, 'context_budget_exceeded'); assert.equal(calls, 0);
});

test('batch timeout interrupts a stalled reader before the terminal event', async () => {
  let cancelled = false;
  const search = adapter(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(eventFrame('response.output_text.delta', { delta: JSON.stringify({ checks: [] }) }))); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } }), { batchTimeoutMs: 10, maxRetries: 0 });
  const result = await search.verify(draft());
  assert.equal(result.errors[0].code, 'timeout'); assert.equal(result.checks[0].status, 'unresolved');
  assert.equal(cancelled, true);
});

test('completed response returns and cancels the reader even if the server keeps the connection open', async () => {
  let cancelled = false;
  const search = adapter(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(eventFrame('response.completed', { response: payload(draft().items) }))); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } }), { batchTimeoutMs: 100, maxRetries: 0 });
  const result = await search.verify(draft());
  assert.deepEqual(result.errors, []); assert.equal(result.checks[0].status, 'supported'); assert.equal(cancelled, true);
});

test('known tool execution survives malformed JSON in the attempt audit record', async () => {
  const result = await adapter(async () => sse(payload(draft().items, { text: '{bad' })), { maxRetries: 0 }).verify(draft());
  assert.equal(result.batches[0].attemptLog[0].calls[0].id, 'call-K1'); assert.deepEqual(result.calls, []);
});

test('Retry-After waits are bounded and oversized corrected text remains unresolved', async () => {
  let calls = 0; const waits = [];
  const result = await adapter(async () => ++calls === 1 ? new Response('{}', { status: 429, headers: { 'retry-after': '60' } }) : sse(payload(draft().items, { checks: [{ id: 'K1', status: 'supported', text: '文'.repeat(6001), citations: ['https://source.test/K1'] }] })), { sleep: async delay => { waits.push(delay); } }).verify(draft());
  assert.deepEqual(waits, [30000]); assert.equal(result.checks[0].status, 'unresolved'); assert.equal(result.checks[0].text, '原文1');
});

test('commentary text cannot contaminate final verification JSON', async () => {
  const resultPayload = payload(draft().items);
  resultPayload.output.unshift({ type: 'message', phase: 'commentary', content: [{ type: 'output_text', text: '正在搜索资料。' }] });
  const result = await adapter(async () => sse(resultPayload)).verify(draft());
  assert.equal(result.checks[0].status, 'supported');
});

test('stalled HTTP error bodies also obey the batch timeout', async () => {
  let cancelled = false;
  const result = await adapter(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 503 }), { maxRetries: 0, batchTimeoutMs: 10 }).verify(draft());
  assert.equal(result.errors[0].code, 'timeout'); assert.equal(cancelled, true);
});
