import { readFile, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { RelationalRepository } from '../apps/api/src/storage/relational-repository.js';
import { readRelationalData, stableId } from '../apps/api/src/storage/relational-codec.js';
import { ensureUploadTranscriptions } from '../apps/api/src/knowledge/upload-corrections.js';

const args=process.argv.slice(2),option=name=>args[args.indexOf(name)+1];
if(!args.includes('--source')||!args.includes('--target')||!args.includes('--manifest'))throw new Error('required: --source JSON --target NEW.sqlite --manifest snapshot-manifest.json');
const source=path.resolve(option('--source')),target=path.resolve(option('--target')),manifest=JSON.parse(await readFile(option('--manifest'),'utf8'));
if(existsSync(target))throw new Error('target_already_exists');
const raw=await readFile(source),sourceHash=createHash('sha256').update(raw).digest('hex');
if(manifest.files.find(f=>f.path==='review-assistant.json')?.sha256!==sourceHash)throw new Error('source_manifest_mismatch');
const data=JSON.parse(raw),removed=data.knowledgePoints.filter(p=>p.sourceLabel==='演示知识库').map(p=>p.id),removedSet=new Set(removed);
data.knowledgePoints=data.knowledgePoints.filter(p=>!removedSet.has(p.id));
for(const key of ['reviewStates','memoryEvents','reviewLogs','answerAttempts','taskCompletionLogs'])data[key]=(data[key]||[]).filter(r=>!removedSet.has(r.knowledgePointId));
ensureUploadTranscriptions(data);
await mkdir(path.dirname(target),{recursive:true});
const policy={appId:manifest.identities.appId,learnerId:manifest.identities.learnerOpenId,scopeKeys:Object.keys(data.agentMemory?.streams||{})};
const repository=new RelationalRepository(target,{knowledgePolicy:policy});
try {
 await repository.save(data);
 const restored=readRelationalData(repository.db);
 if(!isDeepStrictEqual(data,restored)) {
   const mismatched=Object.keys(data).filter(k=>!isDeepStrictEqual(data[k],restored[k]));
   throw new Error(`round_trip_mismatch:${mismatched.join(',')}`);
 }
 const identity=repository.db.prepare('INSERT OR REPLACE INTO channel_identities VALUES (?,?,?,?,?)');
 if(manifest.identities.ownerOpenId)identity.run(stableId('identity','project-admin',policy.appId),'project-admin',policy.appId,'feishu',manifest.identities.ownerOpenId);
 const original=repository.db.prepare('INSERT INTO migration_originals VALUES (?,?)'),inventory=repository.db.prepare('INSERT INTO migration_inventory VALUES (?,?,?,?)');
 for(const table of ['learner_profiles','conversation_scopes','conversation_sessions','conversation_events','knowledge_sources','knowledge_revisions','knowledge_points','review_states','learning_events','processing_jobs','draft_versions','job_events','channel_records','practice_sessions']) {
   const primary=repository.db.prepare(`PRAGMA table_info(${table})`).all().filter(c=>c.pk).map(c=>c.name);
   for(const row of repository.db.prepare(`SELECT * FROM ${table}`).all()) {
     const id=primary.map(k=>row[k]).join(':'),sourcePath=`${table}:${id}`;
     original.run(sourcePath,row.snapshot_json);inventory.run(sourcePath,table,id,createHash('sha256').update(row.snapshot_json).digest('hex'));
   }
 }
 const metadata=repository.db.prepare('INSERT OR REPLACE INTO migration_metadata VALUES (?,?)');
 for(const [key,value] of Object.entries({format:'relational-v1',status:'PRODUCTION_READY',capturedAt:manifest.capturedAt,sourceSha256:sourceHash,removedDemoPointIds:removed,roundTripVerified:true}))metadata.run(key,JSON.stringify(value));
 repository.db.prepare('INSERT INTO schema_migrations VALUES (?,?,?)').run(1,'approved-relational-runtime-v1',new Date().toISOString());
 const assets=repository.db.prepare('INSERT OR REPLACE INTO assets VALUES (?,?,?,?)');
 for(const f of manifest.files.filter(f=>/^(knowledge-assets|knowledge-library)\//.test(f.path))) {
   const bytes=await readFile(path.join(path.dirname(source),f.path));
   if(createHash('sha256').update(bytes).digest('hex')!==f.sha256)throw new Error('asset_manifest_mismatch');
   assets.run(stableId('asset',f.path),f.path,f.sha256,f.bytes);
 }
 if(repository.db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||repository.db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('database_integrity_failed');
 repository.db.pragma('wal_checkpoint(TRUNCATE)');
 console.log(JSON.stringify({target,format:'relational-v1',roundTripVerified:true,removedExamples:removed.length,points:data.knowledgePoints.length,uploads:Object.keys(data.uploadTranscriptions).length,events:Object.values(data.agentMemory.sessions).reduce((n,s)=>n+s.events.length,0),reviewLogs:data.reviewLogs.length,sourceSha256:sourceHash}));
} finally {repository.close();}
