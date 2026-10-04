import { todayKey } from '../domain/date.js';
import { activeStudyPoints } from '../knowledge/library.js';

/** Once per Beijing calendar day. Sending never records a review or changes its date. */
export class ReviewReminders {
  constructor({repository,send,chatId,learnerId,now=()=>new Date(),logger=console}) {Object.assign(this,{repository,send,chatId,learnerId,now,logger});this.running=false;}
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
        const eligible=new Set(activeStudyPoints(data).map(p=>p.id)),due=data.reviewStates.filter(s=>eligible.has(s.knowledgePointId)&&s.nextReviewOn<=day);
        if(!due.length)return null;
        const record={day,status:'sending',claimedAt:now.toISOString(),knowledgePointIds:due.map(s=>s.knowledgePointId)};
        data.reminderDeliveries[day]=record;
        return record;
      });
      if(!notice)return;
      try {
        const sent=await this.send(this.chatId,{text:`羊羊，今天有 ${notice.knowledgePointIds.length} 个知识点到期或需要补复习。先合上资料试着回忆，再背诵；完成后按真实感受自评。可以发送“今天复习什么”查看安排。`});
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
