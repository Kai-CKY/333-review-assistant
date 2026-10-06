import {readFile} from 'node:fs/promises';
const actions={
  list:['GET','/api/console/operations'],
  preview:['POST','/api/console/operations/preview'],
  send:['POST','/api/console/operations/send'],
  record:['POST','/api/console/operations/record'],
  costs:['GET','/api/console/costs'],
  budget:['POST','/api/console/costs/budget']
};
// Keep credentials in an ignored private file, never in command arguments or URLs.
const [action,inputFile]=process.argv.slice(2);
if(!actions[action])throw new Error('用法：node scripts/management-client.mjs list|preview|send|record|costs|budget [输入JSON文件]');
const config=JSON.parse(await readFile(process.env.MANAGEMENT_LOGIN_FILE||'.data/management-login.json','utf8'));
const base=new URL(config.url);
if(base.username||base.password||!(base.protocol==='https:'||(base.protocol==='http:'&&['127.0.0.1','localhost'].includes(base.hostname))))throw new Error('管理接口必须使用 HTTPS 或本机 SSH 隧道');
async function request(route,options){
  const response=await fetch(new URL(route,base),{...options,redirect:'error',signal:AbortSignal.timeout(60000)});
  const data=await response.json();if(!response.ok)throw new Error(data.error||'管理请求失败');
  return {response,data};
}
const login=await request('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:config.username,password:config.password})});
const cookie=login.response.headers.get('set-cookie')?.split(';')[0];if(!cookie)throw new Error('未取得管理登录');
try{
  const session=await request('/api/session',{headers:{cookie}});if(session.data.role!=='admin')throw new Error('需要管理员账号');
  const [method,route]=actions[action],input=method==='POST'?JSON.parse(await readFile(inputFile,'utf8')):undefined;
  if(['send','record'].includes(action)&&!input.requestId)throw new Error('输入文件必须保留稳定 requestId，重试不能换 ID');
  const result=await request(route,{method,headers:{cookie,'Content-Type':'application/json'},...(input?{body:JSON.stringify(input)}:{})});
  console.log(JSON.stringify(result.data,null,2));
}finally{await request('/api/logout',{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:'{}'});}
