import type { Transaction } from 'sequelize';
import { sequelize } from '../db';
import type { DataEntryTask, DefinitionBody } from '../domain/types';
import { advance } from '../engine/advance';
import { validateStepInput } from '../engine/fields';
import { ApiError, isUuid } from '../errors';
import { RunTask, WorkflowDefinition, WorkflowRun } from '../models';
import { RunView, toRunView } from './runView';

const runNotFound = (id: string) => new ApiError(404, 'RUN_NOT_FOUND', `Run "${id}" not found`);

async function loadView(run: WorkflowRun, t?: Transaction): Promise<RunView> {
  const tasks = await RunTask.findAll({ where: { runId: run.id }, order: [['seq', 'ASC']], transaction: t });
  return toRunView(run, tasks);
}

/** Row lock on the run: every write to a run is serialized, so racing submits cannot both apply. */
async function lockRun(runId: string, t: Transaction): Promise<WorkflowRun> {
  if (!isUuid(runId)) throw runNotFound(runId);
  const run = await WorkflowRun.findByPk(runId, { transaction: t, lock: t.LOCK.UPDATE });
  if (!run) throw runNotFound(runId);
  return run;
}

/**
 * Runs the pure engine from `fromTaskId` and persists what it decided: one completed row per
 * auto-resolved task (branch/end), then either a new active data-entry row or run completion.
 */
async function applyAdvance(run: WorkflowRun, fromTaskId: string, t: Transaction): Promise<void> {
  const result = advance(run.definitionSnapshot, fromTaskId, run.data);
  let seq = await RunTask.count({ where: { runId: run.id }, transaction: t });
  const now = new Date();

  for (const step of result.auto) {
    await RunTask.create(
      {
        runId: run.id,
        seq: seq++,
        taskId: step.taskId,
        type: step.type,
        status: 'completed',
        stepIndex: 0,
        draft: {},
        output: null,
        decision: step.decision ?? null,
        startedAt: now,
        completedAt: now,
      },
      { transaction: t },
    );
  }

  if (result.stop.kind === 'data_entry') {
    await RunTask.create(
      {
        runId: run.id,
        seq: seq++,
        taskId: result.stop.taskId,
        type: 'data_entry',
        status: 'active',
        stepIndex: 0,
        draft: {},
        output: null,
        decision: null,
        startedAt: now,
        completedAt: null,
      },
      { transaction: t },
    );
  } else {
    run.status = 'completed';
  }
  run.currentTaskId = result.stop.taskId;
  await run.save({ transaction: t });
}

export async function startRun(definitionId: string): Promise<RunView> {
  return sequelize.transaction(async (t) => {
    const def = await WorkflowDefinition.findByPk(definitionId, { transaction: t });
    if (!def) throw new ApiError(404, 'DEFINITION_NOT_FOUND', `Definition "${definitionId}" not found`);

    // The snapshot: a deep copy of the graph as it is right now. Later edits to the
    // definition row never reach this run, because the engine only reads the snapshot.
    const snapshot: DefinitionBody = structuredClone({
      name: def.name,
      startTaskId: def.startTaskId,
      tasks: def.tasks,
    });
    const run = await WorkflowRun.create(
      { definitionId: def.id, status: 'active', definitionSnapshot: snapshot, currentTaskId: null, data: {} },
      { transaction: t },
    );
    await applyAdvance(run, snapshot.startTaskId, t);
    return loadView(run, t);
  });
}

export async function getRun(runId: string): Promise<RunView> {
  if (!isUuid(runId)) throw runNotFound(runId);
  const run = await WorkflowRun.findByPk(runId);
  if (!run) throw runNotFound(runId);
  return loadView(run);
}

export async function submit(
  runId: string,
  taskId: string,
  action: 'save' | 'complete',
  data: Record<string, unknown>,
): Promise<RunView> {
  return sequelize.transaction(async (t) => {
    const run = await lockRun(runId, t);
    if (run.status !== 'active') {
      throw new ApiError(409, 'RUN_NOT_ACTIVE', `Run is ${run.status}`, { status: run.status });
    }
    const active = await RunTask.findOne({ where: { runId: run.id, status: 'active' }, transaction: t });
    if (!active) throw new ApiError(500, 'ENGINE_ERROR', 'Active run has no active task');
    if (active.taskId !== taskId) {
      throw new ApiError(409, 'TASK_NOT_ACTIVE', `Task "${taskId}" is not the active task`, {
        activeTaskId: active.taskId,
      });
    }

    const taskDef = run.definitionSnapshot.tasks.find((x) => x.id === taskId) as DataEntryTask;
    const step = taskDef.steps[active.stepIndex];
    const stepValues = validateStepInput(step, data, active.draft, action);
    // New object (never mutate in place) so Sequelize detects the JSONB change.
    active.draft = { ...active.draft, ...stepValues };

    const isLastStep = active.stepIndex === taskDef.steps.length - 1;
    if (action === 'save' || !isLastStep) {
      if (action === 'complete') active.stepIndex += 1;
      await active.save({ transaction: t });
      return loadView(run, t);
    }

    // Final step completed: the task is done, its answers become run data, the engine advances.
    active.status = 'completed';
    active.output = active.draft;
    active.completedAt = new Date();
    await active.save({ transaction: t });

    run.data = { ...run.data, [taskId]: active.draft };
    await applyAdvance(run, taskDef.next, t);
    return loadView(run, t);
  });
}

export async function cancelRun(runId: string): Promise<RunView> {
  return sequelize.transaction(async (t) => {
    const run = await lockRun(runId, t);
    if (run.status !== 'active') {
      throw new ApiError(409, 'RUN_NOT_ACTIVE', `Run is ${run.status}`, { status: run.status });
    }
    await RunTask.update(
      { status: 'cancelled', completedAt: new Date() },
      { where: { runId: run.id, status: 'active' }, transaction: t },
    );
    run.status = 'cancelled';
    await run.save({ transaction: t });
    return loadView(run, t);
  });
}
