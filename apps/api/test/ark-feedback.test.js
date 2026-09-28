import test from 'node:test';
import assert from 'node:assert/strict';
import { ArkFeedbackError, ArkFeedbackProvider } from '../src/ark/feedback.js';

const task = { title: '教育的起源', prompt: '概括教育起源的主要观点。' };

test('Ark feedback provider uses the OpenAI-compatible chat endpoint', async () => {
  let request;
  const provider = new ArkFeedbackProvider({
    apiKey: 'ark-test-key',
    modelId: 'doubao-seed-2-1-turbo-260628',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3/',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({
        choices: [{ message: { content: '亮点：有核心观点。\n可补充：增加依据。\n下一步：补一个例子。' } }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });

  const result = await provider.reviewAnswer({ task, answer: '教育起源有多种观点。' });
  assert.equal(result.modelId, 'doubao-seed-2-1-turbo-260628');
  assert.match(result.feedback, /亮点/);
  assert.equal(request.url, 'https://ark.cn-beijing.volces.com/api/v3/chat/completions');
  assert.equal(request.options.headers.authorization, 'Bearer ark-test-key');
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, 'doubao-seed-2-1-turbo-260628');
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.service_tier, undefined);
  assert.equal(body.messages[1].role, 'user');
  assert.match(body.messages[1].content, /教育起源/);
});

test('Ark low-latency tier is opt-in while thinking stays explicitly controlled', async () => {
  let body;
  const provider = new ArkFeedbackProvider({
    apiKey: 'ark-test-key',
    thinking: 'enabled',
    tier: 'fast',
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: '可用' } }] }), { status: 200 });
    }
  });
  await provider.complete({ messages: [{ role: 'user', content: '测试' }] });
  assert.deepEqual(body.thinking, { type: 'enabled' });
  assert.equal(body.service_tier, 'fast');
});

test('Ark feedback provider rejects unavailable and malformed provider responses safely', async () => {
  const missing = new ArkFeedbackProvider({ apiKey: '', fetchImpl: async () => new Response() });
  await assert.rejects(
    () => missing.reviewAnswer({ task, answer: '内容' }),
    (error) => error instanceof ArkFeedbackError && error.code === 'not_configured'
  );

  const malformed = new ArkFeedbackProvider({
    apiKey: 'ark-test-key',
    fetchImpl: async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })
  });
  await assert.rejects(
    () => malformed.reviewAnswer({ task, answer: '内容' }),
    (error) => error instanceof ArkFeedbackError && error.code === 'empty_response'
  );

  const unsafeShape = new ArkFeedbackProvider({
    apiKey: 'ark-test-key',
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: '你的答案已评分并自动修改了复习计划。' } }]
    }), { status: 200 })
  });
  await assert.rejects(
    () => unsafeShape.reviewAnswer({ task, answer: '内容' }),
    (error) => error instanceof ArkFeedbackError && error.code === 'invalid_feedback'
  );
});

const encoder = new TextEncoder();
const event = value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
const delta = (content, finish_reason = null) => ({ choices: [{ index: 0, delta: { content }, finish_reason }] });
const messages = [{ role: 'user', content: '测试' }];
function sseResponse(text, bytewise = false) {
  const bytes = encoder.encode(text);
  const chunks = bytewise ? [...bytes].map(byte => new Uint8Array([byte])) : [bytes];
  let i = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (i === chunks.length) controller.close();
    else controller.enqueue(chunks[i++]);
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
const isCode = code => error => error instanceof ArkFeedbackError && error.code === code;

test('streamed completion preserves text and usage after finish, ignores reasoning and keeps its existing return contract', async () => {
  let request;
  const usage = { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 };
  const provider = new ArkFeedbackProvider({ apiKey: 'test', modelId: 'configured-model', fetchImpl: async (_url, options) => {
    request = JSON.parse(options.body);
    return sseResponse([
      event({ choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'PRIVATE REASONING' }, finish_reason: null }] }),
      event(delta('{"text":"课程 ')), event(delta('标准 😀"}')),
      event({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      event({ choices: [], usage }), event('[DONE]')
    ].join(''), true);
  } });
  const result = await provider.complete({ messages, stream: true, maxTokens: 10000 });
  assert.equal(request.stream, true);
  assert.deepEqual(request.stream_options, { include_usage: true });
  assert.deepEqual(result, { content: '{"text":"课程 标准 😀"}', modelId: 'configured-model', finishReason: 'stop', usage });
});

test('streamed completion rejects incomplete or erroneous streams even if accumulated JSON is valid', async t => {
  const cases = [
    ['missing DONE', event(delta('{}', 'stop')), 'stream_incomplete'],
    ['missing finish reason', event(delta('{}')) + event('[DONE]'), 'stream_incomplete'],
    ['unfinished frame', event(delta('{}')) + 'data: {"choices":', 'stream_incomplete'],
    ['malformed event JSON', event(delta('{}')) + event('{bad}') + event('[DONE]'), 'invalid_response'],
    ['upstream stream error', event(delta('{}')) + event({ error: { message: 'provider-private-details' } }), 'upstream_stream_error'],
    ['named error event', event(delta('{}', 'stop')) + 'event: error\ndata: [DONE]\n\n', 'upstream_stream_error'],
    ['empty output', event(delta('', 'stop')) + event('[DONE]'), 'empty_response'],
    ['invalid choice', event({ choices: [null] }) + event('[DONE]'), 'invalid_response']
  ];
  for (const [name, body, code] of cases) await t.test(name, async () => {
    const provider = new ArkFeedbackProvider({ apiKey: 'test', fetchImpl: async () => sseResponse(body) });
    await assert.rejects(provider.complete({ messages, stream: true }), error => {
      assert.doesNotMatch(error.message, /provider-private-details/);
      return isCode(code)(error);
    });
  });
});

test('streamed completion propagates non-stop finish reasons for the structured-output validator', async () => {
  const provider = new ArkFeedbackProvider({ apiKey: 'test', fetchImpl: async () => sseResponse(event(delta('{}', 'length')) + event('[DONE]')) });
  assert.equal((await provider.complete({ messages, stream: true })).finishReason, 'length');
});

test('streaming respects HTTP errors before parsing and reports body network failures', async () => {
  const upstream = new ArkFeedbackProvider({ apiKey: 'test', fetchImpl: async () => new Response('private provider body', { status: 503 }) });
  await assert.rejects(upstream.complete({ messages, stream: true }), isCode('upstream_503'));
  let reads = 0;
  const broken = new ArkFeedbackProvider({ apiKey: 'test', fetchImpl: async () => new Response(new ReadableStream({ pull(controller) {
    if (!reads++) controller.enqueue(encoder.encode(event(delta('{}', 'stop'))));
    else controller.error(new Error('connection lost'));
  } })) });
  await assert.rejects(broken.complete({ messages, stream: true }), isCode('network_error'));
});

test('an HTTP error cancels its unread response body without changing the upstream code', async () => {
  let canceled = false, signal;
  const provider = new ArkFeedbackProvider({ apiKey: 'test', fetchImpl: async (_url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({ cancel() { canceled = true; return new Promise(() => {}); } }), { status: 429 });
  } });
  await assert.rejects(provider.complete({ messages, stream: true }), isCode('upstream_429'));
  assert.equal(canceled, true);
  assert.equal(signal.aborted, false);
});

test('TimeoutError from fetch or body reads is normalized to timeout in either mode', async () => {
  for (const stream of [false, true]) {
    const fetchTimeout = new ArkFeedbackProvider({ apiKey: 'test', fetchImpl: async () => { throw new DOMException('deadline exceeded', 'TimeoutError'); } });
    await assert.rejects(fetchTimeout.complete({ messages, stream }), isCode('timeout'));
    const bodyTimeout = new ArkFeedbackProvider({ apiKey: 'test', fetchImpl: async () => new Response(new ReadableStream({
      pull(controller) { controller.error(new DOMException('deadline exceeded', 'TimeoutError')); }
    })) });
    await assert.rejects(bodyTimeout.complete({ messages, stream }), isCode('timeout'));
  }
});

test('timeout normalization permits 180 seconds and rejects empty or invalid values safely', () => {
  for (const timeoutMs of ['', '  ', null, NaN, 'invalid', 0, -1, Infinity, true, false, {}]) {
    assert.equal(new ArkFeedbackProvider({ timeoutMs }).timeoutMs, 180000);
  }
  assert.equal(new ArkFeedbackProvider({ timeoutMs: 180000 }).timeoutMs, 180000);
  assert.equal(new ArkFeedbackProvider({ timeoutMs: '600000' }).timeoutMs, 600000);
  assert.equal(new ArkFeedbackProvider({ timeoutMs: 600001 }).timeoutMs, 600000);
  assert.equal(new ArkFeedbackProvider({ timeoutMs: 1 }).timeoutMs, 1000);
});

test('180-second timeout covers a hanging SSE body, does not reset on tokens, and cancels reading', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let bodyController, canceled = false, settled = false;
  const provider = new ArkFeedbackProvider({ apiKey: 'test', timeoutMs: 180000, fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { bodyController = controller; controller.enqueue(encoder.encode(event(delta('{}')))); },
    cancel() { canceled = true; }
  })) });
  const pending = provider.complete({ messages, stream: true });
  pending.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(pending, isCode('timeout'));
  await new Promise(setImmediate);
  t.mock.timers.tick(60000);
  await new Promise(setImmediate);
  assert.equal(settled, false, 'the old 60-second ceiling must not abort this call');
  t.mock.timers.tick(50000);
  bodyController.enqueue(encoder.encode(event(delta(' '))));
  await new Promise(setImmediate);
  t.mock.timers.tick(70000);
  await rejected;
  assert.equal(canceled, true);
});

test('a stream completing after 110 seconds succeeds and clears its timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let bodyController, signal, canceled = false;
  const provider = new ArkFeedbackProvider({ apiKey: 'test', timeoutMs: 180000, fetchImpl: async (_url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({ start(controller) { bodyController = controller; }, cancel() { canceled = true; } }));
  } });
  const pending = provider.complete({ messages, stream: true });
  await new Promise(setImmediate);
  t.mock.timers.tick(110000);
  bodyController.enqueue(encoder.encode(event(delta('{}', 'stop')) + event('[DONE]')));
  assert.equal((await pending).content, '{}');
  assert.equal(canceled, true, 'DONE cancels the remaining transport without awaiting EOF');
  t.mock.timers.tick(180000);
  assert.equal(signal.aborted, false, 'the completed request timer must be cleared');
});

test('non-stream JSON body timeout remains timeout, rather than invalid_response', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let canceled = false;
  const provider = new ArkFeedbackProvider({ apiKey: 'test', timeoutMs: 1000, fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode('{"choices":')); }, cancel() { canceled = true; }
  })) });
  const rejected = assert.rejects(provider.complete({ messages }), isCode('timeout'));
  await new Promise(setImmediate);
  t.mock.timers.tick(1000);
  await rejected;
  assert.equal(canceled, true);
});
