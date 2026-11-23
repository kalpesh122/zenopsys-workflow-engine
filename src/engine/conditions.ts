import type { BranchTask, Condition, Decision, Leaf, RunData } from '../domain/types';

const same = (a: unknown, b: unknown): boolean =>
  a === b || (typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));

function read(field: string, data: RunData): unknown {
  const dot = field.indexOf('.');
  const taskId = field.slice(0, dot);
  const key = field.slice(dot + 1);
  // Own properties only, so "x.constructor" never resolves to Object.prototype members.
  if (!Object.hasOwn(data, taskId) || !Object.hasOwn(data[taskId], key)) return undefined;
  return data[taskId][key];
}

function bothNumbers(a: unknown, b: unknown): [number, number] | null {
  return typeof a === 'number' && typeof b === 'number' ? [a, b] : null;
}

/**
 * A field that was never collected on this path (task skipped, optional field left empty)
 * makes every comparison false, including `neq` and `exists`.
 */
function evaluateLeaf(leaf: Leaf, data: RunData): boolean {
  const actual = read(leaf.field, data);
  if (actual === undefined || actual === null) return false;
  const expected = leaf.value;
  const nums = bothNumbers(actual, expected);
  switch (leaf.op) {
    case 'exists':
      return true;
    case 'eq':
      return same(actual, expected);
    case 'neq':
      return !same(actual, expected);
    case 'gt':
      return !!nums && nums[0] > nums[1];
    case 'gte':
      return !!nums && nums[0] >= nums[1];
    case 'lt':
      return !!nums && nums[0] < nums[1];
    case 'lte':
      return !!nums && nums[0] <= nums[1];
    case 'in':
      return Array.isArray(expected) && expected.some((v) => same(v, actual));
    case 'contains':
      return Array.isArray(actual) && actual.some((v) => same(v, expected));
  }
}

export function evaluateCondition(c: Condition, data: RunData): boolean {
  if ('all' in c) return c.all.every((x) => evaluateCondition(x, data));
  if ('any' in c) return c.any.some((x) => evaluateCondition(x, data));
  return evaluateLeaf(c, data);
}

/** Rules are tried in order; the first match wins, otherwise the default path is taken. */
export function resolveBranch(task: BranchTask, data: RunData): Decision {
  const i = task.rules.findIndex((r) => evaluateCondition(r.when, data));
  return i >= 0 ? { matchedRule: i, next: task.rules[i].next } : { matchedRule: null, next: task.default };
}
