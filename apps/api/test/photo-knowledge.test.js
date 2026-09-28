import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalRepository } from '../src/repository.js';
import { ConversationMemory, conversationScope } from '../src/agent/memory.js';
import { PhotoKnowledgeService } from '../src/knowledge/service.js';
import { PhotoKnowledgeModel, ArkKnowledgeSearch } from '../src/knowledge/providers.js';
import { FeishuSessionStore } from '../src/feishu/session-store.js';
import { createGroupConversation } from '../src/feishu/group-conversation.js';
import { Readable } from 'node:stream';

const scope = conversationScope({ appId: 'app', chatType: 'group', chatId: 'group-A' });
const images = [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/2Q==' } }];
const content = () => ({ title: '学记', transcription: '不陵节而施之谓孙', differences: ['孙/顺'], items: [{ id: 'K1', title: '循序渐进', text: '不陵节而施之谓孙', region: '图1', uncertain: true }], queries: ['学记 孙 原文'] });
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'photo-knowledge-'));
  const repository = new LocalRepository(path.join(dir, 'data.json'));
  const calls = [];
  const model = {
    recognize: async (input, pass) => { calls.push(`ocr${pass}`); assert.deepEqual(input, images); return { data: { pages: [{ image: 1, text: pass === 1 ? '孙' : '顺' }] }, model: 'test' }; },
    align: async (a, b) => { calls.push('align'); assert.notEqual(a.pages[0].text, b.pages[0].text); return { data: content() }; },
    revise: async (_draft, request) => { calls.push('revise'); return { data: { ...content(), items: [{ ...content().items[0], text: request }] } }; }
  };
  const search = { verify: async draft => { calls.push('search'); return { checks: draft.items.map(i => ({ id: i.id, status: 'supported', text: i.text, reason: '原文支持', citations: ['https://ctext.org/liji/xue-ji'] })) }; } };
  const service = new PhotoKnowledgeService({ repository, model, search, approverId: 'yangyang' });
  return { repository, service, model, search, calls };
}
const msg = { messageId: 'm1', senderId: 'yangyang' };

test('two independent reads precede alignment and real-search adapter; no implicit publication', async () => {
  const f = await fixture();
  const draft = await f.service.process(scope, msg, images);
  assert.deepEqual(f.calls, ['ocr1', 'ocr2', 'align', 'search']);
  const data = await f.repository.read();
  assert.equal(draft.status, 'awaiting_confirmation');
  assert.deepEqual(data.photoKnowledge.documents, {});
  assert.equal(data.knowledgePoints.length, 8, 'private study data is untouched');
  assert.equal(draft.assets.length, 1);
  assert.equal((await readFile(path.join(f.service.assetsDir, draft.assets[0].sha256))).length, 4);
  assert.doesNotMatch(JSON.stringify(data), /base64/);
  await f.service.process(scope, msg, images);
  assert.equal(f.calls.length, 4, 'event replay does not repeat paid calls');
});

test('sender, scope, delivery and version bind confirmation; restart preserves drafts and revisions', async () => {
  const f = await fixture(), d = await f.service.process(scope, msg, images);
  const confirm = args => f.service.confirm(scope, { id: d.id, version: 1, senderId: 'yangyang', messageId: 'confirm1', ...args });
  assert.equal((await confirm({ senderId: 'outsider' })).ok, false);
  assert.equal((await confirm({})).ok, false, 'not delivered');
  await f.service.delivered(scope, d.id, 1);
  assert.equal((await confirm({ version: 2 })).ok, false);
  const other = conversationScope({ appId: 'app', chatType: 'group', chatId: 'group-B' });
  assert.equal((await f.service.confirm(other, { id: d.id, version: 1, senderId: 'yangyang', messageId: 'x' })).ok, false);
  assert.equal((await confirm({})).ok, true);
  assert.equal((await confirm({})).ok, true);
  assert.equal((await f.repository.read()).photoKnowledge.documents[d.id].revisions.length, 1);
  const restarted = new PhotoKnowledgeService({ repository: new LocalRepository(f.repository.filePath), model: f.model, search: f.search, approverId: 'yangyang' });
  assert.equal((await restarted.get(scope, d.id)).savedVersion, 1);
});

test('natural advice becomes a new verified draft; stale confirmation cannot overwrite it', async () => {
  const f = await fixture(), d = await f.service.process(scope, msg, images);
  await f.service.delivered(scope, d.id, 1);
  await f.service.confirm(scope, { id: d.id, version: 1, senderId: 'yangyang', messageId: 'c1' });
  const revised = await f.service.handleText(scope, { senderId: 'yangyang', messageId: 'r1', content: '这里应该补充：孙的含义是循序渐进' });
  assert.equal(revised.draft.versions.length, 2);
  assert.equal((await f.repository.read()).photoKnowledge.documents[d.id].currentVersion, 1);
  assert.match((await f.service.handleText(scope, { senderId: 'yangyang', messageId: 'stale', content: `确认 ${d.id} v1` })).text, /旧版本/);
  await f.service.delivered(scope, d.id, 2);
  await f.service.handleText(scope, { senderId: 'yangyang', messageId: 'c2', content: `确认 ${d.id} v2` });
  const saved = (await f.repository.read()).photoKnowledge.documents[d.id];
  assert.equal(saved.currentVersion, 2); assert.equal(saved.revisions.length, 2);
  assert.match(saved.revisions[0].items[0].text, /不陵节/);
});

test('search outage, no evidence and missing source cannot become verified knowledge', async () => {
  const f = await fixture();
  f.search.verify = async () => { throw new Error('search_not_enabled'); };
  const d = await f.service.process(scope, msg, images);
  assert.equal(d.versions[0].searchError, 'search_not_enabled');
  await f.service.delivered(scope, d.id, 1);
  assert.equal((await f.service.confirm(scope, { id: d.id, version: 1, senderId: 'yangyang', messageId: 'c', partial: true })).ok, false);
  f.search.verify = async draft => ({ checks: [{ id: draft.items[0].id, status: 'supported', citations: [] }] });
  const revision = await f.service.handleText(scope, { senderId: 'yangyang', messageId: 'r', content: `重新核验 ${d.id} v1` });
  assert.equal(revision.draft.versions.at(-1).verification.checks[0].status, 'unresolved');
});

test('reset isolates old drafts and working context while same-scope explicit recall works', async () => {
  const f = await fixture(), memory = new ConversationMemory(f.repository), d = await f.service.process(scope, msg, images);
  await memory.append(scope, { type: 'turn', user: 'GROUP-SECRET', assistant: 'old' });
  await memory.remember(scope, '本群备注', 'note1');
  await memory.reset(scope);
  assert.deepEqual(await memory.history(scope), []);
  assert.equal((await memory.search(scope, 'GROUP-SECRET')).length, 1);
  assert.equal((await memory.notes(scope)).length, 1);
  assert.equal((await f.service.confirm(scope, { id: d.id, version: 1, senderId: 'yangyang', messageId: 'c' })).ok, false);
  for (const other of [conversationScope({ appId: 'app2', chatType: 'group', chatId: 'group-A' }), conversationScope({ appId: 'app', chatType: 'group', chatId: 'group-A', threadId: 'topic' }), conversationScope({ appId: 'app', chatType: 'p2p', chatId: 'group-A', senderId: 'yangyang' })]) {
    assert.deepEqual(await memory.history(other), []); assert.deepEqual(await memory.search(other, 'SECRET'), []); assert.deepEqual(await memory.notes(other), []);
    assert.equal(await f.service.get(other, d.id), null);
  }
});

test('private chat histories isolate sender, chat and thread, including asynchronous operations', async () => {
  const f = await fixture(), store = new FeishuSessionStore(f.repository);
  await store.withMessage({ chatId: 'dm1', threadId: 't1' }, async () => { await Promise.resolve(); await store.rememberConversationTurn({ openId: 'a', userText: 'PRIVATE-A', assistantText: 'secret' }); });
  assert.equal((await store.getConversationHistory('a', 'dm1', 't1')).length, 1);
  assert.deepEqual(await store.getConversationHistory('a', 'dm2', 't1'), []);
  assert.deepEqual(await store.getConversationHistory('b', 'dm1', 't1'), []);
  assert.deepEqual(await store.getConversationHistory('a', 'dm1', 't2'), []);
});

test('OCR passes contain only original images and reject truncated model JSON', async () => {
  const requests = [];
  const model = new PhotoKnowledgeModel({ complete: async req => { requests.push(req); return { content: '{"pages":[{"text":"RAW"}]}', finishReason: 'stop' }; } });
  await model.recognize(images, 1); await model.recognize(images, 2);
  assert.equal(requests[1].messages.length, 2);
  assert.equal(requests[1].stream, true);
  assert.doesNotMatch(JSON.stringify(requests[1]), /RAW/);
  model.provider.complete = async () => ({ finishReason: 'length', content: '{}' });
  await assert.rejects(() => model.recognize(images, 1), /incomplete/);
  model.provider.complete = async () => ({ content: '{}' });
  await assert.rejects(() => model.align({}, {}), /incomplete/);
});

test('web-search adapter requires actual tool execution and grounded citation URLs', async () => {
  let payload = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ checks: [{ id: 'K1', status: 'supported', text: 'valid', citations: ['https://fake.test'] }] }), annotations: [] }] }] };
  const search = new ArkKnowledgeSearch({ apiKey: 'test', model: 'model', maxRetries: 0, fetchImpl: async (_url, req) => { assert.equal(JSON.parse(req.body).store, false); assert.equal(JSON.parse(req.body).stream, true); return new Response('data: ' + JSON.stringify({ type: 'response.completed', response: payload }) + '\n\n', { headers: { 'content-type': 'text/event-stream' } }); } });
  assert.equal((await search.verify(content())).errors[0].code, 'search_not_executed');
  payload.output.unshift({ type: 'web_search_call', status: 'completed', action: { sources: [{ url: 'https://ctext.org' }] } });
  assert.equal((await search.verify(content())).checks[0].status, 'unresolved');
  payload.output[1].content[0].text = JSON.stringify({ checks: [{ id: 'K1', status: 'supported', text: 'valid', citations: ['https://ctext.org'] }] });
  assert.equal((await search.verify(content())).checks[0].status, 'supported');
});

test('group controller delivers whole draft, accepts confirmed revision, and does not cross chats', async () => {
  const f = await fixture(), sends = [];
  const channel = { send: async (...args) => { sends.push(args); return { messageId: `sent-${sends.length}` }; }, rawClient: { im: { v1: { messageResource: { get: async () => ({ getReadableStream: () => Readable.from([Buffer.from('/9j/2Q==', 'base64')]) }) } } } } };
  const handler = createGroupConversation({ repository: f.repository, provider: {}, channel, chatId: 'group-A', appId: 'app', yangyangOpenId: 'yangyang', logger: { warn() {} }, knowledgeService: f.service });
  await handler({ ...msg, chatId: 'group-A', rawContentType: 'image', resources: [{ type: 'image', fileKey: 'img' }] });
  const d = Object.values((await f.repository.read()).photoKnowledge.drafts)[0];
  assert.equal(d.versions[0].delivered, true);
  assert.ok(sends.some(s => s[1].text.includes(d.id)));
  await handler({ ...msg, messageId: 'edit-save', chatId: 'group-A', content: `修改并保存 ${d.id} v1：孙表示循序渐进`, rawContentType: 'text' });
  assert.equal((await f.repository.read()).photoKnowledge.documents[d.id].currentVersion, 2);
  const n = sends.length;
  await handler({ ...msg, chatId: 'group-B', content: '知识库' });
  assert.equal(sends.length, n);
});

test('restart marks in-flight job interrupted without repeating API calls', async () => {
  const f = await fixture();
  await f.repository.mutate(data => { data.photoKnowledge = { drafts: { x: { id: 'x', status: 'recognizing', reads: [] } }, documents: {}, events: [] }; });
  assert.equal(await f.service.reconcile(), 1);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.repository.read()).photoKnowledge.drafts.x.status, 'interrupted');
});
