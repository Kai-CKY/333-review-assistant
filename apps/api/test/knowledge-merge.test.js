import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { conversationScope } from '../src/agent/memory.js';
import { exportKnowledge } from '../src/knowledge/snapshot.js';
import { mergeKnowledge } from '../src/knowledge/merge.js';
import { startServer } from './helpers/http-server.js';

const scope = conversationScope({ appId: 'app', chatType: 'group', chatId: 'group' });
const policy = { appId: 'app', groupId: 'group', scopeKeys: [] };
const id = 'KP-1234abcd';
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), '333-merge-test-'));
  const sourceFile = path.join(root, 'source.json'), databaseFile = path.join(root, 'cloud', 'data.json'), snapshotDir = path.join(root, 'snapshot');
  const revision = { version: 1, title: '生物课程', confirmedBy: 'owner', savedAt: '2026-09-18T00:00:00Z', sourceDraftId: id, items: [{ id: 'R1', title: '课程性质', text: '待核验原文', evidenceStatus: 'unresolved', citations: [] }] };
  const source = { knowledgePoints: [{ id: 'demo', title: '演示', sourceLabel: '演示知识库' }], photoKnowledge: { schemaVersion: 1, documents: { [id]: { id, scopeKey: scope.key, currentVersion: 1, revisions: [revision] } }, drafts: { [id]: { id, scopeKey: scope.key, sessionId: 'local-session', status: 'saved', versions: [{ version: 1 }], assets: [], reads: [] } }, events: [] }, agentMemory: { streams: { [scope.key]: { scope, sessionId: 'local-session' } } } };
  await writeFile(sourceFile, JSON.stringify(source));
  const exported = await exportKnowledge({ databaseFile: sourceFile, outputDir: snapshotDir, knowledgePolicy: policy });
  assert.equal(exported.visibleSavedPoints, 1);
  assert.equal(JSON.parse(await readFile(sourceFile)).knowledgePoints.length, 1, 'export never writes the live source');
  await mkdir(path.dirname(databaseFile));
  const target = { schemaVersion: 4, user: { id: 'user', name: 'cloud-user' }, knowledgePoints: [{ id: 'demo', title: '演示', sourceLabel: '演示知识库' }], reviewStates: [{ knowledgePointId: 'demo', nextReviewOn: '2026-10-01' }], reviewLogs: [{ id: 'review-before-import' }], answerAttempts: [{ id: 'existing-answer' }], taskCompletionLogs: [{ id: 'existing-completion' }], agentMemory: { version: 1, streams: { [scope.key]: { scope, sessionId: 'cloud-session', archivedIds: [] } }, sessions: { 'cloud-session': { id: 'cloud-session', scopeKey: scope.key, events: [{ text: 'private-cloud-chat' }] } }, notes: { [scope.key]: [{ text: 'private-note' }] } } };
  await writeFile(databaseFile, JSON.stringify(target));
  return { root, databaseFile, snapshotDir, knowledgePolicy: policy, source, target };
}

test('dry-run is read-only; merge preserves cloud history, sessions and progress; repeat import is idempotent', async () => {
  const f = await fixture(); const before = await readFile(f.databaseFile, 'utf8');
  const preview = await mergeKnowledge(f);
  assert.deepEqual(preview.added, [id]); assert.equal(preview.visibleSavedPoints, 1);
  assert.equal(await readFile(f.databaseFile, 'utf8'), before);
  await assert.rejects(() => mergeKnowledge({ ...f, apply: true }), /stop_server/);
  const result = await mergeKnowledge({ ...f, apply: true, serverStopped: true });
  assert.equal(result.applied, true); assert.equal(await readFile(result.backup, 'utf8'), before);
  const after = JSON.parse(await readFile(f.databaseFile));
  for (const key of ['user', 'reviewLogs', 'answerAttempts', 'taskCompletionLogs']) assert.deepEqual(after[key], f.target[key]);
  assert.deepEqual(after.reviewStates.find(x => x.knowledgePointId === 'demo'), f.target.reviewStates[0]);
  assert.deepEqual(after.agentMemory.sessions['cloud-session'], f.target.agentMemory.sessions['cloud-session']);
  assert.deepEqual(after.agentMemory.notes, f.target.agentMemory.notes);
  assert.equal(after.agentMemory.streams[scope.key].sessionId, 'cloud-session');
  assert.notEqual(after.photoKnowledge.drafts[id].sessionId, 'cloud-session');
  const repeated = await mergeKnowledge({ ...f, apply: true, serverStopped: true });
  assert.deepEqual(repeated.unchanged, [id]); assert.deepEqual(repeated.added, []);
  const again = JSON.parse(await readFile(f.databaseFile));
  assert.deepEqual(again.reviewStates, after.reviewStates); assert.deepEqual(again.memoryEvents, after.memoryEvents);
});

test('newer or conflicting cloud revisions never get overwritten; unshared scope blocks apply', async () => {
  const f = await fixture();
  const blocked = await mergeKnowledge({ ...f, apply: true, serverStopped: true, knowledgePolicy: { scopeKeys: [] } });
  assert.equal(blocked.applied, false); assert.equal(blocked.conflicts[0].reason, 'not_visible_under_server_scope_policy');
  const cloud = { ...f.target, photoKnowledge: structuredClone(f.source.photoKnowledge) };
  cloud.photoKnowledge.documents[id].revisions[0].items[0].text = 'cloud-edited';
  await writeFile(f.databaseFile, JSON.stringify(cloud));
  const before = await readFile(f.databaseFile, 'utf8');
  const result = await mergeKnowledge({ ...f, apply: true, serverStopped: true });
  assert.equal(result.conflicts[0].reason, 'revision_conflict'); assert.equal(await readFile(f.databaseFile, 'utf8'), before);
  cloud.photoKnowledge.documents[id].currentVersion = 2;
  cloud.photoKnowledge.documents[id].revisions.push({ ...cloud.photoKnowledge.documents[id].revisions[0], version: 2 });
  await writeFile(f.databaseFile, JSON.stringify(cloud));
  const newer = await mergeKnowledge({ ...f, apply: true, serverStopped: true });
  assert.deepEqual(newer.retainedNewer, [id]);
  assert.equal(JSON.parse(await readFile(f.databaseFile)).photoKnowledge.documents[id].currentVersion, 2);
});

test('merged knowledge is served by authenticated Web API with source and uncertainty intact', async t => {
  const f = await fixture(); await mergeKnowledge({ ...f, apply: true, serverStopped: true });
  const server = await startServer(f.databaseFile, { FEISHU_APP_ID: 'app', FEISHU_TEST_GROUP_ID: 'group' });
  t.after(() => server.stop());
  const cookie = (await server.login()).headers.get('set-cookie').split(';')[0];
  const response = await fetch(server.url + '/api/knowledge-points', { headers: { cookie } });
  assert.equal(response.status, 200);
  const points = await response.json();
  assert.equal(points.length, 1); assert.equal(points[0].sourceDocumentId, id);
  assert.equal(points[0].evidenceStatus, 'unresolved'); assert.equal(points[0].title, '课程性质');
});
