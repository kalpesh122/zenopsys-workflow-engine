import { ApiError } from '../errors';
import type { Field, Step } from '../domain/types';

/** Strict JSON types, no coercion ("700" is not a number). Returns an error message or null. */
function typeError(field: Field, value: unknown): string | null {
  switch (field.type) {
    case 'text':
      return typeof value === 'string' ? null : 'must be a string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : 'must be a JSON number';
    case 'single_select':
      return typeof value === 'string' && field.options!.includes(value)
        ? null
        : `must be one of: ${field.options!.join(', ')}`;
    case 'multi_select': {
      if (!Array.isArray(value)) return 'must be an array';
      if (value.some((v) => typeof v !== 'string' || !field.options!.includes(v))) {
        return `every item must be one of: ${field.options!.join(', ')}`;
      }
      return new Set(value).size === value.length ? null : 'items must be distinct';
    }
  }
}

const isEmpty = (v: unknown) =>
  v === undefined || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

/**
 * Validates a submission against the current step and returns this step's values
 * (earlier draft values for the step, overridden by the new input). The caller merges
 * them into the task draft. `complete` additionally enforces required fields.
 */
export function validateStepInput(
  step: Step,
  input: Record<string, unknown>,
  draft: Record<string, unknown>,
  mode: 'save' | 'complete',
): Record<string, unknown> {
  const errors: { key: string; message: string }[] = [];
  const byKey = new Map(step.fields.map((f) => [f.key, f]));

  for (const [key, value] of Object.entries(input)) {
    const field = byKey.get(key);
    if (!field) {
      errors.push({ key, message: `is not a field of step "${step.id}"` });
      continue;
    }
    const msg = typeError(field, value);
    if (msg) errors.push({ key, message: msg });
  }

  const values: Record<string, unknown> = {};
  for (const f of step.fields) {
    // Object.hasOwn, not `in`: a field named "constructor"/"toString" must not read Object.prototype.
    if (Object.hasOwn(input, f.key)) values[f.key] = input[f.key];
    else if (Object.hasOwn(draft, f.key)) values[f.key] = draft[f.key];
  }

  if (mode === 'complete') {
    for (const f of step.fields) {
      const value = Object.hasOwn(values, f.key) ? values[f.key] : undefined;
      if (f.required && isEmpty(value) && !errors.some((e) => e.key === f.key)) {
        errors.push({ key: f.key, message: 'is required' });
      }
    }
  }

  if (errors.length) {
    throw new ApiError(400, 'INVALID_INPUT', `Invalid input for step "${step.id}"`, { errors });
  }
  return values;
}
