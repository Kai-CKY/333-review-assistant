import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { ArkFeedbackProvider } from '../src/ark/feedback.js';
import { PhotoKnowledgeModel, ArkKnowledgeSearch } from '../src/knowledge/providers.js';
import { PhotoKnowledgeService } from '../src/knowledge/service.js';
import { LocalRepository } from '../src/repository.js';
import { conversationScope } from '../src/agent/memory.js';
import { createGroupConversation } from '../src/feishu/group-conversation.js';

const scope = conversationScope({ appId: 'pipeline-app', chatType: 'group', chatId: 'pipeline-group' });
const originalBytes = Buffer.from('/9j/2Q==', 'base64');
const images = [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${originalBytes.toString('base64')}` } }];
const photoMessage = { messageId: 'photo-1', senderId: 'learner', chatId: scope.chatId, rawContentType: 'image', resources: [{ type: 'image', fileKey: 'photo-key' }] };
const draftContent = () => ({
  title: '教育笔记：四十个知识点',
  transcription: '完整笔记内容：不陵节而施之谓孙。',
  differences: ['第 1 条原文的孙、顺有识读分歧'],
  items: Array.from({ length: 40 }, (_, index) => ({ id: `K${index + 1}`, title: `知识点 ${index + 1}`, text: `第 ${index + 1} 条教育笔记原文。`, region: `图 1 第 ${index + 1} 行`, uncertain: false })),
  queries: ['教育 知识点 原文']
});

function sseEvent(value, eventName = '') {
  return `${eventName ? `event: ${eventName}\r\n` : ''}data: ${JSON.stringify(value)}\r\n\r\n`;
}

// HTTP chunks deliberately split SSE lines, JSON tokens and Chinese UTF-8 bytes.
function streamingResponse(body) {
  const bytes = new TextEncoder().encode(body);
  let position = 0, chunkIndex = 0;
  const sizes = [1, 7, 13, 2, 37, 5, 61];
  return new Response(new ReadableStream({
    pull(controller) {
      if (position >= bytes.length) return controller.close();
      const end = Math.min(bytes.length, position + sizes[chunkIndex++ % sizes.length]);
      controller.enqueue(bytes.slice(position, end));
      position = end;
    }
  }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}

function chatResponse(value, { interrupted = false } = {}) {
  const content = JSON.stringify(value);
  let wire = ': transport heartbeat\r\n\r\n';
  wire += sseEvent({ choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
  for (let offset = 0; offset < content.length; offset += 41) {
    wire += sseEvent({ choices: [{ index: 0, delta: { content: content.slice(offset, offset + 41) }, finish_reason: null }] });
  }
  if (!interrupted) {
    wire += sseEvent({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    wire += sseEvent({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 180, total_tokens: 300 } });
    wire += 'data: [DONE]\r\n\r\n';
  }
  return streamingResponse(wire);
}

function searchResponse(items, index, unresolvedIds) {
  const source = `https://example.edu/education/batch-${index}`;
  const checks = items.map(item => ({ id: item.id, status: unresolvedIds.has(item.id) ? 'unresolved' : 'supported', text: item.text, reason: unresolvedIds.has(item.id) ? '缺少直接证据' : '实际检索来源支持', citations: unresolvedIds.has(item.id) ? [] : [source] }));
  const outputText = JSON.stringify({ checks });
  const call = { id: `search-call-${index}`, type: 'web_search_call', status: 'completed', action: { type: 'search', query: '教育 笔记', sources: [{ url: source }] } };
  const message = { id: `result-${index}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: outputText, annotations: [{ type: 'url_citation', url: source, start_index: 0, end_index: 4 }] }] };
  const response = { id: `response-${index}`, model: 'mock-search', status: 'completed', output: [call, message], usage: { input_tokens: 80, output_tokens: 100, total_tokens: 180 } };
  let wire = sseEvent({ type: 'response.created', response: { id: response.id, status: 'in_progress', output: [] } }, 'response.created');
  wire += sseEvent({ type: 'response.output_item.added', output_index: 0, item: { ...call, status: 'in_progress' } }, 'response.output_item.added');
  wire += sseEvent({ type: 'response.output_item.done', output_index: 0, item: call }, 'response.output_item.done');
  wire += sseEvent({ type: 'response.output_item.added', output_index: 1, item: { ...message, status: 'in_progress', content: [] } }, 'response.output_item.added');
  for (let offset = 0; offset < outputText.length; offset += 53) {
    wire += sseEvent({ type: 'response.output_text.delta', output_index: 1, content_index: 0, item_id: message.id, delta: outputText.slice(offset, offset + 53) }, 'response.output_text.delta');
  }
  wire += sseEvent({ type: 'response.output_item.done', output_index: 1, item: message }, 'response.output_item.done');
  wire += sseEvent({ type: 'response.completed', response }, 'response.completed');
  return streamingResponse(wire);
}

async function fixture(t, { alignFailure, unresolvedIds = ['K40'], failSearchCall = 0, failSearchStatus = 500 } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'photo-streaming-pipeline-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repository = new LocalRepository(path.join(dir, 'runtime.json'));
  const requests = { chat: [], search: [] }, sends = [], logs = [];
  const state = { unresolvedIds: new Set(unresolvedIds), failSearchCall };
  const fetchImpl = async (url, request) => {
    const payload = JSON.parse(request.body);
    assert.equal(payload.stream, true, 'the complete photo pipeline must use streaming requests');
    if (url.endsWith('/chat/completions')) {
      requests.chat.push(payload);
      const number = requests.chat.length;
      if (number <= 2) return chatResponse({ pages: [{ image: 1, title: '学记', text: number === 1 ? '不陵节而施之谓孙' : '不陵节而施之谓顺', annotations: [], uncertain: [] }] });
      assert.equal(number, 3, 're-verification must reuse existing OCR and alignment');
      if (alignFailure === 'timeout') {
        return new Response(new ReadableStream({
          start(controller) {
            const abort = () => controller.error(new DOMException('Fixture body aborted', 'AbortError'));
            if (request.signal.aborted) abort();
            else request.signal.addEventListener('abort', abort, { once: true });
          }
        }), { headers: { 'content-type': 'text/event-stream' } });
      }
      return chatResponse(draftContent(), { interrupted: alignFailure === 'interrupted' });
    }
    assert.ok(url.endsWith('/responses'), `unexpected offline request endpoint: ${url}`);
    assert.equal(payload.store, false);
    const input = JSON.parse(payload.input);
    requests.search.push(input);
    const number = requests.search.length;
    if (number === state.failSearchCall) return Response.json({ error: { code: failSearchStatus === 403 ? 'Forbidden' : 'InternalError' } }, { status: failSearchStatus });
    return searchResponse(input.items, number, state.unresolvedIds);
  };
  const provider = new ArkFeedbackProvider({ apiKey: 'offline-fixture', modelId: 'mock-pro', fetchImpl, timeoutMs: alignFailure === 'timeout' ? 1000 : 180000 });
  const model = new PhotoKnowledgeModel(provider);
  const search = new ArkKnowledgeSearch({ apiKey: 'offline-fixture', model: 'mock-search', fetchImpl, maxRetries: 0 });
  const service = new PhotoKnowledgeService({ repository, model, search, approverId: 'learner', logger: { error: (...args) => logs.push(args) } });
  const channel = {
    send: async (...args) => { sends.push(args); return { messageId: `delivered-${sends.length}` }; },
    rawClient: { im: { v1: { messageResource: { get: async () => ({ getReadableStream: () => Readable.from([originalBytes]) }) } } } }
  };
  const handler = createGroupConversation({ repository, provider, channel, chatId: scope.chatId, appId: scope.appId, yangyangOpenId: 'learner', logger: { warn() {} }, knowledgeService: service });
  return { repository, service, handler, requests, state, sends, logs };
}

const currentDraft = async f => Object.values((await f.repository.read()).photoKnowledge.drafts)[0];
const confirm = (f, draft, args = {}) => f.service.confirm(scope, { id: draft.id, version: draft.versions.at(-1).version, senderId: 'learner', messageId: 'manual-confirm', partial: true, ...args });

test('streamed photo pipeline completes independent OCR, alignment, five search batches, delivery and explicit partial confirmation', async t => {
  const f = await fixture(t);
  await f.handler(photoMessage);
  const draft = await currentDraft(f), version = draft.versions[0];
  assert.equal(draft.status, 'awaiting_confirmation');
  assert.equal(draft.reads.length, 2);
  assert.notEqual(draft.reads[0].data.pages[0].text, draft.reads[1].data.pages[0].text);
  assert.deepEqual(f.requests.chat.slice(0, 2).map(r => r.messages[1].content), [images, images], 'both OCR passes receive original images only');
  assert.deepEqual(JSON.parse(f.requests.chat[2].messages[1].content), { first: draft.reads[0].data, second: draft.reads[1].data });
  assert.equal(draft.reads[0].usage.completion_tokens, 180);
  assert.deepEqual(f.requests.search.map(r => r.items.length), [8, 8, 8, 8, 8]);
  assert.deepEqual(f.requests.search.flatMap(r => r.items.map(i => i.id)), draftContent().items.map(i => i.id));
  assert.equal(version.content.items.length, 40);
  assert.equal(version.verification.checks.length, 40);
  assert.equal(version.verification.calls.length, 5);
  assert.equal(version.searchError, undefined);
  assert.equal(version.delivered, true);
  assert.ok(version.messageIds.length > 1, 'the whole 40-item draft is delivered in chunks');
  assert.ok(f.sends.map(call => call[1].text).join('').includes('知识点 40'));
  assert.ok(f.sends.every(call => call[0] === scope.chatId && call[2].replyTo === photoMessage.messageId));
  assert.deepEqual((await f.repository.read()).photoKnowledge.documents, {}, 'model completion and delivery never publish knowledge');
  await f.handler({ ...photoMessage, rawContentType: 'text', resources: [], messageId: 'manual-confirm', content: `确认已核验部分 ${draft.id} v1` });
  const saved = (await f.repository.read()).photoKnowledge.documents[draft.id];
  assert.equal(saved.currentVersion, 1);
  assert.equal(saved.revisions[0].items.length, 39);
  assert.deepEqual(saved.revisions[0].excludedIds, ['K40']);
  assert.equal(saved.revisions[0].confirmedBy, 'learner');
  assert.equal(saved.revisions[0].confirmationMessageId, 'manual-confirm');
  assert.deepEqual(await readFile(path.join(f.service.assetsDir, draft.assets[0].sha256)), originalBytes);
  const paid = f.requests.chat.length + f.requests.search.length;
  await f.handler(photoMessage);
  await f.handler({ ...photoMessage, rawContentType: 'text', resources: [], messageId: 'manual-confirm', content: `确认已核验部分 ${draft.id} v1` });
  assert.equal(f.requests.chat.length + f.requests.search.length, paid, 'replayed photo and confirmation repeat no paid work');
  assert.equal((await f.repository.read()).photoKnowledge.documents[draft.id].revisions.length, 1);
});

test('streamed re-verification preserves old saved revision and obeys sender, scope, version and delivery gates without duplicate paid work', async t => {
  const f = await fixture(t);
  const initial = await f.service.process(scope, photoMessage, images);
  assert.equal((await confirm(f, initial)).ok, false, 'undelivered draft cannot be confirmed');
  await f.service.delivered(scope, initial.id, 1);
  assert.equal((await confirm(f, initial, { senderId: 'another-user' })).ok, false);
  const otherScope = conversationScope({ appId: scope.appId, chatType: 'group', chatId: 'another-group' });
  assert.equal((await f.service.confirm(otherScope, { id: initial.id, version: 1, senderId: 'learner', messageId: 'cross-scope', partial: true })).ok, false);
  assert.equal((await confirm(f, initial, { version: 2 })).ok, false);
  assert.equal((await confirm(f, initial)).ok, true);
  const originalRevision = structuredClone((await f.repository.read()).photoKnowledge.documents[initial.id].revisions[0]);
  const command = { senderId: 'learner', messageId: 'recheck-1', content: `重新核验 ${initial.id} v1` };
  await f.service.handleText(otherScope, command);
  await f.service.handleText(scope, { ...command, senderId: 'another-user' });
  assert.equal(f.requests.search.length, 5, 'unauthorized or cross-scope rechecks do not call the provider');
  f.state.unresolvedIds.clear();
  const result = await f.service.handleText(scope, command);
  assert.equal(result.draft.versions.length, 2);
  assert.equal(result.draft.versions[1].delivered, false);
  assert.equal(f.requests.chat.length, 3, 'recheck does not rerun OCR or alignment');
  assert.equal(f.requests.search.length, 10);
  let saved = (await f.repository.read()).photoKnowledge.documents[initial.id];
  assert.equal(saved.currentVersion, 1);
  assert.deepEqual(saved.revisions, [originalRevision]);
  assert.equal((await confirm(f, result.draft, { messageId: 'confirm-new' })).ok, false, 'new version must be delivered first');
  await f.service.delivered(scope, initial.id, 2);
  assert.equal((await confirm(f, result.draft, { version: 1, messageId: 'stale-confirm' })).ok, false);
  assert.equal((await confirm(f, result.draft, { messageId: 'confirm-new' })).ok, true);
  await f.service.handleText(scope, command);
  await confirm(f, result.draft, { messageId: 'confirm-new' });
  assert.equal(f.requests.search.length, 10, 'replayed re-verification cannot start another paid run');
  saved = (await f.repository.read()).photoKnowledge.documents[initial.id];
  assert.equal(saved.currentVersion, 2);
  assert.equal(saved.revisions.length, 2);
  assert.equal(saved.revisions[1].items.length, 40);
  assert.deepEqual(saved.revisions[0], originalRevision);
});

test('a failed middle search batch retains successful evidence and excludes failed items from partial publication', async t => {
  const f = await fixture(t, { unresolvedIds: [], failSearchCall: 3 });
  await f.handler(photoMessage);
  const draft = await currentDraft(f), version = draft.versions[0];
  assert.equal(draft.status, 'awaiting_confirmation');
  assert.equal(version.searchError, 'search_partial_failed');
  assert.equal(version.failedStage, 'verify');
  assert.equal(version.verification.calls.length, 4);
  assert.equal(version.verification.errors.length, 1);
  assert.deepEqual(version.verification.errors[0].itemIds, Array.from({ length: 8 }, (_, i) => `K${17 + i}`));
  assert.equal(f.requests.search.length, 5, 'subsequent batches continue after one recoverable failure');
  assert.equal(version.verification.checks.filter(c => c.status === 'supported').length, 32);
  assert.deepEqual(version.verification.checks.filter(c => c.status === 'unresolved').map(c => c.id), Array.from({ length: 8 }, (_, i) => `K${17 + i}`));
  assert.ok(version.verification.checks.filter(c => c.status === 'supported').every(c => c.citations.length > 0));
  assert.equal((await confirm(f, draft, { partial: false })).ok, false, 'ordinary confirmation cannot silently omit failed items');
  assert.equal((await confirm(f, draft)).ok, true);
  const saved = (await f.repository.read()).photoKnowledge.documents[draft.id].revisions[0];
  assert.equal(saved.items.length, 32);
  assert.deepEqual(saved.excludedIds, Array.from({ length: 8 }, (_, i) => `K${17 + i}`));
  assert.ok(f.logs.some(args => args[1]?.failedStage === 'verify'));
});

test('permanent failure after successful batches stops requests but preserves evidence for authorized partial confirmation', async t => {
  const f = await fixture(t, { unresolvedIds: [], failSearchCall: 3, failSearchStatus: 403 });
  await f.handler(photoMessage);
  const draft = await currentDraft(f), version = draft.versions[0];
  const supportedIds = Array.from({ length: 16 }, (_, i) => `K${i + 1}`);
  const excludedIds = Array.from({ length: 24 }, (_, i) => `K${i + 17}`);
  assert.equal(draft.status, 'awaiting_confirmation');
  assert.equal(version.delivered, true);
  assert.equal(version.searchError, 'search_partial_failed');
  assert.equal(version.failedStage, 'verify');
  assert.equal(f.requests.search.length, 3, 'permanent authorization failure stops subsequent requests');
  assert.equal(version.verification.calls.length, 2);
  assert.deepEqual(version.verification.checks.filter(c => c.status === 'supported').map(c => c.id), supportedIds);
  assert.deepEqual(version.verification.checks.filter(c => c.status === 'unresolved').map(c => c.id), excludedIds);
  assert.ok(version.verification.checks.filter(c => c.status === 'supported').every(c => c.citations.length > 0));
  assert.ok(version.verification.errors.some(error => error.code === 'upstream_403'));
  assert.deepEqual((await f.repository.read()).photoKnowledge.documents, {}, 'successful earlier batches are retained as draft evidence only');
  assert.equal((await confirm(f, draft, { partial: false })).ok, false);
  assert.equal((await confirm(f, draft, { senderId: 'another-user' })).ok, false);
  await f.handler({ ...photoMessage, rawContentType: 'text', resources: [], messageId: 'partial-after-fatal', content: `确认已核验部分 ${draft.id} v1` });
  const saved = (await f.repository.read()).photoKnowledge.documents[draft.id].revisions[0];
  assert.deepEqual(saved.items.map(item => item.id), supportedIds);
  assert.deepEqual(saved.excludedIds, excludedIds);
  assert.equal(saved.confirmedBy, 'learner');
  assert.equal(saved.confirmationMessageId, 'partial-after-fatal');
  assert.equal(f.requests.search.length, 3, 'confirmation does not retry the failed search');
});

for (const failure of ['interrupted', 'timeout']) {
  test(`align ${failure} preserves original asset and two OCR reads without publishing a partial draft`, async t => {
    const f = await fixture(t, { alignFailure: failure });
    const draft = await f.service.process(scope, photoMessage, images);
    assert.equal(draft.status, 'failed');
    assert.equal(draft.failedStage, 'align');
    if (failure === 'timeout') assert.equal(draft.error, 'timeout');
    else assert.equal(draft.error, 'stream_incomplete');
    assert.equal(draft.reads.length, 2);
    assert.equal(draft.assets.length, 1);
    assert.equal(draft.versions.length, 0);
    assert.deepEqual(await readFile(path.join(f.service.assetsDir, draft.assets[0].sha256)), originalBytes);
    assert.equal(f.requests.search.length, 0);
    assert.deepEqual((await f.repository.read()).photoKnowledge.documents, {});
    assert.ok(f.logs.some(args => args[1]?.failedStage === 'align' && args[1]?.draftId === draft.id));
    await f.service.process(scope, photoMessage, images);
    assert.equal(f.requests.chat.length, 3, 'event replay keeps the preserved failed draft without automatically paying again');
  });
}
