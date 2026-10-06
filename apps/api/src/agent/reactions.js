export const reactionIds = new Set(['THUMBSUP','SMILE','CLAP','MUSCLE','HEART']);
export const reactionPrompt = '回复纯 JSON {"text":"给用户的文字","reaction":"THUMBSUP|SMILE|CLAP|MUSCLE|HEART 或 null"}。表情分别表示认可、微笑、鼓掌、加油、关心；按情景选择，允许不用，不按关键词机械匹配。不得用表情代替必须说明的操作结果或错误。没有文字也可以只用一个合适的表情。不要把未执行的动作说成成功。';
export function parseReply(content) {
  const raw=String(content||'').trim();
  if(!raw.startsWith('{')&&!raw.startsWith('```'))return {text:raw,reaction:null};
  let reply;try{reply=JSON.parse(raw.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));}catch{throw Object.assign(new Error('invalid_reply'),{code:'invalid_reply'});}
  if(!reply||typeof reply.text!=='string'||Object.keys(reply).some(k=>!['text','reaction'].includes(k)))throw Object.assign(new Error('invalid_reply'),{code:'invalid_reply'});
  return {text:reply.text.trim(),reaction:reactionIds.has(reply.reaction)?reply.reaction:null};
}
export async function sendReactionOnce(repository,channel,messageId,reaction,logger=console) {
  if(!messageId||!reactionIds.has(reaction)||typeof channel.addReaction!=='function')return false;
  const claimed=await repository.mutate(d=>{d.reactionEvents??={};if(d.reactionEvents[messageId])return false;d.reactionEvents[messageId]={reaction,status:'sending',at:new Date().toISOString()};return true;});
  if(!claimed)return false;
  try{await channel.addReaction(messageId,reaction);await repository.mutate(d=>{d.reactionEvents[messageId].status='sent';});return true;}
  catch{await repository.mutate(d=>{d.reactionEvents[messageId].status='failed';});logger.warn('reaction_send_failed');return false;}
}
