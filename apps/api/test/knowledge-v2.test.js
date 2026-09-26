import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalRepository } from '../src/repository.js';
import { SqliteRepository } from '../src/storage/sqlite-repository.js';
import { KnowledgeWorkspace } from '../src/knowledge/workspace-service.js';
import { conversationScope } from '../src/agent/memory.js';
import { StudyService } from '../src/study-service.js';
import { searchSavedItems } from '../src/knowledge/library.js';
import { ArkFeedbackProvider } from '../src/ark/feedback.js';
import { compactRuntime, guardContext } from '../src/agent/context-builder.js';
import { PhotoKnowledgeService } from '../src/knowledge/service.js';
import { ConversationMemory } from '../src/agent/memory.js';
import { startServer, testHash } from './helpers/http-server.js';
import { backupRuntime, restoreRuntime } from '../src/storage/runtime-backup.js';
import { readDatabaseFile } from '../src/storage/database-file.js';
import { exportKnowledge, restoreKnowledge } from '../src/knowledge/snapshot.js';
import { mergeKnowledge } from '../src/knowledge/merge.js';
import { readKnowledgePage } from '../src/knowledge/source-pages.js';
import { KnowledgeTools } from '../src/agent/knowledge-tools.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const scope = conversationScope({ appId: 'v2', chatType: 'group', chatId: 'g' });
const policy = { appId: 'v2', groupId: 'g', scopeKeys: [] };
const learner = { id: 'learner', role: 'learner' }, admin = { id: 'admin', role: 'admin' };
async function fixture(t, sqlite = false) {
  const folder = await mkdtemp(path.join(tmpdir(), '333-v2-'));
  const file = path.join(folder, sqlite ? 'data.sqlite' : 'data.json');
  const repo = sqlite ? new SqliteRepository(file, { knowledgePolicy: policy }) : new LocalRepository(file, { knowledgePolicy: policy });
  t.after(async () => { repo.close?.(); await rm(folder, { recursive: true, force: true }); });
  await repo.mutate(d => { d.photoKnowledge = { drafts: {}, events: [], documents: {
    'KP-11111111': { id: 'KP-11111111', scopeKey: scope.key, materialKind: 'textbook', currentVersion: 1, title: '教材', createdAt: '2026-09-01T00:00:00Z', revisions: [{ version: 1, confirmedBy: 'admin', items: [
      { id: 'B1', title: '第一章', text: '教学原则包括直观性与启发性。', evidenceStatus: 'unresolved', sourceAnchors: [{ documentId: 'KP-11111111', pdfPage: 5 }] },
      { id: 'B2', title: '另一个章节', text: '另一段有关课程的原文。', evidenceStatus: 'unresolved' }
    ] }] },
    'KP-22222222': { id: 'KP-22222222', scopeKey: scope.key, currentVersion: 1, title: '遗忘笔记', createdAt: '2026-09-02T00:00:00Z', revisions: [{ version: 1, confirmedBy: 'learner', items: [
      { id: 'P1', title: '教学原则', text: '个人遗忘笔记。', evidenceStatus: 'unresolved', citations: [] }
    ] }] }
  } }; });
  const data = await repo.read();
  return { repo, file, workspace: new KnowledgeWorkspace(repo), study: new StudyService(repo), book: data.knowledgePoints.find(p => p.sourceItemId === 'B1'), photo: data.knowledgePoints.find(p => p.sourceItemId === 'P1') };
}
async function approve(f) {
  return f.workspace.reviewAnswer(f.photo.id, { expectedVersion: 0, pointVersion: 1, reviewed: true, items: [{ text: '包括直观性与启发性。', evidence: [{ pointId: f.book.id, version: 1, quote: f.book.text }] }] }, admin);
}

test('body-only matches return the hit beyond the old prefix; short terms work', () => {
  const text = '这里是无关的教材背景。\n'.repeat(500) + '动机是激发和维持活动的因素。\n后续内容。';
  const result = searchSavedItems([{ id: 'a', title: '某章节', text }], '动机');
  assert.equal(result.length, 1); assert.match(result[0].text, /动机是激发/); assert.ok(result[0].truncated);
  assert.ok(result[0].text.length <= 2200);
  assert.equal(searchSavedItems([{ title: '某章节', text: '完全无关。' }], '动机').length, 0);
});

test('full backup restores SQLite learning history, reviewed answers and original assets', async t => {
  const f = await fixture(t, true); await approve(f);
  await f.study.startPractice(f.photo.id, learner.id);
  const folder = path.dirname(f.file), assetDir = path.join(folder, 'knowledge-library', 'KP-11111111');
  await mkdir(assetDir, { recursive: true }); await writeFile(path.join(assetDir, 'source.pdf'), '%PDF-fixture');
  const before = await readDatabaseFile(f.file), backupDir = path.join(folder, 'backup');
  await assert.rejects(backupRuntime({ databaseFile: f.file, outputDir: backupDir }), /stop_server/);
  await backupRuntime({ databaseFile: f.file, outputDir: backupDir, serverStopped: true });
  const restored = await restoreRuntime({ backupDir, outputDir: path.join(folder, 'restored') });
  assert.deepEqual(await readDatabaseFile(restored.databaseFile), before);
  assert.equal(await readFile(path.join(folder, 'restored', 'knowledge-library', 'KP-11111111', 'source.pdf'), 'utf8'), '%PDF-fixture');
  await writeFile(path.join(backupDir, 'database.json'), '{}');
  await assert.rejects(restoreRuntime({ backupDir, outputDir: path.join(folder, 'corrupt') }), /corrupt/);
});

test('portable V3 snapshot retains answers and relations but excludes personal enrollment', async t => {
  const f = await fixture(t, true); await approve(f);
  await f.workspace.enroll(f.book.id, learner);
  await f.workspace.addRelation(f.photo.id, { to: f.book.id, type: 'contrast', confirmed: true }, admin);
  await new ConversationMemory(f.repo).session(scope);
  const folder = path.dirname(f.file), outputDir = path.join(folder, 'export');
  await exportKnowledge({ databaseFile: f.file, outputDir, knowledgePolicy: policy });
  const dest = path.join(folder, 'restored-knowledge', 'data.sqlite');
  await restoreKnowledge({ snapshotDir: outputDir, databaseFile: dest });
  const restored = await readDatabaseFile(dest);
  assert.equal(restored.knowledgeV2.answers[f.photo.id][0].version, 1);
  assert.equal(restored.knowledgeV2.relations.length, 1);
  assert.deepEqual(restored.knowledgeV2.enrollments, {}); assert.deepEqual(restored.reviewLogs, []);
  const targetFile = path.join(folder, 'merge-target.sqlite'), initial = await readDatabaseFile(f.file);
  initial.knowledgeV2.answers = {}; initial.knowledgeV2.relations = [];
  const target = new SqliteRepository(targetFile, { knowledgePolicy: policy });
  try { await target.save(initial); } finally { target.close(); }
  const merge = await mergeKnowledge({ snapshotDir: outputDir, databaseFile: targetFile, apply: true, serverStopped: true, knowledgePolicy: policy });
  assert.equal(merge.applied, true);
  const merged = await readDatabaseFile(targetFile);
  assert.equal(merged.knowledgeV2.answers[f.photo.id][0].version, 1);
  assert.deepEqual(merged.knowledgeV2.enrollments, initial.knowledgeV2.enrollments);
  assert.deepEqual(merged.reviewStates, initial.reviewStates);
});

test('normal PDF source anchors resolve to the authenticated original, and graph cycles are rejected', async t => {
  const f = await fixture(t), folder = path.join(path.dirname(f.file), 'knowledge-library', 'KP-11111111');
  await mkdir(folder, { recursive: true }); await writeFile(path.join(folder, 'source.pdf'), '%PDF-fixture');
  const page = await readKnowledgePage(f.repo, 'KP-11111111', 5, { withType: true });
  assert.equal(page.mime, 'application/pdf'); assert.equal(page.bytes.toString(), '%PDF-fixture');
  await assert.rejects(readKnowledgePage(f.repo, 'KP-11111111', 6, { withType: true }), /不可访问/);
  const edge = await f.workspace.addRelation(f.photo.id, { to: f.book.id, type: 'prerequisite', confirmed: true }, admin);
  await assert.rejects(f.workspace.addRelation(f.book.id, { to: f.photo.id, type: 'prerequisite', confirmed: true }, admin), /循环/);
  await f.workspace.addRelation(f.photo.id, { deleteId: edge.id }, admin);
  assert.equal((await f.workspace.graph(f.photo.id)).edges.length, 0);
});

test('migration CLI dry-run leaves JSON unchanged and apply preserves IDs/history without activation', async t => {
  const f = await fixture(t); await approve(f); await f.study.startPractice(f.photo.id, learner.id);
  const before = await readFile(f.file), target = path.join(path.dirname(f.file), 'migration.sqlite');
  const cli = path.resolve('scripts/migrate-knowledge-v2.mjs'), run = promisify(execFile);
  const args = [cli, '--source', f.file, '--target', target];
  assert.equal(JSON.parse((await run(process.execPath, args)).stdout).apply, false);
  await assert.rejects(readFile(target), { code: 'ENOENT' });
  const applied = JSON.parse((await run(process.execPath, [...args, '--apply', '--server-stopped'])).stdout);
  assert.equal(applied.verified, true);
  assert.deepEqual(await readFile(f.file), before);
  assert.deepEqual(await readDatabaseFile(target), JSON.parse(before));
});

test('read-only tools enforce scope for point, excerpt and relation expansion', async t => {
  const f = await fixture(t); await approve(f);
  const denied = new KnowledgeTools(f.repo, { scopeKey: 'other' });
  await assert.rejects(denied.getKnowledgePoint(f.photo.id), /不可访问/);
  await assert.rejects(denied.getSourceExcerpt(f.photo.id), /不可访问/);
  await assert.rejects(denied.getKnowledgeRelations(f.photo.id), /不可访问/);
  assert.equal((await denied.searchKnowledge('教学')).hits.length, 0);
  const allowed = new KnowledgeTools(f.repo, { scopeKey: scope.key });
  assert.equal((await allowed.getKnowledgePoint(f.photo.id)).answerStatus, 'reviewed');
  await assert.rejects(allowed.getSourceExcerpt(f.photo.id, { version: 999 }), /已修订/);
});

for (const sqlite of [false, true]) test(`ID binding, snapshot versions and textbook enrollment (${sqlite ? 'sqlite' : 'json'})`, async t => {
  const f = await fixture(t, sqlite);
  assert.equal(f.book.practiceEligible, false); assert.equal(f.book.forgottenOn, null);
  assert.equal((await f.repo.read()).memoryEvents.filter(e => e.knowledgePointId === f.book.id).length, 0);
  await approve(f);
  const session = await f.study.startPractice(f.photo.id, 'web:learner');
  assert.equal(session.task.reference.answer.version, 1);
  assert.equal(session.task.reference.answer.evidence[0].sourceAnchors[0].pdfPage, 5);
  await f.repo.mutate(d => { const book = d.photoKnowledge.documents['KP-11111111']; book.revisions.push({ ...book.revisions[0], version: 2 }); book.currentVersion = 2; });
  assert.equal((await f.workspace.get(f.photo.id)).answerStatus, 'stale');
  assert.equal((await f.study.practiceSession(session.id, 'web:learner', f.photo.id)).task.reference.answer.evidence[0].version, 1);
  await assert.rejects(f.study.practiceSession(session.id, 'web:learner', f.book.id), /不匹配/);
  await assert.rejects(f.study.practiceSession(session.id, 'web:other', f.photo.id), /不匹配/);
  await assert.rejects(f.workspace.enroll(f.book.id, admin), /身份/);
  await f.workspace.enroll(f.book.id, learner);
  assert.equal((await f.study.getPracticeTask(f.book.id)).knowledgePointId, f.book.id);
  assert.equal((await f.repo.read()).memoryEvents.filter(e => e.knowledgePointId === f.book.id && e.type === 'forgotten_upload').length, 0);
});

test('answer review requires literal evidence, current revisions and optimistic version', async t => {
  const f = await fixture(t);
  await assert.rejects(f.workspace.reviewAnswer(f.photo.id, { expectedVersion: 0, pointVersion: 1, reviewed: true, items: [{ text: '编造', evidence: [{ pointId: f.book.id, version: 1, quote: '原文不存在' }] }] }, admin), /原文/);
  await approve(f); await assert.rejects(approve(f), /已变化/);
  const task = await f.study.getPracticeTask(f.photo.id); assert.equal(task.reference.knowledgePointId, f.photo.id);
  await f.study.saveAnswer({ knowledgePointId: f.photo.id, content: '回答', sourceId: 'same', taskSnapshot: task });
  await f.workspace.enroll(f.book.id, learner);
  await assert.rejects(f.study.saveAnswer({ knowledgePointId: f.book.id, content: '另一题', sourceId: 'same' }), /另一知识点/);
});

test('SQLite FTS respects scope before ranking and backups preserve learning rows', async t => {
  const f = await fixture(t, true);
  const hits = await f.repo.searchPoints('教学原则', { textbookOnly: true, scopeKey: scope.key });
  assert.equal(hits.length, 1); assert.equal(hits[0].id, f.book.id);
  assert.equal((await f.repo.searchPoints('教学原则', { scopeKey: 'foreign' })).length, 0);
  const before = await f.repo.read();
  const backup = path.join(path.dirname(f.file), 'backup.sqlite'); await f.repo.backup(backup);
  const restored = new SqliteRepository(backup, { knowledgePolicy: policy });
  try { const data = await restored.read(); assert.deepEqual(data.memoryEvents, before.memoryEvents); assert.deepEqual(data.reviewStates, before.reviewStates); }
  finally { restored.close(); }
});

test('local graph excludes archived points and random checks require reviewed enrolled points', async t => {
  const f = await fixture(t);
  await assert.rejects(f.workspace.spotCheck(learner), /暂无/); await approve(f);
  await f.workspace.addRelation(f.photo.id, { to: f.book.id, type: 'contrast', confirmed: true }, admin);
  assert.equal((await f.workspace.graph(f.photo.id)).nodes.length, 2);
  assert.equal((await f.workspace.spotCheck(learner)).id, f.photo.id);
  await assert.rejects(f.workspace.spotCheck(learner), /全部抽过/);
  await f.repo.mutate(d => { delete d.photoKnowledge.documents['KP-11111111']; });
  assert.equal((await f.workspace.graph(f.photo.id)).nodes.length, 1);
  assert.equal((await f.workspace.get(f.photo.id)).answerStatus, 'stale');
});

test('large dashboards never send reference bodies through compact runtime', () => {
  const summary = compactRuntime({ dashboard: { tasks: Array.from({ length: 1000 }, (_, i) => ({ title: `题${i}`, reference: { text: 'PRIVATE-REFERENCE'.repeat(10000) } })) } });
  assert.equal(summary.taskCount, 1000); assert.equal(summary.todayTasks.length, 5);
  assert.doesNotMatch(JSON.stringify(summary), /PRIVATE/);
  assert.throws(() => guardContext([{ content: '中'.repeat(30000) }]), e => e.code === 'context_budget_exceeded');
});

test('reviewed feedback checks all bound items, validates citations and does not search', async () => {
  const messages = [];
  const provider = new ArkFeedbackProvider({ apiKey: 'test', fetchImpl: async (_, opts) => {
    messages.push(JSON.parse(opts.body)); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ status: 'partial', reason: '缺少第二个要点。', answerQuote: '直观性', evidenceIds: ['E1'] }) } }] }));
  } });
  const task = { title: '教学原则', reference: { answer: { status: 'reviewed', version: 1, items: [{ id: 'A1', text: '直观与启发', evidenceIds: ['E1'] }], evidence: [{ id: 'E1', quote: '直观性与启发性。', title: '教材', sourceAnchors: [{ pdfPage: 5 }] }] } } };
  const result = await provider.reviewAnswer({ task, answer: '直观性' });
  assert.equal(result.details.checks[0].status, 'partial'); assert.match(result.feedback, /部分覆盖/);
  assert.match(messages[0].messages[1].content, /pdfPage/);
  task.reference.answer.items[0].evidenceIds = ['E2'];
  await assert.rejects(provider.reviewAnswer({ task, answer: '直观性' }), e => e.code === 'missing_bound_evidence');
});

test('photo comparison requires explicit textbook confirmation and pins source versions', async t => {
  const f = await fixture(t), memory = new ConversationMemory(f.repo), session = await memory.session(scope);
  const id = 'KP-33333333';
  await f.repo.mutate(d => { d.photoKnowledge.drafts[id] = { id, scopeKey: scope.key, sessionId: session.id, createdAt: '2026-09-02T00:00:00Z', versions: [], actions: [] }; });
  let internet = 0;
  const service = new PhotoKnowledgeService({ repository: f.repo, approverId: 'learner', search: { verify: () => { internet++; throw new Error(); } },
    model: { compareTextbook: async (item, sources) => ({ status: 'corrected', text: '教学原则包括直观性与启发性。', reason: '对照教材校正。', evidenceIds: [sources[0].id] }) } });
  await service.makeVersion(id, { title: '教学原则', items: [{ id: 'K1', title: '教学原则', text: '启法性' }], differences: [], queries: [] }, {});
  await service.delivered(scope, id, 1);
  const ordinary = await service.confirm(scope, { id, version: 1, senderId: 'learner', messageId: 'ordinary' });
  assert.equal(ordinary.ok, false); assert.equal(internet, 0);
  const result = await service.confirm(scope, { id, version: 1, senderId: 'learner', messageId: 'textbook', textbook: true, partial: true });
  assert.equal(result.ok, true);
  const item = (await f.repo.read()).photoKnowledge.documents[id].revisions[0].items[0];
  assert.equal(item.originalText, '启法性'); assert.equal(item.textbookEvidence[0].sourceAnchors[0].pdfPage, 5);
});

test('HTTP sessions ignore client supplied references and admin can maintain materials only', async t => {
  const f = await fixture(t);
  const server = await startServer(f.file, { FEISHU_APP_ID: 'v2', FEISHU_TEST_GROUP_ID: 'g', WEB_USERS: `tester:${testHash},admin:${testHash}`, WEB_ADMIN_USERS: 'admin' }); t.after(() => server.stop());
  const cookie = (await server.login()).headers.get('set-cookie').split(';')[0];
  const headers = { cookie, 'content-type': 'application/json' };
  const post = (route, body, h = headers) => fetch(server.url + route, { method: 'POST', headers: h, body: JSON.stringify(body) });
  const session = await (await post('/api/practice-sessions', { knowledgePointId: f.photo.id })).json();
  assert.equal(session.task.reference.text, '个人遗忘笔记。');
  await f.repo.mutate(d => { d.photoKnowledge.documents['KP-22222222'].revisions[0].items[0].text = '修订后的资料'; });
  const response = await post('/api/answer-attempts', { knowledgePointId: f.photo.id, practiceSessionId: session.id, content: '我的回忆', sourceId: 'web-test', taskSnapshot: { reference: { text: '伪造答案' } } });
  assert.equal(response.status, 202); assert.equal((await response.json()).job.taskSnapshot.reference.text, '个人遗忘笔记。');
  assert.equal((await post('/api/answer-attempts', { knowledgePointId: f.book.id, practiceSessionId: session.id, content: 'x' })).status, 409);
  const adminCookie = (await server.login('admin')).headers.get('set-cookie').split(';')[0]; const ah = { ...headers, cookie: adminCookie };
  for (const route of ['/api/practice-sessions', '/api/answer-attempts', '/api/reviews', '/api/knowledge-v2/spot-checks', `/api/knowledge-v2/points/${f.book.id}/enrollment`]) assert.equal((await post(route, {}, ah)).status, 403);
  assert.equal((await post('/api/knowledge-v2/search', { query: '教学原则' }, ah)).status, 200);
  assert.equal((await post(`/api/knowledge-v2/points/${f.photo.id}/relations`, { to: f.book.id, type: 'contrast', confirmed: true }, ah)).status, 200);
});
