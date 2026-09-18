import * as lark from '@larksuiteoapi/node-sdk';
const client = new lark.Client({ appId: process.env.FEISHU_APP_ID, appSecret: process.env.FEISHU_APP_SECRET, loggerLevel: lark.LoggerLevel.fatal });
const chatId = process.argv[2];
try {
  const response = await client.im.v1.chatMembers.get({ path: { chat_id: chatId }, params: { member_id_type: 'open_id', page_size: 100 } });
  console.log(JSON.stringify({ code: response.code, members: response.data?.items?.map((m) => ({ name: m.name, openId: m.member_id })), hasMore: response.data?.has_more }));
} catch (e) {
  console.log(JSON.stringify({ code: e.response?.data?.code ?? e.code, message: e.response?.data?.msg ?? 'Group member lookup failed' }));
}
try {
  const response = await client.im.v1.message.list({ params: { container_id_type: 'chat', container_id: chatId, page_size: 5, sort_type: 'ByCreateTimeDesc' } });
  console.log(JSON.stringify({ messagesCode: response.code, messages: response.data?.items?.map((m) => ({ type: m.msg_type, sender: m.sender?.id, text: m.body?.content })) }));
} catch (e) {
  console.log(JSON.stringify({ code: e.response?.data?.code ?? e.code, message: e.response?.data?.msg ?? 'Message lookup failed' }));
}
