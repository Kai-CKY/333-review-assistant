import { createHash, randomUUID } from 'node:crypto';

export function conversationScope({ appId = '333', chatType, chatId, senderId, threadId = '' }) {
  if (!['group', 'p2p'].includes(chatType) || !chatId || (chatType === 'p2p' && !senderId)) throw new Error('invalid_conversation_scope');
  const parts = [appId, 'feishu', chatType, chatId, chatType === 'p2p' ? senderId : '', threadId];
  return { key: createHash('sha256').update(JSON.stringify(parts)).digest('hex'), appId, channel: 'feishu', chatType, chatId, peerId: chatType === 'p2p' ? senderId : null, threadId };
}

function state(data) { return data.agentMemory ??= { version: 1, streams: {}, sessions: {}, notes: {} }; }
function current(data, scope) {
  const store = state(data);
  let stream = store.streams[scope.key];
  if (!stream) {
    stream = store.streams[scope.key] = { scope, sessionId: randomUUID(), archivedIds: [] };
    store.sessions[stream.sessionId] = { id: stream.sessionId, scopeKey: scope.key, createdAt: new Date().toISOString(), events: [] };
  }
  return store.sessions[stream.sessionId];
}
export class ConversationMemory {
  constructor(repository) { this.repository = repository; }
  async session(scope) { return this.repository.mutate(data => structuredClone(current(data, scope))); }
  async history(scope, limit = 12) {
    const session = await this.session(scope);
    return session.events.filter(e => e.type === 'turn').slice(-limit).map(e => ({ user: e.user, assistant: e.assistant, at: e.at }));
  }
  async append(scope, event, expectedSessionId) {
    return this.repository.mutate(data => {
      const session = current(data, scope);
      if (expectedSessionId && session.id !== expectedSessionId) return false;
      if (event.eventId && session.events.some(e => e.eventId === event.eventId)) return false;
      session.events.push({ ...structuredClone(event), at: new Date().toISOString() });
      return true;
    });
  }
  async reset(scope) {
    return this.repository.mutate(data => {
      const old = current(data, scope), store = state(data), id = randomUUID();
      old.archivedAt = new Date().toISOString();
      store.streams[scope.key].archivedIds.push(old.id);
      store.streams[scope.key].sessionId = id;
      store.sessions[id] = { id, scopeKey: scope.key, createdAt: old.archivedAt, events: [] };
      return id;
    });
  }
  // Explicit recall only. Scope filtering happens before text search.
  async search(scope, query, limit = 5) {
    if (!String(query).trim()) return [];
    const store = state(await this.repository.read());
    return Object.values(store.sessions).filter(s => s.scopeKey === scope.key)
      .flatMap(s => s.events.filter(e => !/^(查历史：|知识库查询：)/.test(e.text || '') && JSON.stringify(e).includes(query)).map(e => ({ sessionId: s.id, ...e }))).slice(-limit);
  }
  async remember(scope, text, sourceId) {
    if (!String(text).trim() || String(text).length > 1000 || !sourceId) throw new Error('invalid_memory_note');
    return this.repository.mutate(data => {
      const notes = state(data).notes[scope.key] ??= [];
      if (!notes.some(n => n.sourceId === sourceId)) notes.push({ text, sourceId, at: new Date().toISOString(), origin: 'explicit_user_request' });
      return notes.slice(-8);
    });
  }
  async notes(scope) { return state(await this.repository.read()).notes[scope.key]?.slice(-8) ?? []; }
}
