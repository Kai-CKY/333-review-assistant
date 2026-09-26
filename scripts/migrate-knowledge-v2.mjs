import { readFile, access, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SqliteRepository } from '../apps/api/src/storage/sqlite-repository.js';
const args = process.argv.slice(2), value = name => args[args.indexOf(name) + 1];
const source = path.resolve(args.includes('--source') ? value('--source') : '.data/review-assistant.json');
const target = path.resolve(args.includes('--target') ? value('--target') : path.join(path.dirname(source), 'review-assistant.sqlite'));
const raw = await readFile(source), data = JSON.parse(raw);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
if (path.dirname(source) !== path.dirname(target) || source === target) throw new Error('Target must be a new SQLite file beside the original JSON to preserve attachment paths.');
if (!/\.(sqlite|db)$/i.test(target)) throw new Error('Target extension must be .sqlite or .db.');
try { await access(target); throw new Error('Target already exists; refusing overwrite.'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const sourceKinds = {};
for (const document of Object.values(data.photoKnowledge?.documents || {})) { const kind = document.materialKind || 'legacy_unknown'; sourceKinds[kind] = (sourceKinds[kind] || 0) + 1; }
const ids = new Set((data.knowledgePoints || []).map(p => p.id));
const report = { source, target, sha256: hash(raw), collections: Object.fromEntries(Object.entries(data).map(([k,v]) => [k, Array.isArray(v) ? v.length : typeof v])),
  sourceKinds, idMapping: { strategy: 'keep_existing_ids', points: ids.size }, orphanLearningReferences: ['reviewLogs', 'reviewStates', 'answerAttempts'].flatMap(name => (data[name] || []).filter(row => !ids.has(row.knowledgePointId)).map(row => ({ collection: name, id: row.id, knowledgePointId: row.knowledgePointId }))),
  attachmentRoot: path.dirname(source), activationPerformed: false, apply: args.includes('--apply') };
if (!report.apply) console.log(JSON.stringify(report, null, 2));
else {
  if (!args.includes('--server-stopped')) throw new Error('Stop the application and pass --server-stopped before migration.');
  await copyFile(source, `${source}.before-sqlite-${Date.now()}.bak`, 1);
  const repository = new SqliteRepository(target);
  try {
    await repository.save(data);
    if (hash(await readFile(source)) !== report.sha256) throw new Error('Source changed during migration. Do not activate the new database.');
    const rows = repository.db.prepare('PRAGMA integrity_check').all();
    if (rows.some(r => r.integrity_check !== 'ok')) throw new Error('SQLite integrity check failed.');
    // Verify a lossless serialization before running policy-dependent projections.
    const restored = {};
    for (const {name,shape} of repository.db.prepare('SELECT * FROM collections').all()) {
      const values = repository.db.prepare('SELECT value FROM records WHERE collection=? ORDER BY position').all(name).map(r => JSON.parse(r.value));
      restored[name] = shape === 'array' ? values : values[0];
    }
    if (Object.keys(data).some(k => JSON.stringify(data[k]) !== JSON.stringify(restored[k]))) throw new Error('Migration content mismatch.');
    console.log(JSON.stringify({ ...report, verified: true, activate: 'Set DATA_FILE to the target after checking backup and attachment access. The JSON source is unchanged.' }, null, 2));
  } finally { repository.close(); }
}
