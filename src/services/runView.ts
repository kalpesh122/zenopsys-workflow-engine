import type { DataEntryTask, Decision, Field, RunData, RunStatus } from '../domain/types';
import type { RunTask, WorkflowRun } from '../models';

export interface TaskView {
  id: string;
  taskId: string;
  type: string;
  status: string;
  stepIndex?: number;
  draft?: Record<string, unknown>;
  output?: Record<string, unknown> | null;
  decision?: Decision;
  startedAt: Date;
  completedAt: Date | null;
}

export interface RunView {
  id: string;
  definitionId: string;
  definitionName: string;
  status: RunStatus;
  currentTaskId: string | null;
  /** What the active data-entry task expects next; null when the run is not waiting on a human. */
  currentStep: { taskId: string; id: string; index: number; totalSteps: number; fields: Field[] } | null;
  done: TaskView[];
  active: TaskView[];
  data: RunData;
  createdAt: Date;
  updatedAt: Date;
}

function toTaskView(t: RunTask): TaskView {
  const view: TaskView = {
    id: t.id,
    taskId: t.taskId,
    type: t.type,
    status: t.status,
    startedAt: t.startedAt,
    completedAt: t.completedAt,
  };
  if (t.type === 'data_entry') {
    view.stepIndex = t.stepIndex;
    if (t.status === 'completed') view.output = t.output;
    else view.draft = t.draft;
  }
  if (t.decision) view.decision = t.decision;
  return view;
}

/** `tasks` must be ordered by seq. */
export function toRunView(run: WorkflowRun, tasks: RunTask[]): RunView {
  const active = tasks.filter((t) => t.status === 'active');
  let currentStep: RunView['currentStep'] = null;
  const current = active[0];
  if (run.status === 'active' && current?.type === 'data_entry') {
    const def = run.definitionSnapshot.tasks.find((t) => t.id === current.taskId) as DataEntryTask;
    const step = def.steps[current.stepIndex];
    currentStep = {
      taskId: current.taskId,
      id: step.id,
      index: current.stepIndex,
      totalSteps: def.steps.length,
      fields: step.fields,
    };
  }
  return {
    id: run.id,
    definitionId: run.definitionId,
    definitionName: run.definitionSnapshot.name,
    status: run.status,
    currentTaskId: run.currentTaskId,
    currentStep,
    done: tasks.filter((t) => t.status !== 'active').map(toTaskView),
    active: active.map(toTaskView),
    data: run.data,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}
