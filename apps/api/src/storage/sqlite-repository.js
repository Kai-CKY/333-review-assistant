import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { LocalRepository, normalizeData, createSeedData } from '../repository.js';
import { syncSavedKnowledge, searchSavedItems } from '../knowledge/library.js';
import { indexedText, queryTerms } from '../knowledge/text-search.js';

// Legacy domain methods retain their transactional contract during migration.
// Collections are row-based; the materialized point/FTS index enables direct reads.
export class SqliteRepository extends LocalRepository {
  constructor(filePath, options) {
    super(filePath, options);
    mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.pragma('journal_mode = WAL'); this.db.pragma('foreign_keys = ON'); this.db.pragma('busy_timeout = 5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_info(version INTEGER NOT NULL);
      INSERT INTO schema_info SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM schema_info);
      CREATE TABLE IF NOT EXISTS collections(name TEXT PRIMARY KEY, shape TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records(collection TEXT NOT NULL, key TEXT NOT NULL, position INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(collection,key));
      CREATE TABLE IF NOT EXISTS points(id TEXT PRIMARY KEY, scope TEXT, kind TEXT, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS points_scope ON points(scope,kind);
      CREATE VIRTUAL TABLE IF NOT EXISTS point_search USING fts5(id UNINDEXED,title,body);`);
    if (this.db.prepare('SELECT version FROM schema_info').get().version !== 1) throw new Error('unsupported_sqlite_schema');
  }
  async load() {
    const meta = this.db.prepare('SELECT name,shape FROM collections').all();
    if (!meta.length) return { data: createSeedData(), changed: true };
    const data = {};
    for (const { name, shape } of meta) {
      const rows = this.db.prepare('SELECT key,value FROM records WHERE collection=? ORDER BY position').all(name);
      data[name] = shape === 'array' ? rows.map(r => JSON.parse(r.value)) : JSON.parse(rows[0].value);
    }
    const normalized = normalizeData(data), synced = syncSavedKnowledge(data, this.knowledgePolicy);
    return { data, changed: normalized || synced };
  }
  async save(data) {
    const ownTransaction = !this.db.inTransaction;
    if (ownTransaction) this.db.exec('BEGIN IMMEDIATE');
    try {
      const upsert = this.db.prepare('INSERT INTO records VALUES (?,?,?,?) ON CONFLICT(collection,key) DO UPDATE SET position=excluded.position,value=excluded.value WHERE value<>excluded.value OR position<>excluded.position');
      for (const [name, value] of Object.entries(data)) {
        const array = Array.isArray(value);
        this.db.prepare('INSERT INTO collections VALUES (?,?) ON CONFLICT(name) DO UPDATE SET shape=excluded.shape').run(name, array ? 'array' : 'value');
        const entries = array ? value.map((v, i) => [String(v?.id ?? v?.knowledgePointId ?? i), v]) : [['value', value]];
        const keys = new Set();
        entries.forEach(([key, v], i) => { while (keys.has(key)) key = `${key}:${i}`; keys.add(key); upsert.run(name, key, i, JSON.stringify(v)); });
        for (const r of this.db.prepare('SELECT key FROM records WHERE collection=?').all(name)) if (!keys.has(r.key)) this.db.prepare('DELETE FROM records WHERE collection=? AND key=?').run(name, r.key);
      }
      for (const r of this.db.prepare('SELECT name FROM collections').all()) if (!(r.name in data)) {
        this.db.prepare('DELETE FROM records WHERE collection=?').run(r.name); this.db.prepare('DELETE FROM collections WHERE name=?').run(r.name);
      }
      const points = new Map((data.knowledgePoints || []).filter(p => !p.archived && !p.hidden).map(p => [p.id, p]));
      const existing = new Map(this.db.prepare('SELECT id,value FROM points').all().map(r => [r.id, r.value]));
      for (const [id, p] of points) {
        const value = JSON.stringify(p); if (value === existing.get(id)) continue;
        this.db.prepare('INSERT INTO points VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET scope=excluded.scope,kind=excluded.kind,value=excluded.value').run(id, p.sourceScopeKey || '', p.materialKind || '', value);
        this.db.prepare('DELETE FROM point_search WHERE id=?').run(id);
        this.db.prepare('INSERT INTO point_search(id,title,body) VALUES (?,?,?)').run(id, indexedText(p.title), indexedText(p.text));
      }
      for (const id of existing.keys()) if (!points.has(id)) { this.db.prepare('DELETE FROM points WHERE id=?').run(id); this.db.prepare('DELETE FROM point_search WHERE id=?').run(id); }
      if (ownTransaction) this.db.exec('COMMIT');
    } catch (error) { if (ownTransaction && this.db.inTransaction) this.db.exec('ROLLBACK'); throw error; }
  }
  async mutate(callback) {
    const operation = this.mutationQueue.then(async () => {
      this.db.exec('BEGIN IMMEDIATE');
      try { const { data } = await this.load(); const result = await callback(data); syncSavedKnowledge(data, this.knowledgePolicy); await this.save(data); this.db.exec('COMMIT'); return result; }
      catch (error) { if (this.db.inTransaction) this.db.exec('ROLLBACK'); throw error; }
    });
    this.mutationQueue = operation.catch(() => {}); return operation;
  }
  async readPoint(id) {
    await this.mutationQueue;
    const row = this.db.prepare('SELECT value FROM points WHERE id=?').get(id);
    return row ? JSON.parse(row.value) : null;
  }
  async readPracticePoint(id) {
    const point = await this.readPoint(id);
    const row = this.db.prepare("SELECT value FROM records WHERE collection='reviewStates' AND key=?").get(id);
    return { point, state: row ? JSON.parse(row.value) : null };
  }
  async searchPoints(query, { scopeKey, textbookOnly = false, limit = 5 } = {}) {
    await this.mutationQueue;
    const terms = queryTerms(query);
    if (!terms.length) return [];
    const match = terms.map(t => `"${t.replaceAll('"', '""')}"`).join(' OR ');
    const rows = this.db.prepare(`SELECT p.value FROM point_search f JOIN points p ON p.id=f.id
      WHERE point_search MATCH ? AND (? IS NULL OR p.scope=?) AND (?=0 OR p.kind='textbook') ORDER BY bm25(point_search,0,4,1) LIMIT 40`).all(match, scopeKey || null, scopeKey || null, textbookOnly ? 1 : 0);
    return searchSavedItems(rows.map(r => JSON.parse(r.value)), query, limit);
  }
  async backup(destination) { await this.mutationQueue; await this.db.backup(destination); }
  close() { this.db.close(); }
}
