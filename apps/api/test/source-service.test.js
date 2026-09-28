import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { LocalRepository } from '../src/repository.js';
import { SqliteRepository } from '../src/storage/sqlite-repository.js';
import { SourcePhotoService } from '../src/knowledge/source-service.js';
import { ClarificationService } from '../src/knowledge/clarifications.js';
import { conversationScope } from '../src/agent/memory.js';
import { ArkFeedbackProvider } from '../src/ark/feedback.js';
import { ArkKnowledgeSearch } from '../src/knowledge/search.js';
import { SourcePhotoModel } from '../src/knowledge/source-model.js';
import { SourcePhotoVerifier } from '../src/knowledge/source-verifier.js';
import { createGroupConversation } from '../src/feishu/group-conversation.js';
import { Readable } from 'node:stream';
import { referenceForPoint } from '../src/knowledge/references.js';

const scope = conversationScope({ appId: 'source-test', chatType: 'group', chatId: 'source-group' });
const learner = { id: 'learner', role: 'learner' };
const image = [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/2Q==' } }];
const message = id => ({ messageId: id, senderId: learner.id, createTime: Date.now() });
function content() {
  return { title: '教育笔记', transcription: '课程标准\n民主思潮【不清】', differences: ['第二行字形不清'], queries: ['课程标准'], items: [
    { id: 'K1', title: '课程标准', text: '课程标准', region: '图1第一行', uncertain: false, sourceRefs: [{ image: 1, lineStart: 1, lineEnd: 1 }] },
    { id: 'K2', title: '民主思潮', text: '民主思潮【不清】', region: '图1第二行', uncertain: true, sourceRefs: [{ image: 1, lineStart: 2, lineEnd: 2 }] }
  ] };
}
async function fixture(t, { sqlite = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'source-pipeline-'));
  const repository = new (sqlite ? SqliteRepository : LocalRepository)(path.join(directory, sqlite ? 'runtime.sqlite' : 'runtime.json'), { knowledgePolicy: { scopeKeys: [scope.key] } });
  t.after(async () => { repository.close?.(); await rm(directory, { recursive: true, force: true }); });
  const calls = [], logs = [];
  const model = {
    recognize: async (_images, pass) => { calls.push(`ocr_${pass}`); return { data: { pages: [{ image: 1, text: '课程标准\n民主思潮【不清】', annotations: [], uncertain: ['第二行'] }] } }; },
    align: async () => { calls.push('align'); return { data: content(), model: 'fixture' }; }
  };
  const verifier = { verify: async draft => { calls.push('verify'); return { textbookStatus: 'not_imported', errors: [], checks: draft.items.map(item => ({ id: item.id, status: 'supported', text: '不应覆盖原文的百科解释', citations: ['https://source.test'], textbookMatches: [] })) }; } };
  const service = new SourcePhotoService({ repository, model, verifier, logger: { error: (...args) => logs.push(args) } });
  return { repository, model, verifier, service, calls, logs };
}

test('source queue persists before any model work, runs once, and archives full original text without confirmation', async t => {
  const f = await fixture(t);
  const queued = await f.service.enqueue(scope, message('image'), image);
  assert.equal(queued.status, 'queued'); assert.deepEqual(f.calls, []);
  const duplicate = await f.service.enqueue(scope, message('image'), image);
  assert.equal(duplicate.id, queued.id); assert.equal(duplicate.duplicate, true);
  await Promise.all([f.service.processQueued(), f.service.processQueued()]);
  assert.deepEqual(f.calls, ['ocr_1', 'ocr_2', 'align', 'verify']);
  const data = await f.repository.read(), doc = data.photoKnowledge.documents[queued.id], revision = doc.revisions[0];
  assert.equal(doc.materialKind, 'source_note'); assert.equal(revision.archivedBy, 'system:source-restoration');
  assert.equal(revision.confirmedBy, undefined);
  assert.equal(revision.items.length, 2); assert.equal(revision.items[1].text, '民主思潮【不清】');
  assert.ok(revision.transcription.includes('课程标准'));
  assert.ok(revision.transcription.includes('【不清】'));
  assert.ok(revision.items.every(item => item.text !== item.verificationSuggestion.text));
  assert.equal(data.photoKnowledge.drafts[queued.id].versions[0].delivered, false);
  const points = data.knowledgePoints.filter(point => point.sourceDocumentId === doc.id);
  assert.equal(points.length, 2);
  assert.ok(points.every(point => point.practiceEligible === false && point.previouslyLearned === false && point.forgottenOn === null));
  assert.ok(!data.memoryEvents.some(event => points.some(point => point.id === event.knowledgePointId)));
  assert.equal(Object.values(data.photoClarifications.issues).filter(issue => issue.documentId === doc.id).length, 1);
  await f.service.processQueued(); assert.equal(f.calls.length, 4);
});

test('a slow model never prevents enqueueing the next image and the worker stays serial', async t => {
  const f = await fixture(t);
  let unlock; const pause = new Promise(resolve => { unlock = resolve; });
  let entered; const started = new Promise(resolve => { entered = resolve; });
  const recognize = f.model.recognize;
  f.model.recognize = async (...args) => { if (!f.calls.length) { entered(); await pause; } return recognize(...args); };
  await f.service.enqueue(scope, message('first'), image);
  const worker = f.service.processQueued(); await started;
  const next = await f.service.enqueue(scope, message('second'), image);
  assert.equal(next.status, 'queued');
  f.service.processQueued(); unlock(); await worker;
  assert.equal(f.calls.length, 8);
  assert.equal(Object.keys((await f.repository.read()).photoKnowledge.documents).length, 2);
});

test('restart resumes after a persisted first OCR without calling it again', async t => {
  const f = await fixture(t, { sqlite: true });
  const queued = await f.service.enqueue(scope, message('crash'), image);
  await f.repository.mutate(data => {
    const job = data.photoKnowledge.drafts[queued.id]; job.status = 'ocr_2'; job.stage = 'ocr_2'; job.runId = 'dead-process';
    job.reads = [{ data: { pages: [{ image: 1, text: '课程标准\n民主思潮【不清】', annotations: [] }] } }];
  });
  assert.deepEqual(await f.service.reconcile(), [queued.id]);
  await f.service.processQueued();
  assert.deepEqual(f.calls, ['ocr_2', 'align', 'verify']);
  assert.equal((await f.service.get(scope, queued.id)).status, 'saved');
});

test('alignment failure keeps assets and both OCR checkpoints; authorized retry only reruns remaining stages', async t => {
  const f = await fixture(t), align = f.model.align;
  f.model.align = async () => { throw Object.assign(new Error('stream failure'), { code: 'stream_incomplete' }); };
  const queued = await f.service.enqueue(scope, message('failure'), image); await f.service.processQueued();
  const failed = await f.service.get(scope, queued.id);
  assert.equal(failed.status, 'failed'); assert.equal(failed.failedStage, 'aligning'); assert.equal(failed.error, 'stream_incomplete');
  assert.equal(failed.assets.length, 1); assert.equal(failed.reads.length, 2);
  await assert.rejects(f.service.retry(queued.id, { id: 'admin', role: 'admin' }), { statusCode: 403 });
  f.model.align = align; await f.service.retry(queued.id, learner); await f.service.processQueued();
  assert.deepEqual(f.calls, ['ocr_1', 'ocr_2', 'align', 'verify']);
  assert.equal((await f.service.get(scope, queued.id)).status, 'saved');
});

test('network verification outage retains all source paragraphs and does not ask the learner to fix an API error', async t => {
  const f = await fixture(t);
  f.verifier.verify = async () => { throw Object.assign(new Error('upstream failed'), { code: 'upstream_503' }); };
  const queued = await f.service.enqueue(scope, message('outage'), image); await f.service.processQueued();
  const saved = await f.service.get(scope, queued.id);
  assert.equal(saved.status, 'saved'); assert.equal(saved.searchError, 'upstream_503');
  const data = await f.repository.read();
  assert.equal(data.photoKnowledge.documents[queued.id].revisions[0].items.length, 2);
  assert.deepEqual(Object.values(data.photoClarifications.issues).map(issue => issue.kind), ['ocr']);
});

test('user definitions persist beside the original and reach later reference snapshots without becoming reviewed truth', async t => {
  const f = await fixture(t);
  const queued = await f.service.enqueue(scope, message('define'), image); await f.service.processQueued();
  const clarification = new ClarificationService({ repository: f.repository, approverId: learner.id });
  const before = JSON.stringify((await f.repository.read()).photoKnowledge.documents[queued.id].revisions[0]);
  const invitation = await clarification.next(null, learner);
  await clarification.answer(invitation.invitation.id, { text: '这一处我想表达教育影响。', idempotencyKey: 'answer-1' }, learner);
  const data = await f.repository.read();
  assert.equal(JSON.stringify(data.photoKnowledge.documents[queued.id].revisions[0]), before);
  const point = data.knowledgePoints.find(point => point.sourceDocumentId === queued.id && point.sourceItemId === 'K2');
  assert.equal(point.userDefinedAnswers[0].text, '这一处我想表达教育影响。');
  assert.equal(point.pendingClarifications, 0); assert.equal(point.reviewedAnswer, null);
  assert.equal(referenceForPoint(point).userDefinedAnswers[0].provenance, 'user_defined');
  assert.equal(point.practiceEligible, false);
});

test('job listings and retries respect source visibility, and invalid assets are rejected before queuing', async t => {
  const f = await fixture(t);
  const own = await f.service.enqueue(scope, message('own'), image);
  const foreign = conversationScope({ appId: 'source-test', chatType: 'group', chatId: 'secret' });
  const hidden = await f.service.enqueue(foreign, message('foreign'), image);
  assert.deepEqual((await f.service.list(learner)).items.map(job => job.id), [own.id]);
  await assert.rejects(f.service.getVisible(hidden.id, learner), { statusCode: 404 });
  await assert.rejects(f.service.retry(hidden.id, learner), { statusCode: 404 });
  await assert.rejects(f.service.enqueue(scope, message('bad'), [{ image_url: { url: 'file:///secret.png' } }]), /invalid_image/);
  assert.equal(Object.keys((await f.repository.read()).photoKnowledge.drafts).length, 2);
});

test('rechecking after textbook import reuses OCR and preserves original content and user definitions', async t => {
  const f = await fixture(t);
  const queued = await f.service.enqueue(scope, message('later-textbook'), image); await f.service.processQueued();
  const clarification = new ClarificationService({ repository: f.repository });
  const invitation = await clarification.next(null, learner);
  await clarification.answer(invitation.invitation.id, { text: '用户补充内容', idempotencyKey: 'definition' }, learner);
  const before = (await f.repository.read()).photoKnowledge.documents[queued.id].revisions[0].transcription;
  f.verifier.verify = async draft => { f.calls.push('recheck'); return { textbookStatus: 'available', errors: [], checks: draft.items.map(item => ({ id: item.id, status: 'supported', text: '校勘建议', citations: [], textbookMatches: [{ sourceId: 'book-point', sourceVersion: 2, quote: '教材原文', pageAnchors: [{ pdfPage: 12 }] }] })) }; };
  await f.service.retry(queued.id, learner); await f.service.processQueued();
  const data = await f.repository.read(), revision = data.photoKnowledge.documents[queued.id].revisions[0];
  assert.equal(revision.transcription, before); assert.equal(revision.items[0].text, '课程标准');
  assert.equal(revision.items[0].textbookMatches[0].sourceVersion, 2);
  assert.equal(Object.values(data.photoClarifications.issues)[0].answer.text, '用户补充内容');
  assert.deepEqual(f.calls, ['ocr_1', 'ocr_2', 'align', 'verify', 'recheck']);
  assert.equal((await f.service.list(learner)).items[0].issueCount, 0);
});

test('real streaming adapters run the four-stage silent group pipeline and pin actual textbook evidence', async t => {
  const f = await fixture(t), sends = [], requests = [];
  const bookId = 'KP-12345678';
  await f.repository.mutate(data => { data.photoKnowledge ??= { drafts: {}, documents: {}, events: [] }; data.photoKnowledge.documents[bookId] = { id: bookId, scopeKey: scope.key, materialKind: 'textbook', currentVersion: 1,
    revisions: [{ version: 1, title: '教材', confirmedBy: 'reviewer', items: [{ id: 'T1', title: '课程标准', text: '课程标准是教学的依据。', sourceAnchors: [{ documentId: bookId, pdfPage: 12 }] }] }] }; });
  const stream = data => new Response('data: ' + JSON.stringify(data) + '\n\n');
  let chats = 0;
  const fetchImpl = async (url, request) => {
    const body = JSON.parse(request.body); requests.push(body); assert.equal(body.stream, true);
    if (url.endsWith('/chat/completions')) {
      const data = ++chats < 3 ? { pages: [{ image: 1, text: '课程标准\n民主思潮【不清】', annotations: [], uncertain: ['第二行'] }] } : content();
      return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: JSON.stringify(data) }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    }
    const input = JSON.parse(body.input); assert.equal(input.textbookCandidates.length, 1);
    const checks = input.items.map(item => ({ id: item.id, status: 'supported', text: '联网解释不能替换原文', citations: ['https://source.test'],
      textbookMatches: input.textbookCandidates.filter(c => c.itemIds.includes(item.id)).map(c => ({ candidateId: c.candidateId, relation: 'supports', quote: 'forged' })) }));
    return stream({ type: 'response.completed', response: { status: 'completed', id: 'source-verification', output: [
      { type: 'web_search_call', status: 'completed', action: { sources: [{ url: 'https://source.test' }] } },
      { type: 'message', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ checks }) }] }
    ] } });
  };
  const provider = new ArkFeedbackProvider({ apiKey: 'offline', fetchImpl });
  const service = new SourcePhotoService({ repository: f.repository, model: new SourcePhotoModel(provider),
    verifier: new SourcePhotoVerifier({ repository: f.repository, search: new ArkKnowledgeSearch({ apiKey: 'offline', model: 'offline', fetchImpl, maxRetries: 0 }) }) });
  const channel = { botIdentity: { openId: 'bot' }, send: async (...args) => { sends.push(args); return { messageId: 'sent' }; },
    rawClient: { im: { v1: { messageResource: { get: async () => ({ getReadableStream: () => Readable.from([Buffer.from('/9j/2Q==', 'base64')]) }) } } } } };
  const group = createGroupConversation({ repository: f.repository, provider, channel, chatId: scope.chatId, appId: scope.appId, yangyangOpenId: learner.id, logger: { warn() {} }, knowledgeService: service });
  await group({ ...message('actual-pipeline'), chatId: scope.chatId, rawContentType: 'image', resources: [{ type: 'image', fileKey: 'photo' }] });
  await service.processQueued();
  assert.equal(requests.length, 4); assert.deepEqual(sends, []);
  const data = await f.repository.read(), doc = Object.values(data.photoKnowledge.documents).find(d => d.materialKind === 'source_note');
  assert.ok(doc); assert.equal(doc.revisions[0].items[0].text, '课程标准');
  const match = doc.revisions[0].items[0].textbookMatches[0];
  assert.equal(match.quote, '课程标准是教学的依据。'); assert.equal(match.pageAnchors[0].pdfPage, 12);
  assert.equal(match.sourceDocumentId, bookId);
});

test('malformed OCR pages never become checkpoints and retry reruns that pass', async t => {
  const f = await fixture(t), recognize = f.model.recognize;
  f.model.recognize = async () => ({ data: { pages: [{ text: 'missing image id' }] } });
  const queued = await f.service.enqueue(scope, message('bad-pages'), image); await f.service.processQueued();
  const failed = await f.service.get(scope, queued.id);
  assert.equal(failed.error, 'incomplete_ocr_pages'); assert.equal(failed.reads.length, 0);
  f.model.recognize = recognize; await f.service.retry(queued.id, learner); await f.service.processQueued();
  assert.deepEqual(f.calls, ['ocr_1', 'ocr_2', 'align', 'verify']);
  assert.equal((await f.service.get(scope, queued.id)).status, 'saved');
});

test('legacy malformed second OCR checkpoint is discarded without repeating the valid first read', async t => {
  const f = await fixture(t);
  const queued = await f.service.enqueue(scope, message('legacy-bad-pages'), image);
  await f.repository.mutate(data => {
    const job = data.photoKnowledge.drafts[queued.id]; job.status = 'failed';
    job.reads = [{ data: { pages: [{ image: 1, text: '课程标准\n民主思潮【不清】' }] } }, { data: { pages: [{ image: 99, text: 'wrong page id' }] } }];
  });
  await f.service.retry(queued.id, learner); await f.service.processQueued();
  assert.deepEqual(f.calls, ['ocr_2', 'align', 'verify']);
  assert.equal((await f.service.get(scope, queued.id)).status, 'saved');
});

test('background failures retain bounded diagnostics with credentials and image data redacted', async t => {
  const f = await fixture(t);
  f.model.recognize = async () => { throw new Error('unexpected transport Bearer secret-token data:image/jpeg;base64,YWJjZA=='); };
  const queued = await f.service.enqueue(scope, message('diagnostic'), image); await f.service.processQueued();
  const diagnostic = f.logs[0][1];
  assert.equal(diagnostic.id, queued.id); assert.equal(diagnostic.stage, 'ocr_1');
  assert.match(diagnostic.message, /unexpected transport/); assert.match(diagnostic.stack, /source-service.test.js/);
  assert.ok(!JSON.stringify(diagnostic).includes('secret-token')); assert.ok(!JSON.stringify(diagnostic).includes('YWJjZA=='));
});
