import { Router } from 'express';
import { validateDefinition } from '../domain/definitionSchema';
import { ApiError, isUuid, wrap } from '../errors';
import { WorkflowDefinition } from '../models';

export const definitionsRouter = Router();

const view = (d: WorkflowDefinition) => ({
  id: d.id,
  name: d.name,
  startTaskId: d.startTaskId,
  tasks: d.tasks,
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
});

async function find(id: string): Promise<WorkflowDefinition> {
  const def = isUuid(id) ? await WorkflowDefinition.findByPk(id) : null;
  if (!def) throw new ApiError(404, 'DEFINITION_NOT_FOUND', `Definition "${id}" not found`);
  return def;
}

definitionsRouter.post(
  '/',
  wrap(async (req, res) => {
    const body = validateDefinition(req.body);
    const def = await WorkflowDefinition.create(body);
    res.status(201).json(view(def));
  }),
);

definitionsRouter.get(
  '/:id',
  wrap(async (req, res) => {
    res.json(view(await find(req.params.id)));
  }),
);

/** Full replace, in place. Runs already started keep executing their own snapshot. */
definitionsRouter.put(
  '/:id',
  wrap(async (req, res) => {
    const def = await find(req.params.id);
    const body = validateDefinition(req.body);
    def.set(body);
    await def.save();
    res.json(view(def));
  }),
);
