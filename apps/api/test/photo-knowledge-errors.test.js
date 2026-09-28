import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalRepository } from '../src/repository.js';
import { conversationScope } from '../src/agent/memory.js';
import { PhotoKnowledgeService, errorCode, draftText } from '../src/knowledge/service.js';
import { PhotoKnowledgeModel } from '../src/knowledge/providers.js';
import { ArkFeedbackProvider, ArkFeedbackError } from '../src/ark/feedback.js';

test('knowledge error mapping preserves provider codes and rejects arbitrary upstream strings', () => {
  for (const code of ['timeout', 'network_error', 'invalid_response', 'empty_response', 'not_configured',
    'invalid_draft', 'invalid_draft_item', 'incomplete_ocr_pages', 'invalid_image', 'context_budget_exceeded',
    'search_provider_failed', 'invalid_search_checks', 'search_partial_failed', 'search_budget_exceeded',
    'stream_incomplete', 'stream_limit_exceeded', 'upstream_429', 'upstream_503']) {
    assert.equal(errorCode(new ArkFeedbackError(code)), code);
    assert.equal(errorCode(new Error(code)), code);
  }
  assert.equal(errorCode({ code: 'timeout', message: 'network_error' }), 'timeout');
  assert.equal(errorCode(new DOMException('The operation timed out', 'TimeoutError')), 'timeout');
  assert.equal(errorCode(new Error('upstream_503 with private response body')), 'processing_failed');
  assert.equal(errorCode(new Error('https://upstream.test/?api_key=SECRET')), 'processing_failed');
  assert.equal(errorCode(null), 'processing_failed');
});

const scope = conversationScope({ appId: 'error-tests', chatType: 'group', chatId: 'group' });
const content = { title: 'Notes', transcription: 'Original', differences: [], queries: [],
  items: [{ id: 'K1', title: 'One', text: 'Original', uncertain: false }] };
const images = [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/2Q==' } }];

async function setup(t, overrides = {}) {
  const folder = await mkdtemp(path.join(tmpdir(), '333-knowledge-errors-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const logs = [];
  const model = {
    recognize: async () => ({ data: { pages: [{ image: 1, text: 'Original' }] } }),
    align: async () => ({ data: structuredClone(content) }),
    revise: async () => ({ data: structuredClone(content) })
  };
  const search = { verify: async () => ({ checks: [{ id: 'K1', text: 'Original', status: 'supported', citations: ['https://source.test/a'] }] }) };
  const service = new PhotoKnowledgeService({ repository: new LocalRepository(path.join(folder, 'runtime.json')),
    model, search, approverId: 'learner', logger: { error: (...args) => logs.push(args) }, ...overrides });
  return { service, model, search, logs };
}

test('OCR failures log actionable diagnostics and preserve the successful earlier read', async t => {
  const f = await setup(t);
  f.model.recognize = async (_images, pass) => {
    if (pass === 2) throw new ArkFeedbackError('upstream_503');
    return { data: { pages: [{ text: 'first independent OCR' }] } };
  };
  const draft = await f.service.process(scope, { messageId: 'ocr-fail', senderId: 'learner' }, images);
  assert.equal(draft.error, 'upstream_503');
  assert.equal(draft.failedStage, 'ocr_2');
  assert.equal(draft.assets.length, 1);
  assert.equal(draft.reads.length, 1);
  assert.deepEqual(draft.versions, []);
  const log = f.logs[0][1];
  assert.equal(log.draftId, draft.id);
  assert.equal(log.failedStage, 'ocr_2');
  assert.match(log.message, /upstream_503/);
  assert.match(log.stack, /ArkFeedbackError/);
  assert.ok(log.elapsedMs >= 0);
});

test('search and revision errors remain diagnosable without losing the original version', async t => {
  const f = await setup(t);
  f.search.verify = async () => { throw new ArkFeedbackError('timeout'); };
  const draft = await f.service.process(scope, { messageId: 'search-fail', senderId: 'learner' }, images);
  assert.equal(draft.status, 'awaiting_confirmation');
  assert.equal(draft.versions[0].searchError, 'timeout');
  assert.equal(draft.versions[0].failedStage, 'verify');
  assert.match(draftText(draft), /timeout/);
  f.model.revise = async () => { throw new ArkFeedbackError('invalid_draft_item'); };
  await f.service.handleText(scope, { senderId: 'learner', messageId: 'revise-fail', content: `修改 ${draft.id} v1：补充文字` });
  const saved = await f.service.get(scope, draft.id);
  assert.equal(saved.versions.length, 1);
  assert.equal(saved.error, 'invalid_draft_item');
  assert.equal(saved.failedStage, 'revise');
  assert.deepEqual(f.logs.map(log => log[1].failedStage), ['verify', 'revise']);
});

test('diagnostics redact credentials and images; a broken logger does not replace a draft error', async t => {
  const f = await setup(t);
  f.model.align = async () => { throw new Error('Bearer SECRET api_key=PRIVATE data:image/jpeg;base64,/9j/2Q=='); };
  const draft = await f.service.process(scope, { messageId: 'redaction', senderId: 'learner' }, images);
  assert.equal(draft.error, 'processing_failed');
  assert.doesNotMatch(JSON.stringify(f.logs), /SECRET|PRIVATE|\/9j\/2Q==/);
  assert.equal(f.logs[0][1].failedStage, 'align');
  f.service.logger = { error() { throw new Error('logger unavailable'); } };
  const next = await f.service.process(scope, { messageId: 'logger-fail', senderId: 'learner' }, images);
  assert.equal(next.error, 'processing_failed');
  assert.equal(next.reads.length, 2);
});

test('complete SSE with malformed draft fields fails before search and preserves OCR', async t => {
  const invalid = [
    [{ items: [null] }, 'invalid_draft_item'],
    [{ differences: 'not an array' }, 'invalid_draft'],
    [{ differences: [{}] }, 'invalid_draft'],
    [{ queries: {} }, 'invalid_draft'],
    [{ queries: [null] }, 'invalid_draft']
  ];
  for (const [fields, expected] of invalid) {
    const f = await setup(t);
    let searches = 0;
    f.search.verify = async () => { searches++; throw new Error('must not search'); };
    const malformed = { ...structuredClone(content), ...fields };
    const wire = 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: JSON.stringify(malformed) }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n';
    const realModel = new PhotoKnowledgeModel(new ArkFeedbackProvider({ apiKey: 'offline-schema-test', fetchImpl: async () => new Response(wire) }));
    f.model.align = realModel.align.bind(realModel);
    const draft = await f.service.process(scope, { messageId: 'invalid-schema', senderId: 'learner' }, images);
    assert.equal(draft.error, expected);
    assert.equal(draft.failedStage, 'align');
    assert.equal(draft.status, 'failed');
    assert.equal(draft.assets.length, 1);
    assert.equal(draft.reads.length, 2);
    assert.deepEqual(draft.versions, []);
    assert.equal(searches, 0);
    assert.equal(f.logs[0][1].code, expected);
  }
});

test('null OCR pages report incomplete_ocr_pages instead of an unhelpful TypeError', async t => {
  const f = await setup(t);
  f.model.recognize = async () => ({ data: { pages: [null] } });
  const draft = await f.service.process(scope, { messageId: 'invalid-page', senderId: 'learner' }, images);
  assert.equal(draft.error, 'incomplete_ocr_pages');
  assert.equal(draft.failedStage, 'ocr_1');
  assert.equal(draft.assets.length, 1);
});
