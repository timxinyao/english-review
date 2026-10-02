import { z } from 'zod';
import { LearningItemType } from '../learning-item.js';
import { TaskOrigin, TaskType } from '../session.js';
import { CorrectionSegment } from '../ai/index.js';

// ---------- 任务视图（不含正确答案；选择题由前端 shuffle 后提交 option id）----------

export const ChoiceQuestionView = z.object({
  questionId: z.string(),
  kind: z.enum(['direct_meaning', 'context_meaning']),
  context: z.string().nullable(),
  question: z.string(),
  options: z.array(z.object({ id: z.string(), text: z.string() })).min(2),
});
export type ChoiceQuestionView = z.infer<typeof ChoiceQuestionView>;

export const ClozeQuestionView = z.object({
  questionId: z.string(),
  textWithBlank: z.string(),
});
export type ClozeQuestionView = z.infer<typeof ClozeQuestionView>;

export const ProductionQuestionView = z.object({
  questionId: z.string(),
  zhPrompt: z.string(),
  mustUse: z.string(),
});
export type ProductionQuestionView = z.infer<typeof ProductionQuestionView>;

export const TodayTaskView = z.object({
  taskId: z.string(),
  taskType: z.enum(['learn', 'understanding', 'cloze', 'production']),
  dimension: z.enum(['understanding', 'production']),
  origin: TaskOrigin,
  deferCount: z.number().int().min(0),
  item: z.object({
    id: z.string(),
    type: LearningItemType,
    target: z.string(),
    meaning: z.string(),
    ipa: z.string().nullable(),
    /** 学习项笔记（Recall Card 揭示态折叠展示） */
    notes: z.string().nullable(),
  }),
  /** learn 卡展示；理解/填空题默认隐藏，用户点「查看原句」后前端再显示，并随答案提交 viewedSource */
  sourceExample: z.string().nullable(),
  /** 补充/个人例句（learn 卡最多展示 1 条） */
  supplementaryExamples: z.array(z.string()),
  question: z.union([ChoiceQuestionView, ClozeQuestionView, ProductionQuestionView]).nullable(),
});
export type TodayTaskView = z.infer<typeof TodayTaskView>;
/** POST /api/today/tasks/:id/prepare 的答案不可见响应。 */
export const PrepareTodayTaskResponse = TodayTaskView;
export type PrepareTodayTaskResponse = TodayTaskView;

/** 表达题批改结果（check_production 最小纠错 diff） */
export const CorrectionView = z.object({
  segments: z.array(CorrectionSegment),
  correctedSentence: z.string(),
  betterVersion: z.string().nullable(),
});
export type CorrectionView = z.infer<typeof CorrectionView>;

// ---------- GET /api/today（三种状态）----------

export const RecentlyLearnedDto = z.object({
  id: z.string(),
  target: z.string(),
  type: LearningItemType,
});
export type RecentlyLearnedDto = z.infer<typeof RecentlyLearnedDto>;

export const TodayProgress = z.object({
  completed: z.number().int().min(0),
  total: z.number().int().min(0),
});
export type TodayProgress = z.infer<typeof TodayProgress>;

export const TodayIdleResponse = z.object({
  status: z.literal('idle'),
  /** 到期的 item-dimension 数量 */
  dueItems: z.number().int(),
  /** 今日剩余可引入的新学习项数量 */
  newTodayAvailable: z.number().int(),
  /** 在学词条总数（active，含 New Queue） */
  totalItems: z.number().int(),
  /** 待学（New Queue）数量 */
  newQueueCount: z.number().int(),
  recentlyLearned: z.array(RecentlyLearnedDto),
});
export type TodayIdleResponse = z.infer<typeof TodayIdleResponse>;

export const TodayActiveResponse = z.object({
  status: z.literal('active'),
  session: z.object({
    id: z.string(),
    sessionDate: z.string(),
  }),
  progress: TodayProgress,
  currentTask: TodayTaskView.nullable(),
});
export type TodayActiveResponse = z.infer<typeof TodayActiveResponse>;

export const TodaySummary = z.object({
  totalTasks: z.number().int(),
  pass: z.number().int(),
  basicPass: z.number().int(),
  fail: z.number().int(),
  newItemsStarted: z.number().int(),
  recommendRead: z.boolean(),
});
export type TodaySummary = z.infer<typeof TodaySummary>;

export const TodayCompletedResponse = z.object({
  status: z.literal('completed'),
  summary: TodaySummary,
  /** 剩余新学额度（maxNew − 今日 newItemsStarted）；null=不限制，0=用尽 */
  remainingNewQuota: z.number().int().nullable(),
  /** 在学词条总数（active，含 New Queue） */
  totalItems: z.number().int(),
  /** 待学（New Queue）数量 */
  newQueueCount: z.number().int(),
});
export type TodayCompletedResponse = z.infer<typeof TodayCompletedResponse>;

export const TodayStatusResponse = z.discriminatedUnion('status', [
  TodayIdleResponse,
  TodayActiveResponse,
  TodayCompletedResponse,
]);
export type TodayStatusResponse = z.infer<typeof TodayStatusResponse>;

// ---------- 作答 ----------

export const AnswerRequest = z
  .object({
    selectedOptionId: z.string().min(1).optional(),
    answerText: z.string().min(1).max(500).optional(),
    viewedSource: z.boolean().optional(),
    /** Understanding Recall Card：主动回忆直判（与 selectedOptionId 二选一） */
    recall: z.enum(['recalled', 'forgot']).optional(),
    /** Understanding Hint 模式提交的选择题标识 */
    hintUsed: z.boolean().optional(),
    /**
     * 主动不会（PRODUCT §7.6）：独立的作答动作，后端直接按 fail 结算。
     * 与选项/文本/自评/Hint 互斥（TECHNICAL_DESIGN §7.5）。
     */
    giveUp: z.literal(true).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.giveUp !== true) return;
    const conflicts = Object.entries({
      selectedOptionId: val.selectedOptionId,
      answerText: val.answerText,
      recall: val.recall,
      hintUsed: val.hintUsed,
    }).filter(([, v]) => v !== undefined);
    for (const [key] of conflicts) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: 'giveUp 与作答内容互斥，不能同时提交',
      });
    }
  });
export type AnswerRequest = z.infer<typeof AnswerRequest>;

export const AnswerResponse = z.object({
  result: z.enum(['pass', 'basic_pass', 'fail']),
  /** understanding 三档证据：recalled=自答想起 / assisted=提示后对 / forgot=未想起或提示仍错；其余题型 null */
  outcomeSource: z.enum(['recalled', 'assisted', 'forgot']).nullable().optional(),
  correct: z.boolean(),
  /** 本次作答是否为主动不会（giveUp=true，按 fail 结算且未提交任何答案） */
  gaveUp: z.boolean(),
  /** 本次提交的选项（recall 直判归一丢弃时为 null；giveUp 为 null）；仅作答后返回 */
  selectedOptionId: z.string().nullable(),
  /** 本次提交的文本（giveUp 为 null）；仅作答后返回 */
  submittedAnswerText: z.string().nullable(),
  /** 表达题主动不会时揭示的参考句（来自绑定题目 payload；绝不随未作答任务下发） */
  referenceAnswer: z.string().nullable(),
  /** 表达题主动不会时揭示的目标用法说明（payload acceptance_notes） */
  answerNote: z.string().nullable(),
  /** 幂等重复提交时为 true，并返回首次结算的结果摘要 */
  alreadyCompleted: z.boolean().optional(),
  explanation: z.string().nullable(),
  /** 选择题答错时揭示 */
  correctOptionId: z.string().nullable(),
  /** 填空题揭示：完整句子与可接受答案 */
  completeSentence: z.string().nullable(),
  acceptedAnswer: z.string().nullable(),
  /** 表达题批改 diff（仅 production 任务） */
  correction: CorrectionView.nullable(),
  /** 本次 corrected 句子是否已存入 Personal Example */
  personalExampleSaved: z.boolean(),
  reinforcementAdded: z.boolean(),
  progress: TodayProgress,
  /** 本次作答使会话完成时给出摘要 */
  completed: TodaySummary.nullable(),
});
export type AnswerResponse = z.infer<typeof AnswerResponse>;

// ---------- 会话任务批量视图（GET /api/today/tasks）----------

export const SessionTaskEntry = z.object({
  task: TodayTaskView,
  result: AnswerResponse.nullable(),
  canceled: z.boolean(),
});
export type SessionTaskEntry = z.infer<typeof SessionTaskEntry>;

export const TodaySessionTasksResponse = z.object({
  tasks: z.array(SessionTaskEntry),
  /** 最近一次可撤销的正式作答对应任务 id（当日内且下一次作答前；无则 null，PRODUCT §5.1） */
  undoableTaskId: z.string().nullable(),
});
export type TodaySessionTasksResponse = z.infer<typeof TodaySessionTasksResponse>;

// ---------- later / 坏题 / 反馈 ----------

export const LaterResponse = z.object({
  ok: z.literal(true),
  progress: TodayProgress,
});
export type LaterResponse = z.infer<typeof LaterResponse>;

export const BadQuestionResponse = z.object({
  ok: z.literal(true),
  progress: TodayProgress,
});
export type BadQuestionResponse = z.infer<typeof BadQuestionResponse>;

/** 普通撤销（最近一次正式作答）：回滚后返回队列进度（TECHNICAL_DESIGN §7.5） */
export const UndoResponse = z.object({
  ok: z.literal(true),
  progress: TodayProgress,
});
export type UndoResponse = z.infer<typeof UndoResponse>;

export const TaskFeedbackRequest = z.object({
  feedback: z.enum(['guessed', 'too_easy']),
});
export type TaskFeedbackRequest = z.infer<typeof TaskFeedbackRequest>;

export const TaskFeedbackResponse = z.object({
  ok: z.literal(true),
  adjustedResult: z.enum(['pass', 'basic_pass', 'fail']),
});
export type TaskFeedbackResponse = z.infer<typeof TaskFeedbackResponse>;

// ---------- 任务类型枚举导出（前端使用）----------

export { TaskType };
