// ---------- Definition (template) ----------

export type FieldType = 'text' | 'number' | 'single_select' | 'multi_select';

export interface Field {
  key: string;
  type: FieldType;
  label?: string;
  required?: boolean;
  /** Required (non-empty) for single_select / multi_select. */
  options?: string[];
}

export interface Step {
  id: string;
  fields: Field[];
}

export interface DataEntryTask {
  id: string;
  type: 'data_entry';
  steps: Step[];
  next: string;
}

export type Op = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains' | 'exists';

/** Compares one collected value. `field` is "<taskId>.<fieldKey>". */
export interface Leaf {
  field: string;
  op: Op;
  value?: unknown;
}

export type Condition = Leaf | { all: Condition[] } | { any: Condition[] };

export interface Rule {
  when: Condition;
  next: string;
}

export interface BranchTask {
  id: string;
  type: 'branch';
  rules: Rule[];
  default: string;
}

export interface EndTask {
  id: string;
  type: 'end';
}

export type Task = DataEntryTask | BranchTask | EndTask;
export type TaskType = Task['type'];

export interface DefinitionBody {
  name: string;
  startTaskId: string;
  tasks: Task[];
}

// ---------- Run (instance) ----------

/** Answers of completed data-entry tasks, keyed by taskId then field key. */
export type RunData = Record<string, Record<string, unknown>>;

export interface Decision {
  /** Index of the first matching rule, or null when the default path was taken. */
  matchedRule: number | null;
  next: string;
}

export type RunStatus = 'active' | 'completed' | 'cancelled';
export type RunTaskStatus = 'active' | 'completed' | 'cancelled';
