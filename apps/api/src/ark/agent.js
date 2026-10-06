import { ArkFeedbackError, ArkFeedbackProvider } from './feedback.js';
import { knowledgeContextRule } from '../knowledge/library.js';
import { KnowledgeTools } from '../agent/knowledge-tools.js';
import { compactRuntime, coachingReference } from '../agent/context-builder.js';
import { parseReply, reactionPrompt, reactionIds } from '../agent/reactions.js';
import { markModelResult } from '../model-usage.js';
import {
  coachingSystemPrompt,
  conversationSystemPrompt,
  intentSystemPrompt
} from '../agent/prompts.js';

const allowedIntents = new Set([
  'chat',
  'show_today',
  'show_progress',
  'show_weaknesses',
  'show_completions',
  'propose_task',
  'ask_hint',
  'help',
  'ambiguous'
]);
const allowedRouteKeys = new Set(['schema_version', 'intent', 'reply', 'task_query', 'confidence','reaction']);

function clip(value, maximum) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length <= maximum ? text : `${text.slice(0, maximum)}…`;
}

function parseJsonObject(content) {
  const stripped = String(content ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(stripped);
  } catch {
    throw new ArkFeedbackError('invalid_route_json');
  }
}

function validateRoute(route) {
  if (!route || typeof route !== 'object' || Array.isArray(route)) throw new ArkFeedbackError('invalid_route');
  if (Object.keys(route).some((key) => !allowedRouteKeys.has(key))) throw new ArkFeedbackError('invalid_route');
  if (route.schema_version !== 1 || !allowedIntents.has(route.intent)) throw new ArkFeedbackError('invalid_route');
  if (typeof route.reply !== 'string' || route.reply.length > 360) throw new ArkFeedbackError('invalid_route');
  if (route.task_query !== null && typeof route.task_query !== 'string') throw new ArkFeedbackError('invalid_route');
  if (typeof route.task_query === 'string' && route.task_query.length > 120) throw new ArkFeedbackError('invalid_route');
  if (typeof route.confidence !== 'number' || route.confidence < 0 || route.confidence > 1) throw new ArkFeedbackError('invalid_route');
  if (route.intent === 'propose_task' && !route.task_query?.trim()) throw new ArkFeedbackError('invalid_route');
  if (route.intent !== 'propose_task' && route.task_query !== null) throw new ArkFeedbackError('invalid_route');
  return {
    schemaVersion: 1,
    intent: route.confidence < 0.55 ? 'ambiguous' : route.intent,
    reply: clip(route.reply, 240),
    taskQuery: route.task_query ? clip(route.task_query, 120) : null,
    confidence: route.confidence
    ,reaction:reactionIds.has(route.reaction)?route.reaction:null
  };
}

function historyMessages(history = []) {
  return history.slice(-6).flatMap((turn) => [
    { role: 'user', content: clip(turn.user, 600) },
    { role: 'assistant', content: clip(turn.assistant, 600) }
  ]).filter((item) => item.content);
}

export class ArkStudyAgent {
  constructor({ provider = new ArkFeedbackProvider(), repository = null } = {}) {
    this.provider = provider;
    this.repository = repository;
    this.knowledgeTools = repository ? new KnowledgeTools(repository) : null;
  }

  async knowledge(message, profile) {
    if (!this.repository || profile?.role === 'unbound') return [];
    return (await this.knowledgeTools.searchKnowledge(message)).hits;
  }

  isConfigured() {
    return this.provider.isConfigured();
  }

  async classify({ message, profile, activeSession = null, runtimeSummary = null, history = [] }) {
    const result = await this.provider.complete({
      purpose: 'intent',
      temperature: 0,
      maxTokens: 260,
      messages: [
        { role: 'system', content: `${intentSystemPrompt(profile)}\n${knowledgeContextRule}\n可增加 reaction 字段，选 THUMBSUP、SMILE、CLAP、MUSCLE、HEART 或 null，仅交流时按需选择。` },
        {
          role: 'user',
          content: JSON.stringify({
            message: clip(message, 2_000),
            saved_knowledge: await this.knowledge(message, profile),
            active_session: activeSession ? { status: activeSession.status, task_title: activeSession.task?.title } : null,
            runtime_summary: compactRuntime(runtimeSummary || {}),
            recent_conversation: history.slice(-4).map((turn) => ({
              user: clip(turn.user, 600),
              assistant: clip(turn.assistant, 600)
            }))
          })
        }
      ]
    });
    try{const route=validateRoute(parseJsonObject(result.content));await markModelResult(result.requestId,'success');return route;}
    catch(error){await markModelResult(result.requestId,'parse_failed');throw error;}
  }

  async chat({ message, profile, runtimeSummary, history = [] }) {
    const result = await this.provider.complete({
      purpose: 'chat',
      temperature: 0.35,
      maxTokens: 260,
      messages: [
        { role: 'system', content: `${conversationSystemPrompt(profile, compactRuntime(runtimeSummary || {}))}\n${knowledgeContextRule}\n${reactionPrompt}` },
        ...historyMessages(history),
        { role: 'user', content: JSON.stringify({ saved_knowledge: await this.knowledge(message, profile) }) },
        { role: 'user', content: clip(message, 3_000) }
      ]
    });
    return this.parsedReply(result,800);
  }

  async coach({ message, profile, task, history = [] }) {
    const result = await this.provider.complete({
      purpose: 'coaching',
      temperature: 0.25,
      maxTokens: 220,
      messages: [
        { role: 'system', content: `${coachingSystemPrompt(profile)}\n${knowledgeContextRule}\n${reactionPrompt}` },
        ...historyMessages(history),
        {
          role: 'user',
          content: [
            `当前知识点：${clip(task?.title, 300)}`,
            `当前回忆题：${clip(task?.prompt, 1_500)}`,
            `本题绑定参考：${JSON.stringify(coachingReference(task?.reference))}`,
            `羊羊的问题：${clip(message, 2_000)}`
          ].join('\n\n')
        }
      ]
    });
    return this.parsedReply(result,1000);
  }
  async parsedReply(result,maximum){
    try{const reply=parseReply(result.content);await markModelResult(result.requestId,'success');return {...reply,text:clip(reply.text,maximum),modelId:result.modelId};}
    catch(error){await markModelResult(result.requestId,'parse_failed');throw error;}
  }
}
