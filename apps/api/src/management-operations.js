import { createHash } from 'node:crypto';
import * as lark from '@larksuiteoapi/node-sdk';
import { conversationScope, ConversationMemory } from './agent/memory.js';

const error=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
function checked(result){if(result?.code!==0)throw error('飞书请求未确认成功',502);return result.data;}
export function managementTransport() {
  if(!process.env.FEISHU_APP_ID||!process.env.FEISHU_APP_SECRET)return null;
  const client=new lark.Client({appId:process.env.FEISHU_APP_ID,appSecret:process.env.FEISHU_APP_SECRET,loggerLevel:lark.LoggerLevel.error});
  return {
    async group(id){return checked(await client.im.chat.get({path:{chat_id:id}}));},
    async members(id){let page_token;const items=[];do{const data=checked(await client.im.chatMembers.get({path:{chat_id:id},params:{member_id_type:'open_id',page_size:100,...(page_token?{page_token}:{})}}));items.push(...(data.items||[]));page_token=data.has_more?data.page_token:null;}while(page_token&&items.length<10000);return items;},
    async send(input){return checked(await client.im.message.create({params:{receive_id_type:'chat_id'},data:{receive_id:input.chatId,msg_type:'text',content:JSON.stringify({text:input.text}),uuid:input.id}}));},
    async message(id){return checked(await client.im.message.get({path:{message_id:id}}));}
  };
}
export class ManagementOperations {
  constructor(repository,ledger,{transport=managementTransport()}={}) {Object.assign(this,{repository,ledger,transport});this.locks=new Map();this.memory=new ConversationMemory(repository);}
  async preview(input) {
    if(!/^oc_[A-Za-z0-9]+$/.test(input?.chatId||'')||typeof input.text!=='string'||!input.text.trim()||input.text.length>6000||input.text.includes('<at'))throw error('群 ID 或正文无效；请使用独立 @ 字段');
    if(input.threadId)throw error('首版发送到指定群；历史话题由补记原回执关联');
    if(!this.transport)throw error('飞书未配置',503);
    if(input.mentions!==undefined&&!Array.isArray(input.mentions))throw error('@ 字段应为账号列表');
    const group=await this.transport.group(input.chatId),ids=[...new Set(input.mentions||[])];
    if(ids.length>10||ids.some(id=>!/^ou_[A-Za-z0-9]+$/.test(id)))throw error('@ 账号标识无效');
    const members=ids.length?await this.transport.members(input.chatId):[];
    const mentions=ids.map(id=>{const m=members.find(m=>(m.member_id||m.open_id)===id);if(!m)throw error('被 @ 的账号不是目标群成员');return {id,name:String(m.name||'群成员').replace(/[<>"&]/g,'')};});
    const text=[...mentions.map(m=>`<at user_id="${m.id}">${m.name}</at>`),input.text.trim()].join(' ');
    return {chatId:input.chatId,chatName:group.name||input.chatId,text,mentions};
  }
  async execute(input,actor) {
    if(actor?.role!=='admin')throw error('仅管理员可执行',403);
    if(typeof input.requestId!=='string'||!/^[\w:.-]{8,120}$/.test(input.requestId))throw error('需要稳定的请求 ID');
    const id=createHash('sha256').update(actor.id+'\0'+input.requestId).digest('hex').slice(0,32);
    if(this.locks.has(id)){await this.locks.get(id);return this.execute(input,actor);}
    const operation=this.executeOnce(id,input,actor);this.locks.set(id,operation);
    try{return await operation;}finally{this.locks.delete(id);}
  }
  async executeOnce(id,input,actor) {
    const fingerprint=createHash('sha256').update(JSON.stringify({chatId:input.chatId,text:input.text,mentions:input.mentions||[],threadId:input.threadId||''})).digest('hex');
    const prior=await this.ledger.get('management_operations',id);
    if(prior){if(prior.fingerprint!==fingerprint)throw error('请求 ID 已用于不同操作',409);return {...prior,idempotent:true};}
    const preview=await this.preview(input),scope=conversationScope({appId:process.env.FEISHU_APP_ID||'333',chatType:'group',chatId:preview.chatId});
    const session=await this.memory.session(scope);
    let record=await this.ledger.put('management_operations',id,{...preview,fingerprint,requestId:input.requestId,actorId:actor.id,authorization:'admin',executionSource:input.executionSource==='codex'?'codex':'web',kind:'send',status:'sending',scopeKey:scope.key,sessionId:session.id,summary:String(input.summary||'管理者群消息').slice(0,1000),createdAt:new Date().toISOString()});
    try {
      const result=await this.transport.send({...preview,id});
      if(!result.message_id)throw error('缺少发送回执',502);
      record={...record,status:'sent',messageId:result.message_id,occurredAt:new Date().toISOString()};
      await this.ledger.put('management_operations',id,record);
      await this.memory.append(scope,{type:'management_operation',eventId:'management:'+id,text:preview.text,operationId:id,messageId:record.messageId,actorId:actor.id,status:'sent'});
      return record;
    } catch(e) {
      // Unknown stays non-retryable, including successful send followed by a local write failure.
      const uncertain={...record,status:record.messageId?'sent':'unknown',memoryPending:Boolean(record.messageId),errorCode:'delivery_or_record_unconfirmed'};
      await this.ledger.put('management_operations',id,uncertain);return uncertain;
    }
  }
  async list(){return this.ledger.rows('management_operations');}
  async reconcile(id,input,actor) {
    if(actor.role!=='admin')throw error('仅管理员可核实',403);
    const record=await this.ledger.get('management_operations',id);if(!record)throw error('操作不存在',404);
    if(!this.transport)throw error('飞书未配置',503);
    const messageId=record.messageId||input.messageId;
    if(!/^om_[A-Za-z0-9]+$/.test(messageId||''))throw error('需要真实飞书消息 ID');
    const response=await this.transport.message(messageId),message=response.items?.find(m=>m.message_id===messageId);
    let text;try{text=JSON.parse(message?.body?.content||'{}').text;}catch{}
    if(!message||message.chat_id!==record.chatId||text!==record.text)throw error('回执与目标或正文不符');
    const saved=await this.ledger.put('management_operations',id,{...record,status:'sent',messageId,verifiedAt:new Date().toISOString(),verifiedBy:actor.id,memoryPending:false});
    const scope=conversationScope({appId:process.env.FEISHU_APP_ID||'333',chatType:'group',chatId:record.chatId});
    await this.memory.append(scope,{type:'management_operation',eventId:'management:'+id,text:record.text,operationId:id,messageId,status:'sent',actorId:record.actorId});return saved;
  }
  async record(input,actor) {
    if(actor.role!=='admin')throw error('仅管理员可登记',403);
    if(typeof input.requestId!=='string'||input.requestId.length<8||typeof input.summary!=='string'||!input.summary.trim()||input.summary.length>3000||!input.occurredAt||!Number.isFinite(Date.parse(input.occurredAt)))throw error('补记需要请求 ID、摘要及实际执行时间');
    const id=createHash('sha256').update(actor.id+'\0record\0'+input.requestId).digest('hex').slice(0,32),prior=await this.ledger.get('management_operations',id);
    const fingerprint=createHash('sha256').update(JSON.stringify({summary:input.summary,occurredAt:input.occurredAt,chatId:input.chatId||null,threadId:input.threadId||null,publicText:input.publicText||'',evidence:input.evidence||'',executionSource:input.executionSource||'codex'})).digest('hex');
    if(prior){if(prior.fingerprint!==fingerprint)throw error('请求 ID 已用于不同补记',409);return {...prior,idempotent:true};}
    if(input.chatId&&!/^oc_[A-Za-z0-9]+$/.test(input.chatId))throw error('群 ID 无效');
    if(input.threadId&&!/^omt_[A-Za-z0-9]+$/.test(input.threadId))throw error('话题 ID 无效');
    let scope,session;
    if(input.chatId){scope=conversationScope({appId:process.env.FEISHU_APP_ID||'333',chatType:'group',chatId:input.chatId,threadId:String(input.threadId||'')});session=await this.memory.session(scope);}
    const record=await this.ledger.put('management_operations',id,{kind:'external_record',status:'recorded',fingerprint,summary:input.summary,publicText:String(input.publicText||'').slice(0,6000),evidence:String(input.evidence||'').slice(0,6000),verification:'manager_recorded',actorId:actor.id,executionSource:String(input.executionSource||'codex').slice(0,80),occurredAt:new Date(input.occurredAt).toISOString(),recordedAt:new Date().toISOString(),scopeKey:scope?.key||null,sessionId:session?.id||null,chatId:input.chatId||null});
    if(scope&&record.publicText)await this.memory.append(scope,{type:'management_operation',eventId:'management:'+id,text:record.publicText,operationId:id,status:'recorded',actorId:actor.id});
    return record;
  }
}
