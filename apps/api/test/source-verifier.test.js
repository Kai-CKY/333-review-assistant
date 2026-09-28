import test from 'node:test';
import assert from 'node:assert/strict';
import { SourcePhotoVerifier } from '../src/knowledge/source-verifier.js';
import { ArkKnowledgeSearch } from '../src/knowledge/search.js';

const scope = { key: 'scope-A' };
const content = (count = 1) => ({ title: '教育笔记', items: Array.from({ length: count }, (_, index) => ({ id: `S${index + 1}`, title: '课程标准', text: '课程标准是教材编写的依据。', uncertain: false })), queries: [] });
const book = (scopeKey = scope.key, version = 1) => ({ id: `BOOK-${scopeKey}`, scopeKey, materialKind: 'textbook', currentVersion: version,
  revisions: [{ version, title: '教材原本', confirmedBy: 'user', materialKind: 'textbook', items: [{ id: 'B1', title: '课程标准', text: '课程标准是教材编写、教学和评价的依据。', sourceAnchors: [{ documentId: `BOOK-${scopeKey}`, pdfPage: 12 }] }] }] });
const repository = (...books) => ({ read: async () => ({ photoKnowledge: { documents: Object.fromEntries(books.map(value => [value.id, value])) } }) });
const baseCheck = item => ({ id: item.id, status: 'unresolved', text: item.text, citations: [], reason: '旁注' });
const sse = payload => new Response(`data: ${JSON.stringify({ type: 'response.completed', response: payload })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
function searched(items, candidates = [], { noCalls = false } = {}) {
  return { id: `response-${items[0].id}`, model: 'test', status: 'completed', output: [
    ...(noCalls ? [] : [{ id: `call-${items[0].id}`, type: 'web_search_call', status: 'completed', action: { sources: [{ url: 'https://source.test' }] } }]),
    { type: 'message', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ checks: items.map(item => ({ ...baseCheck(item), status: 'supported', citations: candidates.length ? [] : ['https://source.test'],
      textbookMatches: candidates.filter(candidate => candidate.itemIds.includes(item.id)).map(candidate => ({ candidateId: candidate.candidateId, relation: 'supports', quote: '伪造quote不得采用', pageAnchors: [{ pdfPage: 999 }], reason: '原文对应' })) })) }) }] }
  ] };
}

test('same-scope textbook retrieval and web verification share one model request', async () => {
  let requests = 0;
  const sourceBook = book();
  const search = new ArkKnowledgeSearch({ apiKey: 'test', model: 'test', maxRetries: 0, fetchImpl: async (_url, request) => {
    requests++; const body = JSON.parse(request.body), input = JSON.parse(body.input);
    assert.equal(body.stream, true); assert.equal(input.textbookCandidates.length, 1);
    assert.equal(input.textbookCandidates[0].quote, sourceBook.revisions[0].items[0].text);
    assert.match(body.instructions, /不改写原稿/);
    return sse(searched(input.items, input.textbookCandidates));
  } });
  const verifier = new SourcePhotoVerifier({ repository: repository(sourceBook, book('scope-B')), search });
  const result = await verifier.verify(content(2), { scope });
  assert.equal(requests, 1); assert.equal(result.textbookStatus, 'available'); assert.equal(result.textbookMatches.length, 2);
  assert.equal(result.checks[0].status, 'supported');
  assert.equal(result.checks[0].textbookMatches[0].quote, sourceBook.revisions[0].items[0].text);
  assert.equal(result.checks[0].textbookMatches[0].pageAnchors[0].pdfPage, 12);
  assert.equal(result.checks[0].textbookMatches[0].sourceDocumentId, 'BOOK-scope-A');
  assert.equal(result.checks[0].textbookMatches[0].sourceVersion, 1);
});

test('missing or empty textbook content still attempts web verification normally', async () => {
  for (const repo of [repository(), repository({ ...book(), revisions: [{ version: 1, confirmedBy: 'user', items: [] }] }), repository(book('scope-B'))]) {
    let calls = 0;
    const verifier = new SourcePhotoVerifier({ repository: repo, search: { verify: async (input, options) => {
      calls++; assert.equal(options.mode, 'source'); assert.deepEqual(options.textbookCandidates, []); return { checks: input.items.map(baseCheck) };
    } } });
    const result = await verifier.verify(content(), { scope });
    assert.equal(calls, 1); assert.equal(result.textbookStatus, 'not_imported'); assert.deepEqual(result.checks[0].textbookMatches, []);
  }
});

test('injected search cannot fabricate textbook IDs, quotes, versions or anchors', async () => {
  const verifier = new SourcePhotoVerifier({ repository: repository(book()), search: { verify: async (input, options) => ({ checks: input.items.map(item => ({ ...baseCheck(item), textbookMatches: [
    { candidateId: 'invented', relation: 'supports', quote: '伪造' },
    { candidateId: options.textbookCandidates[0].candidateId, relation: 'supports', quote: '伪造', sourceVersion: 999, pageAnchors: [{ pdfPage: 999 }] }
  ] })) }) } });
  const result = await verifier.verify(content(), { scope });
  assert.equal(result.checks[0].textbookMatches.length, 1);
  assert.equal(result.checks[0].textbookMatches[0].sourceVersion, 1);
  assert.equal(result.checks[0].textbookMatches[0].quote, book().revisions[0].items[0].text);
  assert.equal(result.checks[0].textbookMatches[0].pageAnchors[0].pdfPage, 12);
});

test('discarded fabricated textbook matches cannot leave an unsupported success status', async () => {
  const verifier = new SourcePhotoVerifier({ repository: repository(book()), search: { verify: async input => ({ checks: input.items.map(item => ({ ...baseCheck(item), status: 'supported', textbookMatches: [{ candidateId: 'invented', relation: 'supports' }] })) }) } });
  const result = await verifier.verify(content(), { scope });
  assert.equal(result.checks[0].status, 'unresolved'); assert.deepEqual(result.checks[0].textbookMatches, []);
});

test('stale-version candidate IDs and absent scope cannot cross the evidence boundary', async () => {
  let oldCandidateId;
  const old = new SourcePhotoVerifier({ repository: repository(book()), search: { verify: async (input, options) => { oldCandidateId = options.textbookCandidates[0].candidateId; return { checks: input.items.map(baseCheck) }; } } });
  await old.verify(content(), { scope });
  const current = new SourcePhotoVerifier({ repository: repository(book(scope.key, 2)), search: { verify: async input => ({ checks: input.items.map(item => ({ ...baseCheck(item), textbookMatches: [{ candidateId: oldCandidateId, relation: 'supports' }] })) }) } });
  assert.deepEqual((await current.verify(content(), { scope })).checks[0].textbookMatches, []);
  await assert.rejects(current.verify(content()), { code: 'invalid_source_scope' });
});

test('source mode can verify 41 paragraphs while legacy still rejects more than 40', async () => {
  let calls = 0;
  const search = new ArkKnowledgeSearch({ apiKey: 'test', model: 'test', maxRetries: 0, fetchImpl: async (_url, request) => { calls++; const input = JSON.parse(JSON.parse(request.body).input); return sse(searched(input.items)); } });
  await assert.rejects(search.verify(content(41)), { code: 'invalid_draft' });
  const result = await new SourcePhotoVerifier({ repository: repository(), search }).verify(content(41), { scope });
  assert.equal(calls, 6); assert.equal(result.checks.length, 41); assert.equal(result.checks[40].id, 'S41');
});

test('oversized source batches split without truncating source paragraphs', async () => {
  const data = content(8); data.items.forEach(item => { item.text = '教'.repeat(6000); });
  const sizes = [];
  const search = new ArkKnowledgeSearch({ apiKey: 'test', model: 'test', maxRetries: 0, fetchImpl: async (_url, request) => {
    const input = JSON.parse(JSON.parse(request.body).input); sizes.push(input.items.length);
    assert.ok(input.items.every(item => item.text.length === 6000)); return sse(searched(input.items));
  } });
  const result = await new SourcePhotoVerifier({ repository: repository(), search }).verify(data, { scope });
  assert.deepEqual(sizes, [2, 2, 2, 2]); assert.equal(result.checks.length, 8); assert.deepEqual(result.errors, []);
});

test('textbook availability never bypasses required real web-search execution', async () => {
  const search = new ArkKnowledgeSearch({ apiKey: 'test', model: 'test', maxRetries: 0, fetchImpl: async (_url, request) => {
    const input = JSON.parse(JSON.parse(request.body).input); return sse(searched(input.items, input.textbookCandidates, { noCalls: true }));
  } });
  const result = await new SourcePhotoVerifier({ repository: repository(book()), search }).verify(content(), { scope });
  assert.equal(result.textbookStatus, 'available'); assert.equal(result.errors[0].code, 'search_not_executed');
  assert.equal(result.checks[0].status, 'unresolved'); assert.deepEqual(result.checks[0].textbookMatches, []);
});
