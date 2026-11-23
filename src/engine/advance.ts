import { ApiError } from '../errors';
import type { Decision, DefinitionBody, RunData, Task } from '../domain/types';
import { resolveBranch } from './conditions';

export interface AutoStep {
  taskId: string;
  type: 'branch' | 'end';
  decision?: Decision;
}

export interface AdvanceResult {
  /** Tasks the engine resolved on its own, in order. */
  auto: AutoStep[];
  /** Where the run comes to rest: waiting on a human, or finished. */
  stop: { kind: 'data_entry' | 'end'; taskId: string };
}

/**
 * Pure: walks the (snapshotted) graph from `fromTaskId`, resolving branch and end tasks
 * automatically, until it reaches a data-entry task (needs a human) or an end task.
 */
export function advance(def: DefinitionBody, fromTaskId: string, data: RunData): AdvanceResult {
  const byId = new Map<string, Task>(def.tasks.map((t) => [t.id, t]));
  const auto: AutoStep[] = [];
  let currentId = fromTaskId;

  // Saving rejects branch-only cycles, so more hops than tasks means a corrupt snapshot.
  for (let hops = 0; hops <= def.tasks.length; hops++) {
    const task = byId.get(currentId);
    if (!task) throw new ApiError(500, 'ENGINE_ERROR', `Task "${currentId}" is not in the run's definition`);

    if (task.type === 'data_entry') return { auto, stop: { kind: 'data_entry', taskId: task.id } };
    if (task.type === 'end') {
      auto.push({ taskId: task.id, type: 'end' });
      return { auto, stop: { kind: 'end', taskId: task.id } };
    }
    const decision = resolveBranch(task, data);
    auto.push({ taskId: task.id, type: 'branch', decision });
    currentId = decision.next;
  }
  throw new ApiError(500, 'ENGINE_LOOP', 'Engine exceeded the hop limit without reaching a human or end task');
}
