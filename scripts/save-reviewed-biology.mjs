import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { LocalRepository } from '../apps/api/src/repository.js';
import { ConversationMemory, conversationScope } from '../apps/api/src/agent/memory.js';
import { PhotoKnowledgeService } from '../apps/api/src/knowledge/service.js';

// One-off owner-authorized import. This does not relax the Feishu confirmation gate.
if (!process.argv.includes('--confirmed-as-is')) throw new Error('Explicit owner authorization to archive unverified text is required.');
if (!process.env.FEISHU_APP_ID || !process.env.FEISHU_TEST_GROUP_ID) throw new Error('Configured destination group is required.');
let serverOnline = false;
try { serverOnline = (await fetch(`http://127.0.0.1:${process.env.PORT || 3333}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch {}
if (serverOnline) throw new Error('Stop the project server before importing to avoid concurrent JSON writers.');
const file = path.resolve(process.env.DATA_FILE || '.data/review-assistant.json');
const repository = new LocalRepository(file);
const scope = conversationScope({ appId: process.env.FEISHU_APP_ID.trim(), chatType: 'group', chatId: process.env.FEISHU_TEST_GROUP_ID.trim() });
const text = await readFile('docs/photo-ocr-test-2026-09-18-biology/reviewed-transcription.md', 'utf8');
const source = JSON.parse(await readFile('.data/knowledge-test/biology-2026-09-18/latest-draft.json', 'utf8'));
const id = source.id;
const body = text.split('## Codex 独立联网核验摘要')[0];
const matches = [...body.matchAll(/^(\d+)\. \*\*([^\n]+)\*\*\s*$/gm)];
if (matches.length !== 10) throw new Error('Expected the reviewed ten-section transcript.');
const now = new Date().toISOString();
const confirmation = { channel: 'codex', actor: 'project-user', threadId: '01a0ad03-ab23-7dd2-b108-02faffa6f82b', instruction: '先这样保存到知识库吧', at: now, mode: 'save_as_is_with_uncertainty', yangyangConfirmed: false };
const statusNotice = '【用户确认存档；整页尚未核验通过，疑字保留。不是已认证标准答案。】';
const citations = {
  5: ['https://www.moe.gov.cn/jyb_xwfb/xw_fbh/moe_2069/xwfbh_2018n/xwfb_20180116/sfcl/201801/t20180116_324664.html'],
  7: ['https://www.moe.gov.cn/srcsite/A26/jcj_kcjcgh/200106/t20010608_167343.html'],
  8: ['https://www.pep.com.cn/xw/zt/rjwy/gzkb2020/202205/P020220517519140545267.pdf']
};
const items = matches.map((m, index) => ({ id: `R${m[1]}`, title: m[2], text: `${statusNotice}\n${body.slice(m.index + m[0].length, matches[index + 1]?.index ?? body.length).trim()}`, region: `原图第${m[1]}题`, uncertain: ![6, 7].includes(Number(m[1])), citations: citations[m[1]] || [], evidenceStatus: 'unresolved', sourceNote: citations[m[1]] ? '链接只支持本条部分要点；不能据此认定整条已核验。详见归档文字稿。' : '待核验' }));
const contentHash = createHash('sha256').update(text).digest('hex');
const previous = await repository.read();
const existing = previous.photoKnowledge?.documents?.[id];
if (existing) {
  if (existing.revisions.at(-1)?.contentHash !== contentHash || existing.scopeKey !== scope.key) throw new Error('Existing document differs; do not overwrite.');
  console.log(JSON.stringify({ id, alreadySaved: true, items: existing.revisions.at(-1).items.length }));
  process.exit(0);
}
if (Object.values(previous.photoKnowledge?.drafts || {}).some(d => ['recognizing', 'aligning', 'verifying', 'revising'].includes(d.status))) throw new Error('Active photo job; import aborted.');
const backupDir = path.join(path.dirname(file), 'backups');
await mkdir(backupDir, { recursive: true });
await copyFile(file, path.join(backupDir, `before-biology-import-${now.replace(/[:.]/g, '-')}.json`));
const archiveDir = path.join(path.dirname(file), 'knowledge-library', id);
await mkdir(archiveDir, { recursive: true });
await writeFile(path.join(archiveDir, 'reviewed-v1.md'), text, { mode: 0o600 });
await writeFile(path.join(archiveDir, 'source-test-draft.json'), JSON.stringify(source, null, 2), { mode: 0o600 });
await copyFile('.data/knowledge-test/biology-2026-09-18/search-probe/verification.json', path.join(archiveDir, 'partial-search-verification.json'));
const assetsDir = path.join(path.dirname(file), 'knowledge-assets');
await mkdir(assetsDir, { recursive: true });
for (const asset of source.assets) {
  const bytes = await readFile(path.join('.data/knowledge-test/biology-2026-09-18/knowledge-assets', asset.sha256));
  if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error('Source image hash mismatch.');
  await writeFile(path.join(assetsDir, asset.sha256), bytes, { mode: 0o600 });
}
const session = await new ConversationMemory(repository).session(scope);
const content = { title: '第一章 中学生物学课程（用户确认存档·待核验）', transcription: text, differences: ['采用Codex与豆包对照后的整理稿；保留原图疑点。', '本次为项目用户在Codex明确授权按现状保存，不代表羊羊在飞书确认或整页核验通过。'], items, queries: [] };
const revision = { version: 1, title: content.title, items, contentHash, confirmedBy: 'codex-project-user', confirmation, confirmationMessageId: 'codex:biology:save-as-is:2026-09-18', sourceDraftId: id, sourceMessageId: 'codex:photo:14fabc90-28ad-4141-ae73-43946a269528', savedAt: now, excludedIds: [], evidenceStatus: 'unresolved', saveMode: confirmation.mode };
await repository.mutate(data => {
  const state = data.photoKnowledge ??= { schemaVersion: 1, drafts: {}, documents: {}, events: [] };
  if (state.documents[id] || state.drafts[id]) throw new Error('Import ID already in use.');
  state.documents[id] = { id, scopeKey: scope.key, title: content.title, currentVersion: 1, createdAt: now, revisions: [revision] };
  state.drafts[id] = { id, scopeKey: scope.key, sessionId: session.id, sourceMessageId: revision.sourceMessageId, senderId: 'codex-project-user', status: 'saved', savedVersion: 1, createdAt: now, reads: source.reads, assets: source.assets, actions: [revision.confirmationMessageId], importProvenance: { sourceTestDraftId: source.id, confirmation, archiveDir }, versions: [{ version: 1, content, verification: { checks: items.map(i => ({ id: i.id, status: 'unresolved', text: i.text, reason: i.sourceNote, citations: i.citations })) }, change: { kind: 'owner_confirmed_archive_import' }, createdAt: now, contentHash, delivered: true, deliveryChannel: 'codex', deliveredAt: now, messageIds: [] }] };
  state.events.push({ type: 'knowledge_archived_by_owner', id, version: 1, scopeKey: scope.key, confirmation, at: now });
});
const service = new PhotoKnowledgeService({ repository });
const readback = await service.handleText(scope, { content: `知识库 ${id}` });
if (!readback?.text.includes(statusNotice) || !readback.text.includes('生物学')) throw new Error('Knowledge readback failed.');
const otherScope = conversationScope({ appId: process.env.FEISHU_APP_ID.trim(), chatType: 'group', chatId: 'isolated-import-check' });
if (!(await service.handleText(otherScope, { content: `知识库 ${id}` })).text.includes('还没有')) throw new Error('Scope isolation check failed.');
console.log(JSON.stringify({ id, version: 1, saved: true, items: items.length, evidenceStatus: 'unresolved', archiveFile: path.join(archiveDir, 'reviewed-v1.md'), database: file, scope: 'configured-learning-group', readback: 'passed', isolation: 'passed', feishuMessagesSent: 0 }));
