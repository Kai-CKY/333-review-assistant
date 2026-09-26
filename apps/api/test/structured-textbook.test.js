import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { LocalRepository } from '../src/repository.js';
import { conversationScope } from '../src/agent/memory.js';
import { searchSavedItems, activeStudyPoints } from '../src/knowledge/library.js';
import { readKnowledgePage } from '../src/knowledge/source-pages.js';
import { exportKnowledge, restoreKnowledge } from '../src/knowledge/snapshot.js';
import { mergeKnowledge } from '../src/knowledge/merge.js';
import { startServer } from './helpers/http-server.js';

const scope = conversationScope({ appId: 'textbook-app', chatType: 'group', chatId: 'main' });
const policy = { appId: scope.appId, groupId: scope.chatId, scopeKeys: [] };
const id = 'KP-abc12345';
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), '333-structured-'));
  const repository = new LocalRepository(path.join(root, 'data.json'), { knowledgePolicy: policy });
  await repository.mutate(data => {
    data.agentMemory = { version: 1, streams: { [scope.key]: { scope, sessionId: 'source-session', archivedIds: [] } }, sessions: { 'source-session': { id: 'source-session', scopeKey: scope.key, events: [] } }, notes: {} };
    data.photoKnowledge = { schemaVersion: 1, documents: { [id]: { id, scopeKey: scope.key, materialKind: 'textbook', title: '导图教材', currentVersion: 2, createdAt: '2026-09-26T00:00:00Z',
      upgradesLegacy: { version: 1, contentHash: 'a'.repeat(64) }, revisions: [{ version: 2, title: '导图教材', confirmedBy: 'owner', contentHash: 'b'.repeat(64), sourceDraftId: id, savedAt: '2026-09-26T00:00:00Z', items: [
        { id: 'topic-1', title: '教育民主化', text: '教育民主化\n  要求\n    教育机会均等\n    师生关系民主化', evidenceStatus: 'unresolved', structureStatus: 'needs_review', sourceAnchors: [{ documentId: id, pdfPage: 20 }], qualityIssues: ['分支仍需核对'] }
      ] }] } }, drafts: { [id]: { id, scopeKey: scope.key, sessionId: 'source-session', status: 'saved', assets: [], versions: [{ version: 2 }], importProvenance: { archiveDir: path.join(root, 'knowledge-library', id) } } }, events: [] };
  });
  const dir = path.join(root, 'knowledge-library', id, 'structured-v1', 'pages');
  await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, '0020.jpg'), Buffer.from([255,216,255,217]));
  return { root, repository };
}

test('textbooks remain reference-only with page anchors; no fabricated forgotten event or learning state', async () => {
  const { repository } = await fixture(); const data = await repository.read();
  const point = data.knowledgePoints.find(p => p.sourceDocumentId === id);
  assert.equal(point.practiceEligible, false); assert.equal(point.forgottenOn, null); assert.equal(point.previouslyLearned, false);
  assert.equal(data.memoryEvents.filter(e => e.knowledgePointId === point.id).length, 0);
  assert.equal(data.reviewStates.filter(s => s.knowledgePointId === point.id).length, 0);
  assert.ok(!activeStudyPoints(data).includes(point));
  await assert.rejects(repository.recordReview({ knowledgePointId: point.id, rating: 'good' }));
  await assert.rejects(repository.saveAnswer({ knowledgePointId: point.id, content: 'test' }));
  const hits = searchSavedItems([point], '师生关系民主化');
  assert.equal(hits.length, 1); assert.equal(hits[0].sourceAnchors[0].pdfPage, 20);
  assert.equal(hits[0].structureStatus, 'needs_review');
});

test('original page is authenticated and restricted to visible source anchors', async t => {
  const { repository } = await fixture();
  assert.equal((await readKnowledgePage(repository, id, 20)).length, 4);
  await assert.rejects(readKnowledgePage(repository, id, 21));
  await assert.rejects(readKnowledgePage(repository, '../secret', 20));
  const server = await startServer(repository.filePath, { FEISHU_APP_ID: scope.appId, FEISHU_TEST_GROUP_ID: scope.chatId });t.after(()=>server.stop());
  const url = `${server.url}/api/knowledge-sources/${id}/pages/20`;
  assert.equal((await fetch(url)).status, 401);
  const cookie = (await server.login()).headers.get('set-cookie').split(';')[0];
  const result = await fetch(url, { headers: { cookie } }); assert.equal(result.status, 200);assert.equal(result.headers.get('content-type'),'image/jpeg');
  await repository.mutate(data => { data.photoKnowledge.documents[id].scopeKey = 'foreign'; });
  await assert.rejects(readKnowledgePage(repository, id, 20));
});

test('versioned snapshot upgrades only the exact known legacy revision with explicit flag and keeps history', async () => {
  const { root, repository } = await fixture(); const snapshotDir=path.join(root,'snapshot');
  await exportKnowledge({ databaseFile:repository.filePath,outputDir:snapshotDir,knowledgePolicy:policy });
  const manifest=JSON.parse(await readFile(path.join(snapshotDir,'manifest.json'),'utf8'));assert.equal(manifest.version,2);
  const targetRoot=await mkdtemp(path.join(tmpdir(),'333-upgrade-')),target=path.join(targetRoot,'data.json');
  await restoreKnowledge({ snapshotDir,databaseFile:target });
  const legacy=JSON.parse(await readFile(target,'utf8'));
  const doc=legacy.photoKnowledge.documents[id];delete doc.materialKind;doc.currentVersion=1;doc.revisions=[{...doc.revisions[0],version:1,contentHash:'a'.repeat(64),items:[{id:'old-page',title:'旧页',text:'乱序文字'}]}];
  legacy.photoKnowledge.drafts[id].versions=[{version:1}];legacy.reviewLogs=[{id:'preserve-history',knowledgePointId:'old-point',rating:'good'}];
  await writeFile(target,JSON.stringify(legacy));
  const denied=await mergeKnowledge({snapshotDir,databaseFile:target,knowledgePolicy:policy});assert.equal(denied.conflicts[0].reason,'structured_upgrade_requires_flag');
  const applied=await mergeKnowledge({snapshotDir,databaseFile:target,knowledgePolicy:policy,allowStructuredUpgrade:true,apply:true,serverStopped:true});
  assert.deepEqual(applied.upgraded,[id]);assert.equal(applied.applied,true);
  const after=JSON.parse(await readFile(target,'utf8'));assert.deepEqual(after.reviewLogs,legacy.reviewLogs);assert.equal(after.photoKnowledge.documents[id].revisions.length,2);
  assert.ok(after.knowledgePoints.filter(p=>p.sourceDocumentId===id&&!p.archived).every(p=>p.practiceEligible===false));
  const again=await mergeKnowledge({snapshotDir,databaseFile:target,knowledgePolicy:policy,allowStructuredUpgrade:true});assert.deepEqual(again.unchanged,[id]);assert.deepEqual(again.conflicts,[]);
  legacy.photoKnowledge.documents[id].revisions[0].contentHash='c'.repeat(64);await writeFile(target,JSON.stringify(legacy));
  const conflict=await mergeKnowledge({snapshotDir,databaseFile:target,knowledgePolicy:policy,allowStructuredUpgrade:true});assert.equal(conflict.conflicts[0].reason,'revision_conflict');
});
