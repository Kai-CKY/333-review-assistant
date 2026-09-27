import { todayKey } from './domain/date.js';
import { buildTodayPlan } from './domain/plan.js';
import { FeedbackService } from './feedback-service.js';
import { activeStudyPoints } from './knowledge/library.js';
import { taskForPoint, visiblePoint } from './knowledge/references.js';
import { randomUUID } from 'node:crypto';

/**
 * Channel-neutral learning use cases. The browser API and the Feishu adapter
 * share this class so neither channel owns persistence or scheduling rules.
 */
export class StudyService {
  constructor(repository, { modelProvider = null, feedbackService = null } = {}) {
    this.repository = repository;
    this.modelProvider = modelProvider;
    this.feedbackService = feedbackService ?? new FeedbackService({
      repository,
      provider: modelProvider,
      profileProvider: () => this.getProfile()
    });
  }

  async getProfile() {
    return (await this.repository.read()).user;
  }

  isModelConfigured() {
    if (typeof this.feedbackService?.isConfigured === 'function') return this.feedbackService.isConfigured();
    return Boolean(this.modelProvider?.isConfigured?.());
  }

  async getDashboard(date = todayKey()) {
    const data = await this.repository.read();
    const tasks = buildTodayPlan({
      knowledgePoints: activeStudyPoints(data),
      reviewStates: data.reviewStates,
      targetDate: date,
      maximumTasks: data.user.dailyTaskLimit
    });
    const completedToday = data.reviewLogs.filter((item) => item.reviewedOn === date).length;
    const activeTaskCompletions = data.taskCompletionLogs.filter((item) => item.status !== 'voided');
    const recentTaskCompletions = [...activeTaskCompletions]
      .sort((a, b) => String(b.recordedAt).localeCompare(String(a.recordedAt)))
      .slice(0, 8);
    const selfReportedCompletedToday = activeTaskCompletions.filter((item) => item.reportedOn === date).length;
    const weakPoints = activeStudyPoints(data)
      .map((point) => ({ point, state: data.reviewStates.find((item) => item.knowledgePointId === point.id) }))
      .filter((item) => item.state && item.state.mastery < 0.62)
      .sort((a, b) => a.state.mastery - b.state.mastery)
      .slice(0, 3)
      .map(({ point, state }) => ({ id: point.id, title: point.title, mastery: state.mastery }));
    return {
      date,
      targetExamDate: data.user.targetExamDate,
      tasks,
      completedToday,
      selfReportedCompletedToday,
      recentTaskCompletions,
      weakPoints,
      system: {
        pdfParser: 'offline_only',
        modelProvider: this.isModelConfigured() ? 'configured' : 'not_configured',
        scheduler: 'mvp_adapter',
        dataMode: data.knowledgePoints.some(point => point.sourceKind === 'saved_knowledge' && !point.archived) ? 'saved' : 'demo'
      }
    };
  }

  async getTodayTask(taskId, date = todayKey()) {
    const dashboard = await this.getDashboard(date);
    const task = dashboard.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error('task is no longer available in today’s plan');
    return task;
  }

  async getWeaknessTask(knowledgePointId) {
    return this.getPracticeTask(knowledgePointId, { type: 'reinforce', label: '薄弱巩固' });
  }

  async getPracticeTask(knowledgePointId, { type = 'practice', label = '自主练习' } = {}) {
    if (this.repository.readPracticePoint) {
      const { point, state } = await this.repository.readPracticePoint(knowledgePointId);
      if (!point || point.practiceEligible === false) throw new Error('knowledge point not found');
      return taskForPoint(point, state, { type, label });
    }
    const data = await this.repository.read();
    const point = activeStudyPoints(data).find((item) => item.id === knowledgePointId);
    if (!point) throw new Error('knowledge point not found');
    const state = data.reviewStates.find((item) => item.knowledgePointId === knowledgePointId);
    return taskForPoint(point, state, { type, label });
  }

  async startPractice(pointId, owner) {
    return this.repository.mutate(data => {
      const point = visiblePoint(data, pointId);
      if (point.practiceEligible === false) throw Object.assign(new Error('请先将此知识点加入学习范围。'), { statusCode: 409 });
      const session = { id: randomUUID(), owner, createdAt: new Date().toISOString(),
        task: taskForPoint(point, data.reviewStates.find(s => s.knowledgePointId === pointId)) };
      (data.practiceSessions ??= {})[session.id] = session;
      return structuredClone(session);
    });
  }

  async practiceSession(id, owner, pointId) {
    const data = await this.repository.read();
    const session = data.practiceSessions?.[id];
    if (!session || session.owner !== owner || session.task.knowledgePointId !== pointId) {
      throw Object.assign(new Error('练习与知识点不匹配，请重新打开练习。'), { statusCode: 409 });
    }
    visiblePoint(data, pointId); // A stored session must never bypass revoked visibility.
    return session;
  }

  async findPracticeTask(query) {
    const needle = String(query ?? '').trim().replace(/\s+/g, '').toLowerCase();
    if (!needle) return null;
    const data = await this.repository.read();
    const scored = activeStudyPoints(data)
      .map((point) => {
        const title = point.title.replace(/\s+/g, '').toLowerCase();
        const score = title === needle ? 100 : title.includes(needle) ? 80 : needle.includes(title) ? 70 : 0;
        return { point, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);
    if (!scored.length || (scored[1] && scored[1].score === scored[0].score)) return null;
    return this.getPracticeTask(scored[0].point.id);
  }

  async saveAnswer(input) {
    if (!input.knowledgePointId || !input.content?.trim()) {
      throw new Error('knowledgePointId and content are required');
    }
    return this.repository.saveAnswer({
      ...input,
      feedbackStatus: input.feedbackStatus ?? (this.isModelConfigured() ? 'pending' : 'disabled')
    });
  }

  async recordTaskCompletion(input) {
    const content = String(input?.content ?? '').trim();
    if (!content) throw new Error('completion content is required');
    return this.repository.recordTaskCompletion({
      content: content.slice(0, 2_000),
      reportedOn: input.reportedOn ?? todayKey(),
      sourceId: input.sourceId,
      sourceMetadata: input.sourceMetadata,
      source: input.source ?? 'self_report'
    });
  }

  async getRecentTaskCompletions(limit = 8) {
    const data = await this.repository.read();
    const safeLimit = Math.max(1, Math.min(30, Number(limit) || 8));
    return data.taskCompletionLogs
      .filter((item) => item.status !== 'voided')
      .sort((a, b) => String(b.recordedAt).localeCompare(String(a.recordedAt)))
      .slice(0, safeLimit);
  }

  async voidTaskCompletion({ completionId, sourceId }) {
    if (!completionId) throw new Error('completionId is required');
    const profile = await this.getProfile();
    return this.repository.voidTaskCompletion({ completionId, userId: profile.id, sourceId });
  }

  /**
   * Compatibility entry point for callers that previously asked the study
   * service to generate feedback directly. The actual model workflow belongs
   * to FeedbackService so every channel now gets the same durable job flow.
   */
  async generatePracticeFeedback({ attempt, task, sourceSnapshot, channel = 'legacy' }) {
    const queued = await this.feedbackService.enqueue({
      attempt,
      task,
      idempotencyKey: `practice-feedback:${attempt?.id}:${this.feedbackService.promptVersion ?? 'structure-feedback-v1'}`,
      sourceSnapshot,
      channel
    });
    return this.feedbackService.process(queued.job.id);
  }

  async recordReview(input) {
    return this.repository.recordReview(input);
  }
}
