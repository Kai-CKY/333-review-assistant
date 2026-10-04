import { createHash } from 'node:crypto';

const json = value => JSON.stringify(value);
const parse = row => JSON.parse(row.snapshot_json);
const entries = object => Object.entries(object || {});
const list = value => Array.isArray(value) ? value : [];
export const stableId = (prefix, ...parts) => `${prefix}-${createHash('sha256').update(json(parts)).digest('hex').slice(0,24)}`;
const without = (object, keys) => Object.fromEntries(entries(object).filter(([key])=>!keys.includes(key)));
const overlay = (row, fields) => {
  const value=parse(row);
  for(const [column,key] of entries(fields)) if(row[column]!==null || Object.hasOwn(value,key)) value[key]=row[column];
  return value;
};
const get = (object,path) => path.reduce((o,key)=>o?.[key],object);
const set = (object,path,value) => { let current=object; for(const key of path.slice(0,-1)) current=current[key]??={};current[path.at(-1)]=value; };

/** Rebuilds the domain view from independently stored rows, never from an old JSON file. */
export function readRelationalData(db) {
  const data={};
  for(const row of db.prepare('SELECT path,value_json FROM runtime_fragments ORDER BY length(path),path').all()) set(data,JSON.parse(row.path),JSON.parse(row.value_json));
  const rows=table=>db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  const profile=rows('learner_profiles')[0];
  if(!profile) throw new Error('relational_database_not_initialized');
  data.user=overlay(profile,{exam_goal:'examGoal',study_stage:'studyStage',daily_minutes:'dailyAvailableMinutes',version:'profileVersion'});
  data.knowledgePoints=rows('knowledge_points').map(row=>overlay(row,{title:'title',body:'text',source_version:'sourceVersion',uploaded_at:'sourceUploadedAt',forgotten_on:'forgottenOn'}));
  data.reviewStates=rows('review_states').map(row=>({...overlay(row,{stage:'stage',interval_days:'intervalDays',next_review_on:'nextReviewOn',last_reviewed_on:'lastReviewedOn',last_rating:'lastRating'}),knowledgePointId:row.knowledge_point_id,pendingForgottenReview:Boolean(row.pending_forgotten)}));
  for(const [key,table] of [['memoryEvents','learning_events'],['reviewLogs','review_logs'],['answerAttempts','answer_attempts'],['answerFeedbacks','answer_feedbacks'],['taskCompletionLogs','task_completion_logs']]) data[key]=rows(table).map(parse);
  data.agentMemory??={version:1};
  data.agentMemory.streams=Object.fromEntries(rows('conversation_scopes').map(row=>[row.id,parse(row)]));
  data.agentMemory.sessions=Object.fromEntries(rows('conversation_sessions').map(row=>[row.id,{...parse(row),events:[]} ]));
  for(const row of db.prepare('SELECT * FROM conversation_events ORDER BY session_id,ordinal').all()) data.agentMemory.sessions[row.session_id].events.push(parse(row));
  data.agentMemory.notes??={};
  for(const row of rows('memory_notes')) {
    const version=db.prepare('SELECT * FROM memory_note_versions WHERE note_id=? ORDER BY version DESC LIMIT 1').get(row.id);
    (data.agentMemory.notes[row.scope_id]??=[]).push({...parse(version),text:row.text});
  }
  data.photoKnowledge??={schemaVersion:1};
  data.photoKnowledge.documents=Object.fromEntries(rows('knowledge_sources').map(row=>[row.id,{...overlay(row,{title:'title',current_version:'currentVersion'}),revisions:[]} ]));
  for(const row of rows('knowledge_revisions')) data.photoKnowledge.documents[row.source_id].revisions.push(parse(row));
  data.photoKnowledge.drafts=Object.fromEntries(rows('processing_jobs').map(row=>[row.id,{...overlay(row,{status:'status'}),versions:[],reads:[],actions:[],assets:[]} ]));
  for(const row of rows('draft_versions')) data.photoKnowledge.drafts[row.job_id].versions.push(parse(row));
  for(const row of rows('job_events')) (data.photoKnowledge.drafts[row.job_id][row.event_type]??=[]).push(parse(row));
  const practiceRows=rows('practice_sessions');
  if(practiceRows.length)data.practiceSessions??={};
  for(const row of practiceRows) {
    if(Array.isArray(data.practiceSessions)) data.practiceSessions.push(parse(row)); else data.practiceSessions[row.id]=parse(row);
  }
  for(const row of rows('channel_records')) {
    const path=row.record_type.split('.');
    if(!get(data,path)) set(data,path,[]);
    get(data,path).push(parse(row));
  }
  data.uploadTranscriptions=Object.fromEntries(rows('upload_transcriptions').map(row=>[row.job_id,{id:row.job_id,title:row.title,version:row.version,updatedAt:row.updated_at,items:JSON.parse(row.items_json),history:[]} ]));
  for(const row of rows('upload_transcription_versions')) data.uploadTranscriptions[row.job_id].history.push({version:row.version,title:row.title,editedAt:row.edited_at,actor:row.actor,items:JSON.parse(row.items_json)});
  return data;
}

/** Stores typed business columns and each event/revision separately in one transaction. */
export function writeRelationalData(db,data,policy={}) {
  const ids=new Map(),statements=new Map();
  function put(table,value) {
    const columns=Object.keys(value),key=table+':'+columns.join(',');
    let statement=statements.get(key);
    if(!statement) {
      const primary=db.prepare(`PRAGMA table_info(${table})`).all().filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>c.name);
      const updates=columns.filter(c=>!primary.includes(c));
      statement=db.prepare(`INSERT INTO ${table} (${columns}) VALUES (${columns.map(()=>'?')}) ON CONFLICT (${primary}) DO UPDATE SET ${updates.map(c=>`${c}=excluded.${c}`).join(',')}`);
      statements.set(key,statement);
      ids.set(table,ids.get(table)||{primary,keys:new Set()});
    }
    statement.run(...columns.map(c=>value[c]??null));
    const track=ids.get(table);track.keys.add(json(track.primary.map(c=>value[c])));
  }
  const learner=data.user.id,now=new Date().toISOString();
  db.pragma('defer_foreign_keys = ON');
  for(const [id,role,name,external] of [[learner,'learner','羊羊',policy.learnerId],['project-admin','admin','管理者',process.env.FEISHU_OWNER_OPEN_ID]]) {
    put('people',{id,display_name:name,role});
    const old=db.prepare('SELECT captured_at FROM role_bindings WHERE person_id=?').get(id);
    put('role_bindings',{person_id:id,role,source:'captured_server_configuration',captured_at:old?.captured_at||now});
    if(external&&policy.appId) put('channel_identities',{id:stableId('identity',id,policy.appId),person_id:id,app_id:policy.appId,channel:'feishu',external_id:external});
  }
  put('learner_profiles',{person_id:learner,exam_goal:data.user.examGoal,study_stage:data.user.studyStage,daily_minutes:data.user.dailyAvailableMinutes,version:data.user.profileVersion,snapshot_json:json(data.user)});
  const memory=data.agentMemory||{},photos=data.photoKnowledge||{},scopes=new Set(Object.keys(memory.streams||{}));
  for(const [id,stream] of entries(memory.streams)) {
    const scope=stream.scope;
    put('conversation_scopes',{id,app_id:scope.appId,channel:scope.channel,chat_type:scope.chatType,chat_id:scope.chatId,peer_id:scope.peerId,thread_id:scope.threadId,snapshot_json:json(stream)});
  }
  for(const [id,session] of entries(memory.sessions)) {
    put('conversation_sessions',{id,scope_id:session.scopeKey,created_at:session.createdAt,archived_at:session.archivedAt,is_current:Number(memory.streams[session.scopeKey]?.sessionId===id),snapshot_json:json(without(session,['events']))});
    list(session.events).forEach((event,i)=>put('conversation_events',{id:stableId('event',id,i,event.eventId??null),session_id:id,ordinal:i,event_type:event.type||'unknown',source_event_id:event.eventId,sender_id:event.senderId,text:event.text||event.user,assistant_text:event.assistant,occurred_at:event.at,snapshot_json:json(event)}));
  }
  for(const [scope,notes] of entries(memory.notes)) list(notes).forEach((note,i)=> {
    const id=stableId('note',scope,i);
    put('memory_notes',{id,scope_id:scope,text:note.text,source_id:note.sourceId,status:'active',created_at:note.at});
    put('memory_note_versions',{id:id+'-v1',note_id:id,version:1,text:note.text,occurred_at:note.at,snapshot_json:json(note)});
  });
  const documents=photos.documents||{},pointIds=new Set(data.knowledgePoints.map(p=>p.id));
  for(const [id,doc] of entries(documents)) {
    put('knowledge_sources',{id,scope_id:scopes.has(doc.scopeKey)?doc.scopeKey:null,title:doc.title,current_version:doc.currentVersion,created_at:doc.createdAt,snapshot_json:json(without(doc,['revisions']))});
    list(doc.revisions).forEach((rev,i)=>put('knowledge_revisions',{id:stableId('revision',id,i),source_id:id,version:rev.version||i+1,occurred_at:rev.savedAt||rev.at,snapshot_json:json(rev)}));
  }
  for(const p of data.knowledgePoints) put('knowledge_points',{id:p.id,source_id:documents[p.sourceDocumentId]?p.sourceDocumentId:null,scope_id:scopes.has(p.sourceScopeKey)?p.sourceScopeKey:null,title:p.title,body:p.text,source_version:p.sourceVersion,uploaded_at:p.sourceUploadedAt,forgotten_on:p.forgottenOn,hidden:Number(Boolean(p.hidden)),origin_status:p.sourceKind==='saved_knowledge'?'manual_upload':'legacy_unknown',snapshot_json:json(p)});
  put('scheduler_configs',{version:'four-rating-v1',name:'四档间隔算法',parameters_json:json({firstIntervals:{again:1,hard:1,good:3,easy:5},multipliers:{hard:1.2,good:2.5,easy:3.8},againInterval:1,newLearningFirstDays:1}),historical_version_known:0});
  for(const s of data.reviewStates) {
    put('review_states',{person_id:learner,knowledge_point_id:s.knowledgePointId,stage:s.stage,interval_days:s.intervalDays,next_review_on:s.nextReviewOn,last_reviewed_on:s.lastReviewedOn,last_rating:s.lastRating,pending_forgotten:Number(Boolean(s.pendingForgottenReview)),scheduler_version:'four-rating-v1',historical_scheduler_version:null,snapshot_json:json(s)});
    const event=data.memoryEvents.find(e=>e.knowledgePointId===s.knowledgePointId);
    put('learning_enrollments',{id:stableId('enrollment',learner,s.knowledgePointId),person_id:learner,knowledge_point_id:s.knowledgePointId,reason:s.pendingForgottenReview?'forgotten_upload':s.stage==='new'?'new_learning':'review_state',enrolled_on:event?.on,source_event_id:event?.id});
  }
  list(data.memoryEvents).forEach((event,i)=>put('learning_events',{id:event.id||stableId('learning',i),person_id:learner,knowledge_point_id:pointIds.has(event.knowledgePointId)?event.knowledgePointId:null,event_type:event.type||'unknown',on_date:event.on,recorded_at:event.recordedAt,snapshot_json:json(event)}));
  for(const [key,table] of [['reviewLogs','review_logs'],['answerAttempts','answer_attempts'],['answerFeedbacks','answer_feedbacks'],['taskCompletionLogs','task_completion_logs']]) list(data[key]).forEach((row,i)=> {
    const columns={id:row.id||stableId(table,i),snapshot_json:json(row)};
    if(table!=='answer_feedbacks') columns.person_id=learner;
    if(['review_logs','answer_attempts'].includes(table)) columns.knowledge_point_id=pointIds.has(row.knowledgePointId)?row.knowledgePointId:null;
    if(table==='review_logs') Object.assign(columns,{rating:row.rating,reviewed_on:row.reviewedOn});
    if(table==='answer_attempts') Object.assign(columns,{answer_text:row.content||row.answer,created_at:row.createdAt});
    if(table==='answer_feedbacks') Object.assign(columns,{attempt_id:row.attemptId,status:row.status,created_at:row.createdAt});
    if(table==='task_completion_logs') Object.assign(columns,{reported_on:row.reportedOn,content:row.content});
    put(table,columns);
  });
  for(const [key,session] of entries(data.practiceSessions)) {
    const task=session.task||{},pointId=task.knowledgePointId||task.id;
    put('practice_sessions',{id:session.id||key,person_id:learner,knowledge_point_id:pointIds.has(pointId)?pointId:null,status:session.status||'legacy_unknown',created_at:session.createdAt,snapshot_json:json(session)});
  }
  for(const [id,job] of entries(photos.drafts)) {
    put('processing_jobs',{id,scope_id:scopes.has(job.scopeKey)?job.scopeKey:null,session_id:job.sessionId,job_type:job.mode||'photo_knowledge',status:job.status,created_at:job.createdAt,source_message_id:job.sourceMessageId,snapshot_json:json(without(job,['versions','reads','actions','assets']))});
    list(job.versions).forEach((v,i)=>put('draft_versions',{id:stableId('draft-version',id,i),job_id:id,version:v.version||i+1,snapshot_json:json(v)}));
    for(const kind of ['reads','actions','assets']) list(job[kind]).forEach((event,i)=>put('job_events',{id:stableId('job-event',id,kind,i),job_id:id,event_type:kind,occurred_at:typeof event?.at==='string'?event.at:null,snapshot_json:json(event)}));
    for(const asset of list(job.assets)) if(/^[a-f0-9]{64}$/.test(asset.sha256)) put('assets',{id:stableId('asset',`knowledge-assets/${asset.sha256}`),relative_path:`knowledge-assets/${asset.sha256}`,sha256:asset.sha256,byte_size:asset.bytes||0});
  }
  const channelPaths=['photoKnowledge.events','feedbackJobs','feishu.sessions','feishu.privateChats','feishu.conversations','feishu.groupCheckinPrompts'];
  for(const path of channelPaths) list(get(data,path.split('.'))).forEach((row,i)=>put('channel_records',{id:stableId('channel-record',path,i),record_type:path,scope_key:row.scopeKey,source_key:row.id||row.openId,snapshot_json:json(row)}));
  for(const [chat,group] of entries(data.feishu?.groupConversations)) for(const [external,member] of entries(group.members)) {
    put('identity_observations',{id:stableId('observation',chat,external),person_id:external===policy.learnerId?learner:external===process.env.FEISHU_OWNER_OPEN_ID?'project-admin':null,scope_id:null,label:member.label,evidence_kind:'legacy_label_source_unknown',observed_at:null,imported_at:db.prepare('SELECT imported_at FROM identity_observations WHERE id=?').get(stableId('observation',chat,external))?.imported_at||now,snapshot_json:json({externalId:external,...member})});
  }
  for(const [id,record] of entries(data.uploadTranscriptions)) {
    put('upload_transcriptions',{job_id:id,title:record.title,version:record.version,updated_at:record.updatedAt,items_json:json(record.items)});
    for(const h of record.history) put('upload_transcription_versions',{job_id:id,version:h.version,title:h.title,edited_at:h.editedAt,actor:h.actor,items_json:json(h.items)});
  }
  const residual=structuredClone(data);
  for(const key of ['user','knowledgePoints','reviewStates','memoryEvents','reviewLogs','answerAttempts','answerFeedbacks','taskCompletionLogs','uploadTranscriptions']) delete residual[key];
  for(const path of [['agentMemory','streams'],['agentMemory','sessions'],['agentMemory','notes'],['photoKnowledge','documents'],['photoKnowledge','drafts'],['practiceSessions'],...channelPaths.map(p=>p.split('.'))]) {
    if(get(residual,path)!==undefined) set(residual,path,Array.isArray(get(residual,path))?[]:{});
  }
  function fragment(value,path) {
    put('runtime_fragments',{path:json(path),value_json:json(value&&typeof value==='object'?(Array.isArray(value)?[]:{}):value)});
    if(value&&typeof value==='object') for(const [key,child] of entries(value)) fragment(child,[...path,Array.isArray(value)?Number(key):key]);
  }
  for(const [key,value] of entries(residual)) fragment(value,[key]);
  // Delete removed mutable rows. Archive/migration evidence and assets stay intact.
  const mutable=['conversation_events','conversation_sessions','memory_note_versions','memory_notes','conversation_scopes','knowledge_revisions','knowledge_sources','review_states','learning_enrollments','knowledge_points','learning_events','review_logs','answer_feedbacks','answer_attempts','task_completion_logs','practice_sessions','draft_versions','job_events','upload_transcription_versions','upload_transcriptions','processing_jobs','channel_records','runtime_fragments'];
  for(const table of mutable) {
    const primary=ids.get(table)?.primary||db.prepare(`PRAGMA table_info(${table})`).all().filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>c.name);
    const keys=ids.get(table)?.keys||new Set(),remove=db.prepare(`DELETE FROM ${table} WHERE ${primary.map(c=>`${c}=?`).join(' AND ')}`);
    for(const row of db.prepare(`SELECT ${primary} FROM ${table}`).all()) if(!keys.has(json(primary.map(c=>row[c])))) remove.run(...primary.map(c=>row[c]));
  }
  if(db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('relational_foreign_key_failure');
}
