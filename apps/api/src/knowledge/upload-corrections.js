const fault=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
const clone=value=>structuredClone(value);

export function ensureUploadTranscriptions(data) {
  data.uploadTranscriptions??={};
  for(const [id,job] of Object.entries(data.photoKnowledge?.drafts||{})) {
    const points=data.knowledgePoints.filter(p=>p.sourceDocumentId===id&&!p.archived);
    const content=job.sourceContent||job.versions?.at(-1)?.content||{};
    const items=points.length?points.map(p=>({id:p.id,knowledgePointId:p.id,title:p.title,text:p.text||''})):Array.isArray(content.items)?content.items.map((p,i)=>({id:p.id||`item-${i}`,knowledgePointId:null,title:p.title||`原文段落 ${i+1}`,text:p.text||''})):[];
    const title=content.title||data.photoKnowledge?.documents?.[id]?.title||'待转写的上传图片';
    const current=data.uploadTranscriptions[id];
    if(current) {
      if(!current.items.length&&items.length) { const at=new Date().toISOString();current.items=items;current.title=title;current.version++;current.updatedAt=at;current.history.push({version:current.version,title,editedAt:at,actor:'machine-transcription',items:clone(items)}); }
      continue;
    }
    data.uploadTranscriptions[id]={id,title,version:1,updatedAt:null,items,history:[{version:1,title,editedAt:new Date().toISOString(),actor:'migration-original',items:clone(items)}]};
  }
}

export class UploadCorrections {
  constructor(repository){this.repository=repository;}
  async save(id,body,actor) {
    if(actor?.role!=='admin')throw fault('只有管理员可校正上传记录。',403);
    return this.repository.mutate(data=> {
      ensureUploadTranscriptions(data);
      const current=data.uploadTranscriptions[id];
      if(!current)throw fault('上传记录不存在。',404);
      if(body.expectedVersion!==current.version)throw fault('此记录已更新，请重新打开后再校正。',409);
      const title=typeof body.title==='string'?body.title.trim():'',items=body.items;
      if(!title||title.length>200||!Array.isArray(items)||items.length>200)throw fault('转写内容格式不正确。');
      const old=new Map(current.items.map(p=>[p.id,p]));
      const identifiers=new Set();
      for(const item of items) {
        if(!item||typeof item.id!=='string'||!item.id||item.id.length>200||identifiers.has(item.id)||typeof item.title!=='string'||!item.title.trim()||item.title.length>200||typeof item.text!=='string'||item.text.length>30000)throw fault('知识点标题或正文格式不正确。');
        identifiers.add(item.id);
        if((item.knowledgePointId??null)!==(old.get(item.id)?.knowledgePointId??null))throw fault('不能改变知识点关联。');
      }
      if([...old.keys()].some(key=>!identifiers.has(key)))throw fault('文字校正不能删除已有知识点。');
      const normalized=items.map(i=>({id:i.id,knowledgePointId:i.knowledgePointId??null,title:i.title.trim(),text:i.text}));
      const doc=data.photoKnowledge?.documents?.[id],job=data.photoKnowledge.drafts[id];
      const linked=data.knowledgePoints.filter(p=>p.sourceDocumentId===id),oldKind=doc?.learningKind||job.learningKind||(linked.some(p=>p.forgottenOn)?'forgotten':'record');
      const kind=body.learningKind??oldKind;
      if(!['learn','forgotten','record'].includes(kind))throw fault('学习用途格式不正确。');
      const kindChanged=kind!==oldKind;
      if(kindChanged&&data.reviewStates.some(s=>linked.some(p=>p.id===s.knowledgePointId)))throw fault('已有复习记录，请保留学习用途并校正文字。',409);
      if(title===current.title&&JSON.stringify(normalized)===JSON.stringify(current.items)&&!kindChanged)return {saved:true,unchanged:true,version:current.version};
      if(kindChanged){job.learningKind=kind;if(doc)doc.learningKind=kind;}
      const now=new Date().toISOString(),version=current.version+1;
      current.title=title;current.items=normalized;current.version=version;current.updatedAt=now;
      current.history.push({version,title,editedAt:now,actor:actor.id,items:clone(normalized)});
      if(doc) {
        const original=doc.revisions.find(r=>r.version===doc.currentVersion);
        if(original) {
          const revision=clone(original);revision.version=doc.currentVersion+1;revision.title=title;revision.savedAt=now;revision.correctedBy=actor.id;
          for(const item of normalized) {
            if(!item.knowledgePointId)continue;
            const point=data.knowledgePoints.find(p=>p.id===item.knowledgePointId&&p.sourceDocumentId===id);
            if(!point)throw fault('关联知识点已变化，请重新打开。',409);
            const segment=revision.items.find(i=>i.id===point.sourceItemId);
            if(!segment)throw fault('原文段落已变化，请重新打开。',409);
            segment.title=item.title;segment.text=item.text;segment.transcriptionStatus='human_corrected';
          }
          doc.revisions.push(revision);doc.currentVersion=revision.version;doc.title=title;
        }
      } else {
        // Corrections to an unpublished draft stay drafts; they do not enroll points.
        const job=data.photoKnowledge.drafts[id],previous=job.versions?.at(-1)||{};
        job.versions??=[];
        const content={...(previous.content||job.sourceContent||{}),title,items:normalized.map(i=>({...i,id:old.get(i.id)?.id||i.id}))};
        job.versions.push({...clone(previous),version:(previous.version||0)+1,content,correctedBy:actor.id,createdAt:now});
        if(job.sourceContent)job.sourceContent=clone(content);
      }
      return {saved:true,version};
    });
  }
}
