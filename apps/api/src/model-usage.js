import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename } from 'node:fs/promises';
import path from 'node:path';

const context = new AsyncLocalStorage();
let ledger, standalone;
export function configureModelLedger(value) { ledger=value; }
async function standaloneLedger() {
  if(ledger||process.env.NODE_TEST_CONTEXT)return;
  standalone??=(async()=>{
    const {RelationalRepository}=await import('./storage/relational-repository.js');
    const {RuntimeLedger}=await import('./runtime-ledger.js');
    const repository=new RelationalRepository(path.resolve(process.env.MODEL_USAGE_FILE||'.data/model-usage.sqlite'));
    ledger=new RuntimeLedger(repository,{environment:process.env.RUNTIME_ENV||'local'});
    await ledger.initialize();
    await replayUsagePending(ledger);
  })();
  try{await standalone;}catch{console.warn('standalone_usage_ledger_unavailable');}
}
export function withModelContext(value, action) {
  return context.run({...context.getStore(),...value},action);
}
export function withModelDefaults(value,action){
  return context.run({...value,...context.getStore()},action);
}
export function normalizeUsage(raw) {
  const n=v=>Number.isSafeInteger(v)&&v>=0?v:null;
  const input=n(raw?.prompt_tokens??raw?.input_tokens), output=n(raw?.completion_tokens??raw?.output_tokens);
  const cached=n(raw?.prompt_tokens_details?.cached_tokens??raw?.input_tokens_details?.cached_tokens);
  const reasoning=n(raw?.completion_tokens_details?.reasoning_tokens??raw?.output_tokens_details?.reasoning_tokens);
  return {input,output,cached,reasoning,usageStatus:input!==null&&output!==null?'known':input!==null||output!==null?'partial':'unknown'};
}
async function persist(record) {
  if (!ledger) return;
  try { const saved=await ledger.put('model_requests',record.id,record);if(saved.priceVersion)record.priceVersion=saved.priceVersion; }
  catch {
    try {
      const file=path.join(path.dirname(ledger.repository.filePath),'model-usage-pending.jsonl');
      await mkdir(path.dirname(file),{recursive:true});
      await appendFile(file,JSON.stringify(record)+'\n',{mode:0o600});
      console.warn('model_usage_pending');
    } catch { console.warn('model_usage_record_incomplete'); }
  }
}
export async function replayUsagePending(value) {
  const file=path.join(path.dirname(value.repository.filePath),'model-usage-pending.jsonl');
  let lines;
  try { lines=(await readFile(file,'utf8')).trim().split('\n'); } catch(e) { if(e.code==='ENOENT')return;throw e; }
  for(const line of lines) {const r=JSON.parse(line);await value.put('model_requests',r.id,r);}
  await rename(file,file+'.replayed-'+Date.now());
}
export async function recordModelCall(meta, action) {
  await standaloneLedger();
  const inherited=context.getStore()||{};
  const record={...meta,id:randomUUID(),taskId:inherited.taskId||randomUUID(),purpose:meta.purpose||inherited.purpose||'chat',
    title:inherited.title||meta.title||meta.purpose||'模型请求',environment:ledger?.environment||process.env.RUNTIME_ENV||'local',
    key:process.env.ARK_KEY_ALIAS||'当前项目 Key',keyResourceId:process.env.ARK_KEY_RESOURCE_ID||null,
    startedAt:new Date().toISOString(),status:'running',businessStatus:'pending',usageStatus:'unknown',
    input:null,output:null,cached:null,reasoning:null,nanoCost:null,
    attemptId:inherited.attemptId||null,scopeKey:inherited.scopeKey||null,operationId:inherited.operationId||null,
    rawUsage:null,responseId:null,toolCalls:0};
  await persist(record);
  const observe=async payload=>{
    if(payload?.usage) {record.rawUsage=payload.usage;Object.assign(record,normalizeUsage(payload.usage));}
    record.responseId=payload?.id||record.responseId;
    if(payload?.model)record.model=payload.model;
    if(Array.isArray(payload?.output))record.toolCalls=payload.output.filter(i=>i?.type==='web_search_call').length;
    record.updatedAt=new Date().toISOString();
    await persist(record);
  };
  try {
    const result=await action(observe);
    record.status='success';record.businessStatus='transport_complete';
    const returned={...result};Object.defineProperty(returned,'requestId',{value:record.id,enumerable:false});return returned;
  } catch(error) {
    record.status=error?.code==='timeout'?'timeout':'failed';record.errorCode=/^[\w-]{1,80}$/.test(error?.code||'')?error.code:'model_error';
    record.businessStatus='failed';throw error;
  } finally {
    record.endedAt=new Date().toISOString();record.updatedAt=record.endedAt;
    await persist(record);
    if(ledger)try{await ledger.checkBudgets();}catch{console.warn('cost_budget_check_failed');}
  }
}
export async function markModelResult(id,status) {
  if(!ledger||!id)return;
  try{const r=await ledger.get('model_requests',id);if(r)await persist({...r,businessStatus:status});}catch{console.warn('model_result_record_failed');}
}
