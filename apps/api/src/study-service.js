import { todayKey } from './domain/date.js';
import { buildTodayPlan } from './domain/plan.js';
import { FeedbackService } from './feedback-service.js';

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
      knowledgePoints: data.knowledgePoints,
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
    const weakPoints = data.knowledgePoints
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
        pdfParser: 'not_configured',
        modelProvider: this.isModelConfigured() ? 'configured' : 'not_configured',
        scheduler: 'mvp_adapter',
        dataMode: data.knowledgePoints.every((point) => point.sourceLabel === '演示知识库') ? 'demo' : 'mixed'
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
    const data = await this.repository.read();
    const point = data.knowledgePoints.find((item) => item.id === knowledgePointId);
    if (!point) throw new Error('knowledge point not found');
    const state = data.reviewStates.find((item) => item.knowledgePointId === knowledgePointId);
    return {
      id: `${type}:${point.id}`,
      knowledgePointId: point.id,
      type,
      label,
      title: point.title,
      prompt: point.recallPrompt,
      estimatedMinutes: 7,
      mastery: state?.mastery ?? 0.2,
      source: point.sourceLabel
    };
  }

  async findPracticeTask(query) {
    const needle = String(query ?? '').trim().replace(/\s+/g, '').toLowerCase();
    if (!needle) return null;
    const data = await this.repository.read();
    const scored = data.knowledgePoints
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
