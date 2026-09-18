import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { exportKnowledge, restoreKnowledge } from '../src/knowledge/snapshot.js';
import { conversationScope } from '../src/agent/memory.js';
import { LocalRepository } from '../src/repository.js';
import { PhotoKnowledgeService } from '../src/knowledge/service.js';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'knowledge-snapshot-'));
  const databaseFile = path.join(root, 'source', 'data.json'), outputDir = path.join(root, 'snapshot');
  const scope = conversationScope({ appId: 'app', chatType: 'group', chatId: 'group' });
  const image = Buffer.from('sample-image'), sha256 = createHash('sha256').update(image).digest('hex');
  const id = 'KP-1234abcd';
  const items = [{ id: 'R1', title: '学习', text: '待核验内容', evidenceStatus: 'unresolved', citations: [] }];
  const photoKnowledge = { schemaVersion: 1, drafts: { [id]: { id, scopeKey: scope.key, sessionId: 's1', status: 'saved', savedVersion: 2, reads: [{ raw: 'OCR-ORIGINAL' }], assets: [{ sha256, bytes: image.length }], versions: [{ version: 1 }, { version: 2 }], actions: ['approval'] } }, documents: { [id]: { id, scopeKey: scope.key, currentVersion: 2, revisions: [{ version: 1, items }, { version: 2, title: '知识', items, confirmedBy: 'user', evidenceStatus: 'unresolved' }] } }, events: [{ type: 'saved', id }] };
  await mkdir(path.join(root, 'source', 'knowledge-assets'), { recursive: true });
  await writeFile(path.join(root, 'source', 'knowledge-assets', sha256), image);
  await mkdir(path.join(root, 'source', 'knowledge-library', id), { recursive: true });
  await writeFile(path.join(root, 'source', 'knowledge-library', id, 'review.md'), 'archived original');
  const data = { photoKnowledge, knowledgePoints: [{ id: 'kp1', title: '题库定义' }], user: { name: 'PRIVATE-PROFILE' }, feishu: { token: 'SECRET-TOKEN' }, answerAttempts: [{ text: 'PRIVATE-ANSWER' }], reviewLogs: ['PRIVATE-PROGRESS'], agentMemory: { streams: { [scope.key]: { scope, sessionId: 's1' } }, sessions: { s1: { events: ['PRIVATE-CHAT'] } }, notes: { [scope.key]: ['PRIVATE-NOTE'] } } };
  await writeFile(databaseFile, JSON.stringify(data));
  return { root, databaseFile, outputDir, scope, id, photoKnowledge, sha256, image };
}

test('knowledge snapshot restores all revisions and images without exporting conversations or learner records', async () => {
  const f = await fixture();
  const result = await exportKnowledge(f);
  assert.equal(result.documents, 1); assert.equal(result.files, 2);
  const serialized = await readFile(path.join(f.outputDir, 'manifest.json'), 'utf8');
  assert.doesNotMatch(serialized, /PRIVATE-|SECRET-TOKEN/);
  assert.match(serialized, /OCR-ORIGINAL/);
  const target = path.join(f.root, 'restore', 'data.json');
  await restoreKnowledge({ snapshotDir: f.outputDir, databaseFile: target });
  const data = JSON.parse(await readFile(target, 'utf8'));
  assert.deepEqual(data.photoKnowledge, f.photoKnowledge);
  assert.deepEqual(data.agentMemory.sessions.s1.events, []);
  assert.deepEqual(await readFile(path.join(f.root, 'restore', 'knowledge-assets', f.sha256)), f.image);
  assert.equal(await readFile(path.join(f.root, 'restore', 'knowledge-library', f.id, 'review.md'), 'utf8'), 'archived original');
  const service = new PhotoKnowledgeService({ repository: new LocalRepository(target) });
  assert.match((await service.handleText(f.scope, { content: `知识库 ${f.id}` })).text, /待核验内容/);
  const other = conversationScope({ appId: 'app', chatType: 'group', chatId: 'other' });
  assert.match((await service.handleText(other, { content: `知识库 ${f.id}` })).text, /还没有/);
});

test('restore cannot overwrite a newer cloud database or import a corrupt image', async () => {
  const f = await fixture(); await exportKnowledge(f);
  await assert.rejects(() => restoreKnowledge({ snapshotDir: f.outputDir, databaseFile: f.databaseFile }), /destination_database_exists/);
  assert.match(await readFile(f.databaseFile, 'utf8'), /PRIVATE-CHAT/);
  await writeFile(path.join(f.outputDir, 'blobs', f.sha256), 'corrupt');
  const target = path.join(f.root, 'restore', 'data.json');
  await assert.rejects(() => restoreKnowledge({ snapshotDir: f.outputDir, databaseFile: target }), /snapshot_blob_corrupt/);
  await assert.rejects(() => access(target), /ENOENT/);
});

test('snapshot restore rejects escaping paths, preserves reset isolation and does not replay in-flight work', async () => {
  const f = await fixture();
  const data = JSON.parse(await readFile(f.databaseFile, 'utf8'));
  data.agentMemory.streams[f.scope.key].sessionId = 'reset-session';
  data.photoKnowledge.drafts[f.id].status = 'verifying';
  await writeFile(f.databaseFile, JSON.stringify(data));
  await exportKnowledge(f);
  const manifestFile = path.join(f.outputDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  const target = path.join(f.root, 'restore', 'data.json');
  manifest.files[0].path = 'knowledge-library/KP-1234abcd/../../escape';
  await writeFile(manifestFile, JSON.stringify(manifest));
  await assert.rejects(() => restoreKnowledge({ snapshotDir: f.outputDir, databaseFile: target }), /unsafe_snapshot_file/);
  await exportKnowledge(f);
  await restoreKnowledge({ snapshotDir: f.outputDir, databaseFile: target });
  const restored = JSON.parse(await readFile(target, 'utf8'));
  assert.equal(restored.photoKnowledge.drafts[f.id].status, 'interrupted');
  assert.equal(restored.agentMemory.streams[f.scope.key].sessionId, 'reset-session');
  assert.equal(restored.photoKnowledge.drafts[f.id].sessionId, 's1');
});
