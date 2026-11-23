import { z } from 'zod';
import { ApiError } from '../errors';
import type { BranchTask, Condition, DefinitionBody, Leaf, Task } from './types';

// ---------- Shape (zod) ----------

// 255 = the VARCHAR length of name / start_task_id / current_task_id / task_id columns.
// "__proto__" can never be submitted as a data key (see jsonGuard), so a task/field with that
// id would leave runs stuck; reject it up front.
const id = z
  .string()
  .min(1)
  .max(255)
  .refine((s) => s !== '__proto__', { message: '"__proto__" is reserved' });

const fieldSchema = z
  .object({
    key: id,
    type: z.enum(['text', 'number', 'single_select', 'multi_select']),
    label: z.string().optional(),
    required: z.boolean().optional(),
    options: z.array(z.string().min(1)).optional(),
  })
  .strict();

const stepSchema = z.object({ id, fields: z.array(fieldSchema).min(1) }).strict();

const leafSchema = z
  .object({
    field: id,
    op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'exists']),
    value: z.unknown().optional(),
  })
  .strict();

const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    leafSchema,
    z.object({ all: z.array(conditionSchema) }).strict(),
    z.object({ any: z.array(conditionSchema) }).strict(),
  ]),
);

const taskSchema = z.discriminatedUnion('type', [
  z.object({ id, type: z.literal('data_entry'), steps: z.array(stepSchema).min(1), next: id }).strict(),
  z
    .object({
      id,
      type: z.literal('branch'),
      rules: z.array(z.object({ when: conditionSchema, next: id }).strict()),
      default: id,
    })
    .strict(),
  z.object({ id, type: z.literal('end') }).strict(),
]);

/** Top level strips unknown keys (so a fetched definition can be PUT back); tasks are strict to catch typos. */
export const definitionSchema = z.object({
  name: z.string().min(1).max(255),
  startTaskId: id,
  tasks: z.array(taskSchema).min(1),
});

// ---------- Semantics ----------

const NUMERIC_OPS = new Set(['gt', 'gte', 'lt', 'lte']);

function* leaves(c: Condition): Generator<Leaf> {
  if ('all' in c) for (const x of c.all) yield* leaves(x);
  else if ('any' in c) for (const x of c.any) yield* leaves(x);
  else yield c;
}

function checkLeaf(leaf: Leaf, where: string, byId: Map<string, Task>, problems: string[]) {
  const dot = leaf.field.indexOf('.');
  if (dot <= 0 || dot === leaf.field.length - 1) {
    problems.push(`${where}: field "${leaf.field}" must be "<taskId>.<fieldKey>"`);
    return;
  }
  const taskId = leaf.field.slice(0, dot);
  const key = leaf.field.slice(dot + 1);
  const source = byId.get(taskId);
  if (!source) problems.push(`${where}: field "${leaf.field}" refers to unknown task "${taskId}"`);
  else if (source.type !== 'data_entry') {
    problems.push(`${where}: field "${leaf.field}" must refer to a data_entry task, "${taskId}" is ${source.type}`);
  } else if (!source.steps.some((s) => s.fields.some((f) => f.key === key))) {
    problems.push(`${where}: task "${taskId}" has no field "${key}"`);
  }

  if (NUMERIC_OPS.has(leaf.op) && typeof leaf.value !== 'number') {
    problems.push(`${where}: op "${leaf.op}" needs a number value`);
  } else if (leaf.op === 'in' && !Array.isArray(leaf.value)) {
    problems.push(`${where}: op "in" needs an array value`);
  } else if (leaf.op === 'exists' && leaf.value !== undefined) {
    problems.push(`${where}: op "exists" takes no value`);
  } else if (['eq', 'neq', 'contains'].includes(leaf.op) && leaf.value === undefined) {
    problems.push(`${where}: op "${leaf.op}" needs a value`);
  }
}

/** A cycle made only of branch tasks would spin forever without human input. */
function findBranchOnlyCycle(tasks: Task[], byId: Map<string, Task>): string[] | null {
  const branches = tasks.filter((t): t is BranchTask => t.type === 'branch');
  const state = new Map<string, 'visiting' | 'done'>();
  const path: string[] = [];

  const visit = (b: BranchTask): string[] | null => {
    state.set(b.id, 'visiting');
    path.push(b.id);
    for (const target of [...b.rules.map((r) => r.next), b.default]) {
      const t = byId.get(target);
      if (!t || t.type !== 'branch') continue;
      if (state.get(t.id) === 'visiting') return [...path.slice(path.indexOf(t.id)), t.id];
      if (!state.has(t.id)) {
        const cycle = visit(t);
        if (cycle) return cycle;
      }
    }
    path.pop();
    state.set(b.id, 'done');
    return null;
  };

  for (const b of branches) {
    if (!state.has(b.id)) {
      const cycle = visit(b);
      if (cycle) return cycle;
    }
  }
  return null;
}

function findProblems(def: DefinitionBody): string[] {
  const problems: string[] = [];
  const byId = new Map<string, Task>();
  for (const t of def.tasks) {
    if (byId.has(t.id)) problems.push(`duplicate task id "${t.id}"`);
    byId.set(t.id, t);
  }
  const ref = (target: string, where: string) => {
    if (!byId.has(target)) problems.push(`${where} points to unknown task "${target}"`);
  };

  ref(def.startTaskId, 'startTaskId');

  for (const t of def.tasks) {
    if (t.type === 'data_entry') {
      ref(t.next, `task "${t.id}" next`);
      const stepIds = new Set<string>();
      const keys = new Set<string>();
      for (const step of t.steps) {
        if (stepIds.has(step.id)) problems.push(`task "${t.id}": duplicate step id "${step.id}"`);
        stepIds.add(step.id);
        for (const f of step.fields) {
          if (keys.has(f.key)) problems.push(`task "${t.id}": duplicate field key "${f.key}"`);
          keys.add(f.key);
          const isSelect = f.type === 'single_select' || f.type === 'multi_select';
          if (isSelect && !f.options?.length) {
            problems.push(`task "${t.id}" field "${f.key}": ${f.type} needs non-empty options`);
          }
          if (!isSelect && f.options) problems.push(`task "${t.id}" field "${f.key}": options only apply to select fields`);
        }
      }
    } else if (t.type === 'branch') {
      ref(t.default, `task "${t.id}" default`);
      t.rules.forEach((rule, i) => {
        const where = `task "${t.id}" rule ${i}`;
        ref(rule.next, `${where} next`);
        for (const leaf of leaves(rule.when)) checkLeaf(leaf, where, byId, problems);
      });
    }
  }

  if (!def.tasks.some((t) => t.type === 'end')) problems.push('definition needs at least one end task');

  const cycle = findBranchOnlyCycle(def.tasks, byId);
  if (cycle) problems.push(`branch tasks form a cycle with no human step: ${cycle.join(' -> ')}`);

  return problems;
}

/**
 * A condition is a union (leaf | all | any), and zod reports a failed union only as "Invalid input".
 * Report the issues of the closest alternative instead (fewest issues), so a typo like op "like"
 * surfaces as `...when.op: Invalid enum value` rather than `...when: Invalid input`.
 */
function flattenIssues(issues: z.ZodIssue[]): { path: string; message: string }[] {
  return issues.flatMap((i) => {
    if (i.code === 'invalid_union' && i.unionErrors.length) {
      const closest = i.unionErrors.reduce((a, b) => (b.issues.length < a.issues.length ? b : a));
      return flattenIssues(closest.issues);
    }
    return [{ path: i.path.join('.'), message: i.message }];
  });
}

/** Parses and semantically validates a definition, or throws 400 INVALID_DEFINITION. */
export function validateDefinition(input: unknown): DefinitionBody {
  try {
    return validateUnguarded(input);
  } catch (err) {
    // Validation recurses through nested conditions and branch chains; a pathological
    // definition (thousands of levels) must be a 400, not a stack-overflow 500.
    if (err instanceof RangeError) {
      throw new ApiError(400, 'INVALID_DEFINITION', 'Definition is too deeply nested to validate');
    }
    throw err;
  }
}

function validateUnguarded(input: unknown): DefinitionBody {
  const parsed = definitionSchema.safeParse(input);
  if (!parsed.success) {
    throw new ApiError(400, 'INVALID_DEFINITION', 'Definition does not match the expected shape', {
      issues: flattenIssues(parsed.error.issues),
    });
  }
  const def = parsed.data as DefinitionBody;
  const problems = findProblems(def);
  if (problems.length) throw new ApiError(400, 'INVALID_DEFINITION', problems[0], { problems });
  return def;
}
