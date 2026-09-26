import { mkdir, readdir, lstat, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readDatabaseFile, isSqliteFile } from './database-file.js';
import { SqliteRepository } from './sqlite-repository.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function absent(file) { try { await access(file); throw new Error('destination_exists'); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
async function filesBelow(root, dir) {
  try { if ((await lstat(dir)).isSymbolicLink()) throw new Error('backup_symlink_not_allowed'); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error('backup_symlink_not_allowed');
    if (entry.isDirectory()) files.push(...await filesBelow(root, full));
    else if (entry.isFile()) files.push({ full, relative: path.relative(root, full).split(path.sep).join('/') });
  }
  return files;
}

// Full private backup, unlike portable knowledge exports: includes all learning history.
export async function backupRuntime({ databaseFile, outputDir, serverStopped = false }) {
  if (!serverStopped) throw new Error('stop_server_and_pass_server_stopped');
  await absent(outputDir);
  const root = path.dirname(path.resolve(databaseFile));
  const data = await readDatabaseFile(databaseFile), serialized = JSON.stringify(data);
  const files = [...await filesBelow(root, path.join(root, 'knowledge-assets')), ...await filesBelow(root, path.join(root, 'knowledge-library'))];
  await mkdir(path.join(outputDir, 'blobs'), { recursive: true });
  const manifest = { format: '333-runtime-backup', version: 1, createdAt: new Date().toISOString(), database: { sha256: hash(serialized) }, files: [] };
  await writeFile(path.join(outputDir, 'database.json'), serialized, { flag: 'wx', mode: 0o600 });
  for (const file of files) {
    const bytes = await readFile(file.full), sha256 = hash(bytes);
    try { await writeFile(path.join(outputDir, 'blobs', sha256), bytes, { flag: 'wx', mode: 0o600 }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    manifest.files.push({ path: file.relative, sha256, size: bytes.length });
  }
  if (JSON.stringify(await readDatabaseFile(databaseFile)) !== serialized) throw new Error('database_changed_during_backup');
  await writeFile(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
  return { files: files.length, databaseSha256: manifest.database.sha256, outputDir };
}

export async function restoreRuntime({ backupDir, outputDir, sqlite = true }) {
  await absent(outputDir);
  const manifest = JSON.parse(await readFile(path.join(backupDir, 'manifest.json'), 'utf8'));
  if (manifest.format !== '333-runtime-backup' || manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error('invalid_runtime_backup');
  const bytes = await readFile(path.join(backupDir, 'database.json'));
  if (hash(bytes) !== manifest.database?.sha256) throw new Error('backup_database_corrupt');
  const data = JSON.parse(bytes);
  for (const file of manifest.files) {
    if (!/^[a-f0-9]{64}$/.test(file.sha256) || typeof file.path !== 'string' || !/^(knowledge-assets|knowledge-library)\//.test(file.path) ||
      file.path.includes('\\') || file.path.includes(':') || file.path.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('unsafe_backup_path');
    const asset = await readFile(path.join(backupDir, 'blobs', file.sha256));
    if (hash(asset) !== file.sha256 || asset.length !== file.size) throw new Error('backup_asset_corrupt');
  }
  // Verify every blob before creating the destination. Never overwrite a live runtime.
  await mkdir(outputDir, { recursive: true });
  for (const file of manifest.files) {
    const asset = await readFile(path.join(backupDir, 'blobs', file.sha256));
    if (hash(asset) !== file.sha256) throw new Error('backup_asset_changed');
    const target = path.join(outputDir, ...file.path.split('/'));
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, asset, { flag: 'wx', mode: 0o600 });
  }
  // Saved archive directories are location metadata; historical IDs/timestamps stay unchanged.
  for (const draft of Object.values(data.photoKnowledge?.drafts || {})) if (draft.importProvenance?.archiveDir) draft.importProvenance.archiveDir = path.join(outputDir, 'knowledge-library', draft.id);
  const databaseFile = path.join(outputDir, sqlite ? 'review-assistant.sqlite' : 'review-assistant.json');
  if (isSqliteFile(databaseFile)) {
    const repository = new SqliteRepository(databaseFile);
    try { await repository.save(data); if (repository.db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('restore_integrity_failed'); }
    finally { repository.close(); }
  } else await writeFile(databaseFile, JSON.stringify(data), { flag: 'wx', mode: 0o600 });
  return { databaseFile, files: manifest.files.length };
}
