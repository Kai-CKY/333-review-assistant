import { createHash } from 'node:crypto';
import { todayKey } from '../domain/date.js';

export async function readGroupHistory(client, chatId, { startTime, maxPages = 20 } = {}) {
  const messages = new Map();
  const tokens = new Set();
  let token;
  for (let page = 0; page < maxPages; page += 1) {
    const response = await client.im.v1.message.list({ params: {
      container_id_type: 'chat', container_id: chatId, page_size: 50, sort_type: 'ByCreateTimeDesc',
      ...(startTime ? { start_time: String(startTime) } : {}), ...(token ? { page_token: token } : {})
    } });
    if (response.code !== 0) throw Object.assign(new Error('history_read_failed'), { code: response.code });
    for (const message of response.data?.items ?? []) messages.set(message.message_id, message);
    if (!response.data?.has_more) return [...messages.values()].sort((a, b) => Number(a.create_time) - Number(b.create_time));
    token = response.data.page_token;
    if (!token || tokens.has(token)) throw new Error('history_invalid_pagination');
    tokens.add(token);
  }
  throw new Error('history_incomplete');
}

/** Explicitly selected, verified-sender messages only. Never infer that all group members are the learner. */
export async function saveHistoryProgress({ studyService, client, chatId, senderId, messages, messageIds, reportedOn = todayKey() }) {
  if (!messageIds?.length) throw new Error('progress_messages_required');
  const selected = [...new Set(messageIds)].map((id) => {
    const message = messages.find((item) => item.message_id === id);
    if (!message || message.deleted || message.sender?.id !== senderId || message.sender?.sender_type !== 'user' || message.msg_type !== 'text') throw new Error('progress_message_not_eligible');
    const content = JSON.parse(message.body.content).text?.trim();
    if (!content) throw new Error('progress_content_empty');
    return { message, content };
  });
  const entries = [];
  for (const { message, content } of selected) {
    entries.push(await studyService.recordTaskCompletion({ content, reportedOn,
      source: 'feishu_history_self_report', sourceId: `feishu:completion:${message.message_id}`,
      sourceMetadata: { chatId, senderId, messageId: message.message_id, sentAt: message.create_time, importedAt: new Date().toISOString() }
    }));
  }
  // Acknowledgement comes strictly after durable progress writes. Retrying a
  // failed send uses the same source IDs and remote message UUID.
  const response = await client.im.v1.message.create({ params: { receive_id_type: 'chat_id' }, data: {
    receive_id: chatId, msg_type: 'text',
    content: JSON.stringify({ text: `<at user_id="${senderId}"></at> 收到，我已补读你发来的进度，并按 ${reportedOn} 保存了 ${entries.length} 条学习进度。记录来自你的自报，不会自动改变掌握度或复习排程。` }),
    uuid: createHash('sha256').update(`${chatId}:${reportedOn}:${[...messageIds].sort().join(',')}`).digest('hex').slice(0, 40)
  } });
  if (response.code !== 0 || !response.data?.message_id) throw new Error('progress_saved_ack_failed');
  return { entries, acknowledgementMessageId: response.data.message_id };
}
