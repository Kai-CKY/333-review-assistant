import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { LocalRepository, normalizeData } from '../repository.js';
import { syncSavedKnowledge, searchSavedItems } from '../knowledge/library.js';
import { readRelationalData, writeRelationalData } from './relational-codec.js';
import { migrateRuntime } from './runtime-migrations.js';

export class RelationalRepository extends LocalRepository {
  constructor(filePath,options) {
    super(filePath,options);mkdirSync(path.dirname(filePath),{recursive:true});
    this.db=new Database(filePath);
    this.db.pragma('journal_mode = WAL');this.db.pragma('foreign_keys = ON');this.db.pragma('busy_timeout = 5000');
    const schema=readFileSync(new URL('./relational-schema.sql',import.meta.url),'utf8').replaceAll('CREATE TABLE ','CREATE TABLE IF NOT EXISTS ').replaceAll('CREATE INDEX ','CREATE INDEX IF NOT EXISTS ');
    this.db.exec(schema.replaceAll('IF NOT EXISTS IF NOT EXISTS','IF NOT EXISTS'));
    migrateRuntime(this.db);
    this.format='relational-v1';
  }
  async load() {
    const data=readRelationalData(this.db);
    const normalized=normalizeData(data),synced=syncSavedKnowledge(data,this.knowledgePolicy);
    return {data,changed:normalized||synced};
  }
  async save(data) {
    if(this.db.inTransaction) return writeRelationalData(this.db,data,this.knowledgePolicy);
    this.db.transaction(()=>writeRelationalData(this.db,data,this.knowledgePolicy)).immediate();
  }
  async mutate(callback) {
    const operation=this.mutationQueue.then(async()=> {
      this.db.exec('BEGIN IMMEDIATE');
      try {const {data}=await this.load(),result=await callback(data);syncSavedKnowledge(data,this.knowledgePolicy);await this.save(data);this.db.exec('COMMIT');return result;}
      catch(error){if(this.db.inTransaction)this.db.exec('ROLLBACK');throw error;}
    });
    this.mutationQueue=operation.catch(()=>{});return operation;
  }
  async readPoint(id){await this.mutationQueue;const row=this.db.prepare('SELECT * FROM knowledge_points WHERE id=? AND hidden=0').get(id);return row?{...JSON.parse(row.snapshot_json),title:row.title,text:row.body}:null;}
  async readPracticePoint(id){const point=await this.readPoint(id),row=this.db.prepare('SELECT snapshot_json FROM review_states WHERE knowledge_point_id=?').get(id);return {point,state:row?JSON.parse(row.snapshot_json):null};}
  async searchPoints(query,{scopeKey,textbookOnly=false,limit=5}={}) {
    await this.mutationQueue;
    const rows=this.db.prepare('SELECT * FROM knowledge_points WHERE hidden=0 AND (? IS NULL OR scope_id=?)').all(scopeKey||null,scopeKey||null);
    return searchSavedItems(rows.map(r=>({...JSON.parse(r.snapshot_json),title:r.title,text:r.body})).filter(p=>!p.archived&&(!textbookOnly||p.materialKind==='textbook')),query,limit);
  }
  async backup(destination){await this.mutationQueue;await this.db.backup(destination);}
  close(){this.db.close();}
}
