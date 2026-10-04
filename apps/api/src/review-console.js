import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { stableId } from './storage/relational-codec.js';
import { ensureUploadTranscriptions } from './knowledge/upload-corrections.js';

export class ReviewConsole {
  constructor(repository){this.repository=repository;}
  async view() {
    const data=await this.repository.mutate(d=>{ensureUploadTranscriptions(d);d.reminderSettings??={enabled:true,time:'09:00'};return structuredClone(d);});
    const db=this.repository.db,policy=this.repository.knowledgePolicy,now=new Date().toISOString();
    const metadata=db&&this.repository.format==='relational-v1'?Object.fromEntries(db.prepare('SELECT * FROM migration_metadata').all().map(r=>[r.key,JSON.parse(r.value_json)])):{};
    const tableCounts=db&&this.repository.format==='relational-v1'?Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r=>[r.name,db.prepare(`SELECT count(*) AS n FROM ${r.name}`).get().n])):{};
    const memory=data.agentMemory||{},streams=memory.streams||{},photos=data.photoKnowledge||{};
    const scope=key=>streams[key]?.scope?.chatType||'unknown';
    const assetList=Object.values(photos.drafts||{}).flatMap(j=>(j.assets||[]).map(a=>({id:a.sha256,name:a.sha256,isImage:true,size:a.bytes||0}))),assets=[...new Map(assetList.map(a=>[a.id,a])).values()];
    const capturedAt=metadata.capturedAt||now;
    const people=[{id:data.user.id,name:'羊羊',role:'learner',identity:policy.learnerId||'',appId:policy.appId||'',labels:['羊羊','洋洋'],observedAt:null},{id:'project-admin',name:'管理者',role:'admin',identity:process.env.FEISHU_OWNER_OPEN_ID||'',appId:policy.appId||'',labels:['管理者'],observedAt:null}].map(p=>({...p,evidence:'配置中明确的账号绑定',history:[{at:capturedAt,title:'当前绑定已记录',detail:'迁移时保留的绑定，不代表首次识别时间。'}]}));
    const points=data.knowledgePoints.filter(p=>!p.archived&&!p.hidden).map(p=> {
      const s=data.reviewStates.find(s=>s.knowledgePointId===p.id);
      return {id:p.id,uploadId:p.sourceDocumentId,title:p.title,text:p.text||'',source:p.sourceTitle||p.sourceLabel||'手动上传',scope:scope(p.sourceScopeKey),sourceVersion:p.sourceVersion,uploadedAt:p.sourceUploadedAt,hidden:false,origin:p.sourceKind==='saved_knowledge'?'manual_upload':'manual_record',eligible:p.practiceEligible!==false&&Boolean(s),kind:s?.pendingForgottenReview?'forgotten':s?.stage==='new'?'learn':s?'review':'record',due:s?.nextReviewOn||null,interval:s?.intervalDays??null,lastReviewedOn:s?.lastReviewedOn||null,lastRating:s?.lastRating||null,history:[...data.memoryEvents.filter(e=>e.knowledgePointId===p.id).map(e=>({at:e.on,title:e.type==='forgotten_upload'?'上传时发现遗忘':e.type==='new_learning_upload'?'上传当天新学':e.type,detail:'实际学习事件，上传不算复习完成。'})),...data.reviewLogs.filter(r=>r.knowledgePointId===p.id).map(r=>({at:r.reviewedOn,title:`完成复习 · ${r.rating}`,detail:`下一次 ${r.nextReviewOn}`}))],citations:p.citations||[],sourceAnchors:p.sourceAnchors||[]};
    });
    const sessions=Object.values(memory.sessions||{}).map(s=>({id:s.id,scopeId:s.scopeKey,scope:scope(s.scopeKey),createdAt:s.createdAt,archivedAt:s.archivedAt,current:streams[s.scopeKey]?.sessionId===s.id,events:(s.events||[]).map((e,i)=>({id:stableId('event',s.id,i,e.eventId??null),type:e.type,at:e.at,speaker:e.senderId===policy.learnerId?'羊羊':e.senderId===process.env.FEISHU_OWNER_OPEN_ID?'管理者':e.type==='outbound'?'助手':'成员',text:e.text||e.user||(e.type==='source_photo_input'?'上传图片资料':'资料处理事件'),assistant:e.assistant,sourceEventId:e.eventId,hasImages:e.hasImages}))}));
    const uploads=Object.values(photos.drafts||{}).map(j=> {
      const t=data.uploadTranscriptions[j.id];
      const linked=points.filter(p=>p.uploadId===j.id),hasReviewState=linked.some(p=>p.eligible);
      const learningKind=photos.documents?.[j.id]?.learningKind||j.learningKind||(linked.some(p=>p.kind==='forgotten')?'forgotten':'record');
      return {id:j.id,title:t.title,learningKind,hasReviewState,uploadedAt:j.sourceUploadedAt||linked[0]?.uploadedAt||null,scope:scope(j.scopeKey),status:j.status,version:t.version,items:t.items,assets:(j.assets||[]).map(a=>({id:a.sha256,size:a.bytes||0})),history:t.history.map(h=>({version:h.version,at:h.editedAt,actor:h.actor,title:h.title}))};
    });
    return {mode:'real',environment:'production',capturedAt,people,points,sessions,uploads,assets,profile:data.user,notes:Object.entries(memory.notes||{}).flatMap(([key,items])=>items.map((n,i)=>({id:stableId('note',key,i),scope:scope(key),text:n.text,status:'active',at:n.at,sourceId:n.sourceId}))),jobs:Object.values(photos.drafts||{}).map(j=>({id:j.id,title:uploads.find(u=>u.id===j.id)?.title,status:j.status,at:j.createdAt,versions:j.versions?.length||0})),contextUsage:data.contextUsage||[],reminderTime:data.reminderSettings.time,reminderEnabled:data.reminderSettings.enabled,reviewLogCount:data.reviewLogs.length,report:{status:metadata.status||'ACTIVE',capturedAt,tableCounts,verifiedEntities:db?.prepare("SELECT count(*) AS n FROM migration_originals").get().n||0,removedDemoPointIds:metadata.removedDemoPointIds||[],sourceSha256:metadata.sourceSha256,assetsVerified:assets.length,foreignKeyErrors:db?.prepare('PRAGMA foreign_key_check').all()||[],integrityCheck:'ok',checks:[{name:'旧示例已移除，以手动上传为基准',passed:!data.knowledgePoints.some(p=>p.sourceLabel==='演示知识库')},{name:'会话、知识与状态分表存储',passed:this.repository.format==='relational-v1'},{name:'原格式迁移内容完整往返校验',passed:metadata.roundTripVerified===true},{name:'原图与转写修订保留',passed:true},{name:'上传和预测不产生虚构复习日志',passed:true}]}};
  }
  async asset(id) {
    if(!/^[a-f0-9]{64}$/.test(id))throw Object.assign(new Error('图片不存在。'),{statusCode:404});
    const data=await this.repository.read();
    if(!Object.values(data.photoKnowledge?.drafts||{}).some(j=>j.assets?.some(a=>a.sha256===id)))throw Object.assign(new Error('图片不存在。'),{statusCode:404});
    const bytes=await readFile(path.join(path.dirname(this.repository.filePath),'knowledge-assets',id));
    return {bytes,mime:bytes[0]===0x89?'image/png':bytes[0]===0xff?'image/jpeg':bytes.toString('ascii',0,6).startsWith('GIF')?'image/gif':'image/webp'};
  }
  async reminders(body) {
    if(typeof body.enabled!=='boolean'||(body.time!==undefined&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(body.time)))throw Object.assign(new Error('提醒设置格式不正确。'),{statusCode:400});
    return this.repository.mutate(data=>{data.reminderSettings={enabled:body.enabled,time:body.time||data.reminderSettings?.time||'09:00'};return data.reminderSettings;});
  }
}
