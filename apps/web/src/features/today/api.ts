import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AnswerRequest,
  AnswerResponse,
  BadQuestionResponse,
  LaterResponse,
  PrepareTodayTaskResponse,
  TaskFeedbackRequest,
  TaskFeedbackResponse,
  TodayActiveResponse,
  TodaySessionTasksResponse,
  TodayStatusResponse,
  UndoResponse,
} from '@el/shared';
import { api } from '../../lib/api';

// ---------- query keys ----------

export const todayKeys = {
  all: ['today'] as const,
  status: ['today', 'status'] as const,
  tasks: ['today', 'tasks'] as const,
};

// ---------- 请求函数（契约：packages/shared today.ts，已冻结）----------

export function fetchTodayStatus(): Promise<TodayStatusResponse> {
  return api<TodayStatusResponse>('/api/today');
}

export function fetchSessionTasks(): Promise<TodaySessionTasksResponse> {
  return api<TodaySessionTasksResponse>('/api/today/tasks');
}

export function startTodaySession(): Promise<TodayActiveResponse> {
  return api<TodayActiveResponse>('/api/today/start', { method: 'POST' });
}

export function answerTodayTask(taskId: string, body: AnswerRequest): Promise<AnswerResponse> {
  return api<AnswerResponse>(`/api/today/tasks/${taskId}/answer`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function prepareTodayTask(taskId: string): Promise<PrepareTodayTaskResponse> {
  return api<PrepareTodayTaskResponse>(`/api/today/tasks/${taskId}/prepare`, { method: 'POST' });
}

export function deferTodayTask(taskId: string): Promise<LaterResponse> {
  return api<LaterResponse>(`/api/today/tasks/${taskId}/later`, { method: 'POST' });
}

export function reportBadQuestion(taskId: string): Promise<BadQuestionResponse> {
  return api<BadQuestionResponse>(`/api/today/tasks/${taskId}/bad-question`, { method: 'POST' });
}

/** 普通撤销（最近一次正式作答，TECHNICAL §7.5）：区别于坏题，不改题目状态 */
export function undoTodayTask(taskId: string): Promise<UndoResponse> {
  return api<UndoResponse>(`/api/today/tasks/${taskId}/undo`, { method: 'POST' });
}

export function sendTaskFeedback(
  taskId: string,
  feedback: TaskFeedbackRequest['feedback'],
): Promise<TaskFeedbackResponse> {
  return api<TaskFeedbackResponse>(`/api/today/tasks/${taskId}/feedback`, {
    method: 'POST',
    body: JSON.stringify({ feedback } satisfies TaskFeedbackRequest),
  });
}

// ---------- hooks（所有请求成功后统一 invalidate today）----------

function useInvalidateToday() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: todayKeys.all });
  };
}

export function useTodayStatus() {
  return useQuery({ queryKey: todayKeys.status, queryFn: fetchTodayStatus });
}

export function useSessionTasks() {
  return useQuery({ queryKey: todayKeys.tasks, queryFn: fetchSessionTasks });
}

export function useStartSession() {
  const invalidate = useInvalidateToday();
  return useMutation({ mutationFn: startTodaySession, onSuccess: invalidate });
}

/** 同日追加学习（PRODUCT §3.4）：POST /api/today/extend 重新激活会话并补一批 Learn */
export function useExtendSession() {
  const invalidate = useInvalidateToday();
  return useMutation({
    mutationFn: () => api<TodayActiveResponse>('/api/today/extend', { method: 'POST' }),
    onSuccess: invalidate,
  });
}

export function useAnswer() {
  const invalidate = useInvalidateToday();
  return useMutation({
    mutationFn: ({ taskId, body }: { taskId: string; body: AnswerRequest }) =>
      answerTodayTask(taskId, body),
    onSuccess: invalidate,
  });
}

export function usePrepareTask() {
  const invalidate = useInvalidateToday();
  return useMutation({ mutationFn: prepareTodayTask, onSuccess: invalidate });
}

export function useLater() {
  const invalidate = useInvalidateToday();
  return useMutation({ mutationFn: deferTodayTask, onSuccess: invalidate });
}

export function useBadQuestion() {
  const invalidate = useInvalidateToday();
  return useMutation({ mutationFn: reportBadQuestion, onSuccess: invalidate });
}

/** 撤销成功后 invalidate 全部 today 查询：进度/批量视图/undoableTaskId 一起回服务端真态 */
export function useUndoAnswer() {
  const invalidate = useInvalidateToday();
  return useMutation({ mutationFn: undoTodayTask, onSuccess: invalidate });
}

export function useTaskFeedback() {
  const invalidate = useInvalidateToday();
  return useMutation({
    mutationFn: ({
      taskId,
      feedback,
    }: {
      taskId: string;
      feedback: TaskFeedbackRequest['feedback'];
    }) => sendTaskFeedback(taskId, feedback),
    onSuccess: invalidate,
  });
}
