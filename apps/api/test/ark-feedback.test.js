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
