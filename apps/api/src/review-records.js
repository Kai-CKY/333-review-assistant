import { todayKey } from './domain/date.js';

export class ReviewRecords {
  constructor(repository) {this.repository=repository;}
  async view(query={}) {
    const data=await this.repository.read(),today=todayKey();
    const month=/^\d{4}-(0[1-9]|1[0-2])$/.test(query.month||'')?query.month:today.slice(0,7);
    const points=data.knowledgePoints.filter(p=>!p.hidden&&!p.archived&&p.practiceEligible!==false).flatMap(p=>{
      const state=data.reviewStates.find(s=>s.knowledgePointId===p.id);
      return state?[{id:p.id,title:p.title,source:p.sourceTitle||p.sourceLabel||'手动上传',sourceId:p.sourceDocumentId||null,sourceVersion:p.sourceVersion||null,due:state.nextReviewOn||null,lastRating:state.lastRating||null,kind:state.pendingForgottenReview?'forgotten':state.stage==='new'?'learn':'review'}]:[];
    });
    const records=data.reviewLogs.map(r=>{
      const attempt=r.attemptId?data.answerAttempts.find(a=>a.id===r.attemptId):r.sourceId?.startsWith('review:')?data.answerAttempts.find(a=>a.sourceId===r.sourceId.slice(7)):null;
      return {...r,title:points.find(p=>p.id===r.knowledgePointId)?.title||data.knowledgePoints.find(p=>p.id===r.knowledgePointId)?.title||r.knowledgePointId,
        reviewedAt:r.reviewedAt||null,recordedAt:r.recordedAt||null,attempt:attempt||null,
        feedback:attempt?data.answerFeedbacks.filter(f=>f.attemptId===attempt.id):[],
        currentState:data.reviewStates.find(s=>s.knowledgePointId===r.knowledgePointId)||null};
    });
    const attempts=data.answerAttempts.map(a=>({...a,title:data.knowledgePoints.find(p=>p.id===a.knowledgePointId)?.title||a.knowledgePointId,submittedAt:a.submittedAt||null,reviewId:records.find(r=>r.attempt?.id===a.id)?.id||null,feedback:data.answerFeedbacks.filter(f=>f.attemptId===a.id)}));
    const opened=Object.values(data.practiceSessions||{}).map(s=>({id:s.id,knowledgePointId:s.knowledgePointId||s.task?.knowledgePointId,title:s.task?.title||'',createdAt:s.createdAt||null,actorId:s.owner||s.actorId||null}));
    return {today,month,points,overdue:points.filter(p=>p.due&&p.due<today),due:points.filter(p=>p.due===today),
      records:records.filter(r=>r.reviewedOn?.startsWith(month)).sort((a,b)=>(b.reviewedAt||b.reviewedOn).localeCompare(a.reviewedAt||a.reviewedOn)),
      attempts:attempts.filter(a=>a.submittedOn?.startsWith(month)),opened:opened.filter(s=>s.createdAt&&todayKey(new Date(s.createdAt)).startsWith(month)),
      completedToday:records.filter(r=>r.reviewedOn===today).length,completedPointsToday:new Set(records.filter(r=>r.reviewedOn===today).map(r=>r.knowledgePointId)).size};
  }
}
