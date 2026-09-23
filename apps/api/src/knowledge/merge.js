import { readFile, writeFile, mkdir, mkdtemp, copyFile, lstat, access, rename, open } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { restoreKnowledge } from './snapshot.js';
import { libraryPolicy, syncSavedKnowledge } from './library.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_k, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
async function exists(file) { try { await access(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }

// Add missing saved documents only. Existing source conflicts require separate
// review; an old Git snapshot is never allowed to overwrite a cloud revision.
export async function mergeKnowledge({ snapshotDir, databaseFile, apply = false, serverStopped = false, knowledgePolicy = libraryPolicy() }) {
  if (apply && !serverStopped) throw new Error('stop_server_and_pass_server_stopped');
  const original = await readFile(databaseFile);
  const data = JSON.parse(original);
  const stage = await mkdtemp(path.join(tmpdir(), '333-knowledge-merge-'));
  const stagedDatabase = path.join(stage, 'data.json');
  await restoreKnowledge({ snapshotDir, databaseFile: stagedDatabase });
  const incoming = JSON.parse(await readFile(stagedDatabase, 'utf8'));
  const snapshot = JSON.parse(await readFile(path.join(snapshotDir, 'manifest.json'), 'utf8'));
  const root = path.dirname(path.resolve(databaseFile));
  data.photoKnowledge ??= { schemaVersion: 1, documents: {}, drafts: {}, events: [] };
  data.agentMemory ??= { version: 1, streams: {}, sessions: {}, notes: {} };
  const store = data.photoKnowledge, memory = data.agentMemory;
  const result = { added: [], unchanged: [], retainedNewer: [], conflicts: [], visibleSavedPoints: 0, applied: false };
  const included = new Set(), assets = new Set();
  for (const [id, doc] of Object.entries(incoming.photoKnowledge.documents)) {
    const revision = doc.revisions.find(r => r.version === doc.currentVersion);
    if (!revision?.confirmedBy || !Array.isArray(revision.items)) { result.conflicts.push({ id, reason: 'incoming_not_confirmed' }); continue; }
    const existing = store.documents[id];
    if (existing) {
      if (existing.scopeKey !== doc.scopeKey) { result.conflicts.push({ id, reason: 'scope_conflict' }); continue; }
      if (existing.currentVersion > doc.currentVersion) { result.retainedNewer.push(id); continue; }
      const current = existing.revisions.find(r => r.version === existing.currentVersion);
      if (existing.currentVersion !== doc.currentVersion || canonical(current) !== canonical(revision)) { result.conflicts.push({ id, reason: 'revision_conflict' }); continue; }
      result.unchanged.push(id);
    } else {
      const sourceDraftId = revision.sourceDraftId || id;
      if (store.drafts[sourceDraftId]) { result.conflicts.push({ id, reason: 'draft_id_conflict' }); continue; }
      const draft = structuredClone(incoming.photoKnowledge.drafts[sourceDraftId]);
      if (!draft || draft.scopeKey !== doc.scopeKey) { result.conflicts.push({ id, reason: 'missing_or_wrong_scope_draft' }); continue; }
      store.documents[id] = structuredClone(doc);
      store.drafts[sourceDraftId] = draft;
      // Never replace an existing conversation or its active session.
      if (!memory.streams[doc.scopeKey]) {
        const sourceStream = incoming.agentMemory.streams[doc.scopeKey];
        const sid = randomUUID();
        memory.streams[doc.scopeKey] = { scope: sourceStream.scope, sessionId: sid, archivedIds: [] };
        memory.sessions[sid] = { id: sid, scopeKey: doc.scopeKey, createdAt: new Date().toISOString(), events: [] };
      }
      const archiveId = randomUUID();
      draft.sessionId = archiveId;
      memory.sessions[archiveId] = { id: archiveId, scopeKey: doc.scopeKey, createdAt: draft.createdAt, archivedAt: new Date().toISOString(), events: [] };
      memory.streams[doc.scopeKey].archivedIds ??= [];
      memory.streams[doc.scopeKey].archivedIds.push(archiveId);
      if (draft.importProvenance?.archiveDir) draft.importProvenance.archiveDir = path.join(root, 'knowledge-library', draft.id);
      result.added.push(id);
      store.events.push(...incoming.photoKnowledge.events.filter(e => e.id === id));
    }
    // Reconstruct missing scope metadata without importing any conversations.
    if (!memory.streams[doc.scopeKey]) {
      const sid = randomUUID();
      memory.streams[doc.scopeKey] = { scope: incoming.agentMemory.streams[doc.scopeKey].scope, sessionId: sid, archivedIds: [] };
      memory.sessions[sid] = { id: sid, scopeKey: doc.scopeKey, createdAt: new Date().toISOString(), events: [] };
    }
    included.add(id);
    for (const asset of incoming.photoKnowledge.drafts[revision.sourceDraftId || id]?.assets || []) assets.add(asset.sha256);
  }
  data.knowledgePoints ??= [];
  syncSavedKnowledge(data, knowledgePolicy);
  const visible = data.knowledgePoints.filter(p => p.sourceKind === 'saved_knowledge' && !p.archived && !p.hidden);
  result.visibleSavedPoints = visible.length;
  for (const id of included) if (!visible.some(p => p.sourceDocumentId === id)) result.conflicts.push({ id, reason: 'not_visible_under_server_scope_policy' });
  const files = [];
  for (const file of snapshot.files) {
    const parts = file.path.split('/');
    if (!(parts[0] === 'knowledge-assets' ? assets.has(parts[1]) : included.has(parts[1]))) continue;
    const target = path.resolve(root, ...parts);
    const relative = path.relative(root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('unsafe_merge_path');
    let dir = path.dirname(target);
    while (dir !== root) {
      if (await exists(dir) && (await lstat(dir)).isSymbolicLink()) throw new Error('destination_link_not_allowed');
      dir = path.dirname(dir);
    }
    if (await exists(target)) {
      if ((await lstat(target)).isSymbolicLink() || digest(await readFile(target)) !== file.sha256) result.conflicts.push({ path: file.path, reason: 'attachment_conflict' });
    } else files.push({ from: path.join(stage, ...parts), target });
  }
  result.newFiles = files.length;
  if (!apply || result.conflicts.length) return result;
  const lockFile = `${databaseFile}.knowledge-merge.lock`;
  const lock = await open(lockFile, 'wx', 0o600);
  try {
    if (digest(await readFile(databaseFile)) !== digest(original)) throw new Error('database_changed_during_merge');
    const backup = path.join(root, 'backups', `before-knowledge-merge-${Date.now()}-${randomUUID()}.json`);
    await mkdir(path.dirname(backup), { recursive: true });
    await writeFile(backup, original, { flag: 'wx', mode: 0o600 });
    for (const file of files) {
      await mkdir(path.dirname(file.target), { recursive: true });
      await copyFile(file.from, file.target, 1); // COPYFILE_EXCL
    }
    store.events.push({ type: 'knowledge_snapshot_merged', at: new Date().toISOString(), snapshotExportedAt: snapshot.exportedAt, added: result.added, unchanged: result.unchanged, retainedNewer: result.retainedNewer });
    const temporary = `${databaseFile}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
    if (digest(await readFile(databaseFile)) !== digest(original)) throw new Error('database_changed_during_merge');
    await rename(temporary, databaseFile);
    result.applied = true; result.backup = backup;
    return result;
  } finally {
    await lock.close();
    const { unlink } = await import('node:fs/promises');
    await unlink(lockFile);
  }
}
