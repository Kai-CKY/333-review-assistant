import { readFile, writeFile, mkdir, rename, readdir, lstat, access } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { conversationScope } from '../agent/memory.js';
import { libraryPolicy, syncSavedKnowledge } from './library.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function within(root, relative) {
  const resolved = path.resolve(root, relative), rel = path.relative(path.resolve(root), resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('unsafe_snapshot_path');
  return resolved;
}
async function exists(file) { try { await access(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function writeBlob(root, bytes) {
  const sha256 = hash(bytes), file = within(root, `blobs/${sha256}`);
  await mkdir(path.dirname(file), { recursive: true });
  try { await writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; if (hash(await readFile(file)) !== sha256) throw new Error('existing_blob_corrupt'); }
  return { sha256, bytes: bytes.length };
}
async function archiveFiles(directory) {
  if (!(await exists(directory))) return [];
  if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink()) throw new Error('archive_link_not_allowed');
  const results = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = within(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('archive_link_not_allowed');
    if (entry.isDirectory()) results.push(...await archiveFiles(file));
    else if (entry.isFile()) results.push(file);
  }
  return results;
}

// An atomic database read plus immutable, content-addressed blobs. The manifest
// is replaced last, so a failed export cannot invalidate the previous snapshot.
export async function exportKnowledge({ databaseFile, outputDir, knowledgePolicy = libraryPolicy() }) {
  const data = JSON.parse(await readFile(databaseFile, 'utf8'));
  // Materialize the Web/agent view in this copy only; do not mutate the live DB.
  data.knowledgePoints ??= [];
  syncSavedKnowledge(data, knowledgePolicy);
  const root = path.dirname(path.resolve(databaseFile));
  const photoKnowledge = structuredClone(data.photoKnowledge || { schemaVersion: 1, drafts: {}, documents: {}, events: [] });
  const scopes = {};
  for (const record of [...Object.values(photoKnowledge.drafts), ...Object.values(photoKnowledge.documents)]) {
    const stream = data.agentMemory?.streams?.[record.scopeKey];
    if (!stream?.scope || conversationScope(stream.scope).key !== record.scopeKey) throw new Error('missing_or_invalid_knowledge_scope');
    scopes[record.scopeKey] = { scope: stream.scope, sessionId: stream.sessionId };
  }
  const files = [], seen = new Set();
  for (const draft of Object.values(photoKnowledge.drafts)) {
    for (const asset of draft.assets || []) {
      if (!validHash(asset.sha256)) throw new Error('invalid_asset_hash');
      const relativePath = `knowledge-assets/${asset.sha256}`;
      if (seen.has(relativePath)) continue;
      seen.add(relativePath);
      const file = within(root, relativePath);
      if ((await lstat(file)).isSymbolicLink()) throw new Error('asset_link_not_allowed');
      const bytes = await readFile(file);
      if (hash(bytes) !== asset.sha256) throw new Error('source_asset_corrupt');
      files.push({ path: relativePath, ...await writeBlob(outputDir, bytes) });
    }
    // Local absolute paths are not portable. The associated archive is included below.
    if (draft.importProvenance?.archiveDir) draft.importProvenance.archiveDir = `knowledge-library/${draft.id}`;
  }
  for (const id of new Set([...Object.keys(photoKnowledge.documents), ...Object.keys(photoKnowledge.drafts)])) {
    if (!/^KP-[a-f0-9]{8}$/.test(id)) throw new Error('invalid_knowledge_id');
    const directory = within(root, `knowledge-library/${id}`);
    for (const file of await archiveFiles(directory)) files.push({ path: path.relative(root, file).split(path.sep).join('/'), ...await writeBlob(outputDir, await readFile(file)) });
  }
  const manifest = { format: '333-knowledge-snapshot', version: 1, exportedAt: new Date().toISOString(), photoKnowledge, knowledgePoints: structuredClone(data.knowledgePoints || []), scopes, files };
  await mkdir(outputDir, { recursive: true });
  const temporary = within(outputDir, `manifest-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  await rename(temporary, within(outputDir, 'manifest.json'));
  return { documents: Object.keys(photoKnowledge.documents).length, drafts: Object.keys(photoKnowledge.drafts).length, visibleSavedPoints: data.knowledgePoints.filter(p => p.sourceKind === 'saved_knowledge' && !p.archived && !p.hidden).length, files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0) };
}

// Cold restore only: never merge a stale Git snapshot over a live cloud database.
export async function restoreKnowledge({ snapshotDir, databaseFile }) {
  if (await exists(databaseFile)) throw new Error('destination_database_exists');
  const manifest = JSON.parse(await readFile(within(snapshotDir, 'manifest.json'), 'utf8'));
  if (manifest.format !== '333-knowledge-snapshot' || manifest.version !== 1 || !manifest.photoKnowledge || !Array.isArray(manifest.files) || !Array.isArray(manifest.knowledgePoints)) throw new Error('invalid_snapshot');
  const root = path.dirname(path.resolve(databaseFile));
  const files = [];
  for (const item of manifest.files) {
    if (!validHash(item.sha256) || typeof item.path !== 'string' || !/^(knowledge-assets\/[a-f0-9]{64}|knowledge-library\/KP-[a-f0-9]{8}\/.+)$/.test(item.path) || item.path.includes('\\') || item.path.split('/').includes('..')) throw new Error('unsafe_snapshot_file');
    const target = within(root, item.path);
    const bytes = await readFile(within(snapshotDir, `blobs/${item.sha256}`));
    if (hash(bytes) !== item.sha256 || bytes.length !== item.bytes) throw new Error('snapshot_blob_corrupt');
    if (item.path.startsWith('knowledge-assets/') && path.basename(item.path) !== item.sha256) throw new Error('asset_name_mismatch');
    // No writes before every referenced blob has been checked.
    files.push({ target, bytes });
  }
  const photoKnowledge = structuredClone(manifest.photoKnowledge);
  const agentMemory = { version: 1, streams: {}, sessions: {}, notes: {} };
  for (const [key, value] of Object.entries(manifest.scopes || {})) {
    if (conversationScope(value.scope).key !== key || typeof value.sessionId !== 'string') throw new Error('invalid_snapshot_scope');
    agentMemory.streams[key] = { scope: value.scope, sessionId: value.sessionId, archivedIds: [] };
    agentMemory.sessions[value.sessionId] = { id: value.sessionId, scopeKey: key, createdAt: manifest.exportedAt, events: [] };
  }
  for (const record of [...Object.values(photoKnowledge.documents), ...Object.values(photoKnowledge.drafts)]) {
    if (!agentMemory.streams[record.scopeKey]) throw new Error('snapshot_scope_missing');
  }
  for (const draft of Object.values(photoKnowledge.drafts)) {
    for (const asset of draft.assets || []) if (!manifest.files.some(f => f.path === `knowledge-assets/${asset.sha256}` && f.sha256 === asset.sha256)) throw new Error('snapshot_asset_missing');
    if (draft.sessionId !== agentMemory.streams[draft.scopeKey].sessionId) {
      agentMemory.sessions[draft.sessionId] = { id: draft.sessionId, scopeKey: draft.scopeKey, createdAt: draft.createdAt, events: [], archivedAt: manifest.exportedAt };
      agentMemory.streams[draft.scopeKey].archivedIds.push(draft.sessionId);
    }
    if (['recognizing', 'aligning', 'verifying', 'revising'].includes(draft.status)) { draft.status = 'interrupted'; draft.error = 'snapshot_restored_inflight'; }
    if (draft.importProvenance?.archiveDir) draft.importProvenance.archiveDir = within(root, `knowledge-library/${draft.id}`);
  }
  // Refuse symlink parents and conflicting files in the destination asset tree.
  for (const { target, bytes } of files) {
    let directory = path.dirname(target);
    while (directory !== root) {
      if (await exists(directory) && (await lstat(directory)).isSymbolicLink()) throw new Error('destination_link_not_allowed');
      directory = path.dirname(directory);
    }
    if (await exists(target)) {
      if ((await lstat(target)).isSymbolicLink() || hash(await readFile(target)) !== hash(bytes)) throw new Error('destination_file_conflict');
    }
  }
  for (const { target, bytes } of files) {
    await mkdir(path.dirname(target), { recursive: true });
    try { await writeFile(target, bytes, { flag: 'wx', mode: 0o600 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  const data = { schemaVersion: 4, user: {}, knowledgePoints: manifest.knowledgePoints, reviewStates: [], reviewLogs: [], answerAttempts: [], answerFeedbacks: [], feedbackJobs: [], taskCompletionLogs: [], photoKnowledge, agentMemory };
  await mkdir(root, { recursive: true });
  await writeFile(databaseFile, JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 });
  return { documents: Object.keys(photoKnowledge.documents).length, drafts: Object.keys(photoKnowledge.drafts).length, files: files.length };
}
