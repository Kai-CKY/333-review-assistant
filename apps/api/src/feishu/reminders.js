import { randomInt } from 'node:crypto';
import { todayKey } from '../domain/date.js';
import { activeStudyPoints } from '../knowledge/library.js';

export function sampleDailyReview(data, day, pickIndex = randomInt) {
  const dueIds = new Set(data.reviewStates.filter(s => s.nextReviewOn <= day).map(s => s.knowledgePointId));
  const candidates = activeStudyPoints(data).filter(p => dueIds.has(p.id));
  const selected = [];
  while (selected.length < 5 && candidates.length) {
    selected.push(candidates.splice(pickIndex(candidates.length), 1)[0]);
  }
  return selected;
}

/** Once per Beijing calendar day. Sending never records a review or changes its date. */
export class ReviewReminders {
  constructor({repository,send,chatId,learnerId,now=()=>new Date(),logger=console,pickIndex=randomInt}) {Object.assign(this,{repository,send,chatId,learnerId,now,logger,pickIndex});this.running=false;}
  async tick() {
    if(this.running||!this.chatId||!this.learnerId)return;
    this.running=true;
    try {
      const now=this.now(),day=todayKey(now),time=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hour12:false}).format(now);
      const settings=(await this.repository.read()).reminderSettings||{enabled:true,time:'09:00'};
      if(!settings.enabled||settings.time!==time)return;
      const notice=await this.repository.mutate(data=> {
        const setting=data.reminderSettings||{enabled:true,time:'09:00'};
        if(!setting.enabled||setting.time!==time)return null;
        data.reminderDeliveries??={};
        if(data.reminderDeliveries[day])return null;
        const selected=sampleDailyReview(data,day,this.pickIndex);
        if(!selected.length)return null;
        const record={day,status:'sending',claimedAt:now.toISOString(),selectionMode:'random_due',knowledgePointIds:selected.map(p=>p.id),titles:selected.map(p=>p.title)};
        data.reminderDeliveries[day]=record;
        return record;
      });
      if(!notice)return;
      try {
        const topics=notice.titles.map((title,index)=>`${index+1}. ${String(title).replace(/[\r\n]+/g,' ').slice(0,180)}`).join('\n');
        const sent=await this.send(this.chatId,{text:`羊羊，今天随机抽查 ${notice.knowledgePointIds.length} 个知识点：\n${topics}\n\n先合上资料，逐个回忆关键要点，再对照笔记查漏补缺；复习后按真实感受自评。今天先完成这几个就好。`});
        await this.repository.mutate(data=>Object.assign(data.reminderDeliveries[day],{status:'sent',sentAt:this.now().toISOString(),messageId:sent?.messageId||null}));
      }catch(error) {
        // Retain ambiguous failures to avoid a duplicate if Feishu accepted the send.
        await this.repository.mutate(data=>Object.assign(data.reminderDeliveries[day],{status:'failed',errorCode:'reminder_send_failed'}));
        this.logger.warn('Review reminder send failed; automatic duplicate retry suppressed.');
      }
    }finally{this.running=false;}
  }
  start(){this.timer=setInterval(()=>{void this.tick().catch(()=>this.logger.warn('Review reminder check failed.'));},30000);this.timer.unref?.();}
  stop(){clearInterval(this.timer);}
}
