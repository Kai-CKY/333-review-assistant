import { createHash } from 'node:crypto';
import { migrateRuntime,ledgerColumns } from './storage/runtime-migrations.js';
import { todayKey } from './domain/date.js';
import { normalizeUsage } from './model-usage.js';

const tables=new Set(['model_requests','model_price_versions','cost_budget_settings','cost_budget_alerts','cost_official_statements','management_operations']);
const bad=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
const numeric=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const validDay=value=>/^\d{4}-\d{2}-\d{2}$/.test(value||'')&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
export class RuntimeLedger {
  constructor(repository,{environment=process.env.RUNTIME_ENV||(process.env.FEISHU_ENABLED==='true'?'prod':'local')}={}) {
    this.repository=repository;this.environment=environment;
    if(repository.format==='relational-v1')migrateRuntime(repository.db);
  }
  async initialize() {
    const id='doubao-pro-260915-standard-20261006';
    if(!await this.get('model_price_versions',id))await this.put('model_price_versions',id,{id,model:'doubao-seed-2-1-pro-260915',tier:'default',input:6,cached:1.2,output:30,effectiveFrom:'2026-10-06T00:00:00+08:00',source:'https://docs.volcengine.com/docs/ark/model-pricing?lang=zh',verifiedAt:'2026-10-06',createdAt:new Date().toISOString()});
    for(const r of await this.rows('model_requests'))if(r.status==='running')await this.put('model_requests',r.id,{...r,status:'interrupted',businessStatus:'unknown',endedAt:new Date().toISOString()});
    for(const r of await this.rows('management_operations'))if(r.status==='sending')await this.put('management_operations',r.id,{...r,status:'unknown',errorCode:'process_interrupted'});
  }
  async get(table,id) {
    if(!tables.has(table))throw bad('invalid_ledger_table');
    if(this.repository.format==='relational-v1') {await this.repository.mutationQueue;const row=this.repository.db.prepare(`SELECT record_json FROM ${table} WHERE id=?`).get(id);return row?JSON.parse(row.record_json):null;}
    return (await this.repository.read()).runtimeLedger?.[table]?.[id]||null;
  }
  async rows(table,filter={}) {
    if(!tables.has(table))throw bad('invalid_ledger_table');
    if(this.repository.format==='relational-v1') {
      await this.repository.mutationQueue;
      const conditions=[],params=[];
      if(filter.environment&&filter.environment!=='all'){conditions.push('environment=?');params.push(filter.environment);}
      if(filter.from){conditions.push('created_at>=?');params.push(filter.from);}
      if(filter.to){conditions.push('created_at<?');params.push(filter.to);}
      if(filter.taskId){conditions.push('task_id=?');params.push(filter.taskId);}
      return this.repository.db.prepare(`SELECT record_json FROM ${table}${conditions.length?' WHERE '+conditions.join(' AND '):''} ORDER BY created_at DESC,id`).all(...params).map(r=>JSON.parse(r.record_json));
    }
    return Object.values((await this.repository.read()).runtimeLedger?.[table]||{}).filter(r=>(!filter.environment||filter.environment==='all'||r.environment===filter.environment)&&(!filter.from||(r.startedAt||r.createdAt)>=filter.from)&&(!filter.to||(r.startedAt||r.createdAt)<filter.to)&&(!filter.taskId||r.taskId===filter.taskId)).sort((a,b)=>(b.startedAt||b.createdAt).localeCompare(a.startedAt||a.createdAt));
  }
  async put(table,id,record) {
    if(!tables.has(table))throw bad('invalid_ledger_table');
    if(table==='model_requests') {
      const previous=await this.get(table,id);
      // Preserve the request's adopted price; never reprice historical rows silently.
      const priceId=previous?.priceVersion||record.priceVersion;
      const prices=priceId?[await this.get('model_price_versions',priceId)] : await this.rows('model_price_versions');
      const price=prices.filter(p=>p&&p.model===record.model&&p.tier===(record.serviceTier||'default')&&Date.parse(p.effectiveFrom)<=Date.parse(record.startedAt)).sort((a,b)=>Date.parse(b.effectiveFrom)-Date.parse(a.effectiveFrom))[0];
      record={...record,...normalizeUsage(record.rawUsage)};
      if(price){record.priceVersion=price.id;record.nanoCost=record.input!==null&&record.output!==null&&record.cached!==null&&record.cached<=record.input?Math.round(((record.input-record.cached)*price.input+record.cached*price.cached+record.output*price.output)*1000):null;}
      record.toolCostUnknown=record.toolCalls>0;
    }
    const saved={...record,id,createdAt:record.createdAt||record.startedAt||new Date().toISOString()};
    if(this.repository.format==='relational-v1') {
      // Join the same queue as domain writes without rebuilding domain state.
      const extra=Object.entries(ledgerColumns[table]||{}),columns=['id','created_at','environment','task_id','purpose','status','record_json',...extra.map(([name])=>name)];
      const values=[id,saved.createdAt,saved.environment||null,saved.taskId||null,saved.purpose||null,saved.status||null,JSON.stringify(saved),...extra.map(([, [field]])=>saved[field]??null)];
      const operation=this.repository.mutationQueue.then(()=>this.repository.db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${columns.slice(2).map(c=>c+'=excluded.'+c).join(',')}`).run(...values));
      this.repository.mutationQueue=operation.catch(()=>{});await operation;
    } else await this.repository.mutate(d=>{d.runtimeLedger??={};d.runtimeLedger[table]??={};d.runtimeLedger[table][id]=saved;});
    return saved;
  }
  summary(rows) {
    const sum=k=>rows.reduce((n,r)=>n+(r[k]??0),0);
    return {count:rows.length,input:sum('input'),output:sum('output'),cached:sum('cached'),reasoning:sum('reasoning'),tokens:sum('input')+sum('output'),nanoCost:sum('nanoCost'),unknown:rows.filter(r=>r.usageStatus!=='known').length,unpriced:rows.filter(r=>r.nanoCost===null&&r.usageStatus==='known').length,toolUnpriced:rows.filter(r=>r.toolCostUnknown).length,running:rows.filter(r=>r.status==='running').length};
  }
  async budget(input=null,actor=null) {
    if(input) {
      for(const field of ['daily','monthly'])if(input[field]!==null&&(!numeric(input[field])||input[field]<=0||input[field]>1000000))throw bad('预算金额无效');
      const prev=await this.get('cost_budget_settings','current');
      await this.put('cost_budget_settings','current',{daily:input.daily,monthly:input.monthly,version:(prev?.version||0)+1,actorId:actor?.id,policy:'warn_continue'});
      await this.checkBudgets();
    }
    return await this.get('cost_budget_settings','current')||{daily:null,monthly:null,version:0,policy:'warn_continue'};
  }
  async checkBudgets() {
    const b=await this.get('cost_budget_settings','current');if(!b)return;
    const today=todayKey();
    for(const [period,prefix,amount] of [['daily',today,b.daily],['monthly',today.slice(0,7),b.monthly]]) {
      if(!amount)continue;
      const rows=(await this.rows('model_requests',{environment:'prod'})).filter(r=>todayKey(new Date(r.startedAt)).startsWith(prefix));
      const s=this.summary(rows),percentage=s.nanoCost/1e9/amount*100;
      for(const threshold of [80,100])if(percentage>=threshold){const id=`${period}:${prefix}:${b.version}:${threshold}`;if(!await this.get('cost_budget_alerts',id))await this.put('cost_budget_alerts',id,{environment:'prod',period,prefix,version:b.version,threshold,nanoCost:s.nanoCost,policy:'warn_continue'});}
    }
  }
  async view(query={}) {
    const environment=['prod','test','local','all'].includes(query.environment)?query.environment:this.environment;
    const period=['today','week','month'].includes(query.period)?query.period:'month';
    const today=todayKey(),start=period==='month'?today.slice(0,7)+'-01':period==='today'?today:shift(today,-6);
    const from=new Date(start+'T00:00:00+08:00').toISOString(),to=new Date(shift(today,1)+'T00:00:00+08:00').toISOString();
    const rows=await this.rows('model_requests',{environment,from,to}),summary=this.summary(rows);
    const tasks=Object.values(rows.reduce((a,r)=>{const t=a[r.taskId]??={id:r.taskId,title:r.title,purpose:r.purpose,requests:[]};t.requests.push(r);return a;},{})).map(t=>({...t,...this.summary(t.requests)})).sort((a,b)=>b.nanoCost-a.nanoCost);
    const filtered=filterRequests(rows,query);
    const page=Math.max(1,Math.min(Math.ceil(filtered.length/20)||1,Math.floor(Number(query.page))||1));
    const budget=await this.budget(),alerts=(await this.rows('cost_budget_alerts')).filter(a=>a.version===budget.version&&(a.prefix===today||a.prefix===today.slice(0,7)));
    const statements=await this.rows('cost_official_statements');
    for(const statement of statements)statement.local=this.summary((await this.rows('model_requests',{environment:statement.environment})).filter(r=>r.key===statement.key&&todayKey(new Date(r.startedAt))>=statement.from&&todayKey(new Date(r.startedAt))<=statement.to));
    return {today,environment,period,from,to,summary,tasks:tasks.slice(0,10),requests:filtered.slice((page-1)*20,page*20),total:filtered.length,page,pages:Math.ceil(filtered.length/20)||1,
      purposes:Object.entries(rows.reduce((a,r)=>{(a[r.purpose]??=[]).push(r);return a;},{})).map(([purpose,rs])=>({purpose,...this.summary(rs)})),
      days:Array.from({length:Math.round((Date.parse(today)-Date.parse(start))/86400000)+1},(_,i)=>{const date=shift(start,i);return {date,...this.summary(rows.filter(r=>todayKey(new Date(r.startedAt))===date))};}),
      budget,alerts,statements,prices:await this.rows('model_price_versions'),keys:[...new Map(rows.map(r=>[`${r.environment}:${r.key}`,{alias:r.key,resourceId:r.keyResourceId,environment:r.environment}])).values()]};
  }
  async price(input,actor){
    if(actor?.role!=='admin')throw bad('仅管理员可维护价目',403);
    if(!input||!/^[-.\w]{1,160}$/.test(input.model||'')||!['default','flex','priority'].includes(input.tier)||!['input','cached','output'].every(k=>numeric(input[k])&&input[k]<=1000000)||!Number.isFinite(Date.parse(input.effectiveFrom))||typeof input.source!=='string'||!/^https:\/\/(docs\.volcengine\.com|www\.volcengine\.com)\//.test(input.source))throw bad('价目需要模型、服务档、价格、生效时间和官方来源');
    const record={model:input.model,tier:input.tier,input:input.input,cached:input.cached,output:input.output,effectiveFrom:new Date(input.effectiveFrom).toISOString(),source:input.source,verifiedAt:todayKey(),actorId:actor.id,createdAt:new Date().toISOString()};
    const id=createHash('sha256').update(JSON.stringify({...record,createdAt:undefined,actorId:undefined})).digest('hex');
    const existing=await this.get('model_price_versions',id);return existing||this.put('model_price_versions',id,record);
  }
  async importStatement(input,actor,{preview=false}={}) {
    if(!input||!['prod','test','local'].includes(input.environment)||typeof input.key!=='string'||!input.key.trim()||input.key.length>200||!validDay(input.from)||!validDay(input.to)||input.from>input.to||!numeric(input.paidYuan)||!Number.isSafeInteger(input.tokens)||input.tokens<0||(input.billingItem&&input.billingItem!=='模型推理')||(input.sourceHash&&!/^[a-f0-9]{64}$/.test(input.sourceHash)))throw bad('账单范围或金额无效；只导入所选 Key 的模型推理费用');
    const canonical={environment:input.environment,key:input.key.trim(),from:input.from,to:input.to,paidYuan:input.paidYuan,tokens:input.tokens,currency:'CNY',billingItem:String(input.billingItem||'模型推理').slice(0,80),sourceName:String(input.sourceName||'官方导出').slice(0,200)};
    const id=createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
    const local=(await this.rows('model_requests',{environment:canonical.environment})).filter(r=>r.key===canonical.key&&todayKey(new Date(r.startedAt))>=canonical.from&&todayKey(new Date(r.startedAt))<=canonical.to);
    const result={...canonical,id,sourceHash:input.sourceHash||id,local:this.summary(local),actorId:actor.id,createdAt:new Date().toISOString()};
    if(preview)return {...result,preview:true};
    const existing=await this.get('cost_official_statements',id);return existing?{...existing,idempotent:true}:await this.put('cost_official_statements',id,result);
  }
}
function shift(day,amount){return new Date(Date.parse(day+'T12:00:00Z')+amount*86400000).toISOString().slice(0,10);}
export function filterRequests(rows,query){return rows.filter(r=>(!query.purpose||query.purpose==='all'||query.purpose===r.purpose)&&(!query.status||query.status==='all'||query.status===r.usageStatus)&&(!query.q||[r.id,r.title,r.key,r.taskId].join(' ').toLowerCase().includes(String(query.q).toLowerCase())));}
export function csvRequests(rows) {
  const cell=v=>'"'+String(v??'未知').replace(/^[=+@-]/,"'$&").replaceAll('"','""')+'"';
  return '\uFEFF'+[['请求ID','时间','任务ID','用途','环境','Key','输入token','缓存token','输出token','推理token','模型估算元','用量状态','业务状态'],...rows.map(r=>[r.id,r.startedAt,r.taskId,r.purpose,r.environment,r.key,r.input,r.cached,r.output,r.reasoning,r.nanoCost===null?null:(r.nanoCost/1e9).toFixed(9),r.usageStatus,r.businessStatus])].map(row=>row.map(cell).join(',')).join('\r\n');
}
