import { Router } from 'express';
import { z } from 'zod';
import { wrap } from '../errors';
import { cancelRun, getRun, startRun, submit } from '../services/runService';

export const runsRouter = Router();

const startSchema = z.object({ definitionId: z.string().uuid() });
const submitSchema = z.object({
  action: z.enum(['save', 'complete']),
  data: z.record(z.unknown()).default({}),
});

runsRouter.post(
  '/',
  wrap(async (req, res) => {
    const { definitionId } = startSchema.parse(req.body);
    res.status(201).json(await startRun(definitionId));
  }),
);

runsRouter.get(
  '/:id',
  wrap(async (req, res) => {
    res.json(await getRun(req.params.id));
  }),
);

runsRouter.post(
  '/:id/tasks/:taskId/submit',
  wrap(async (req, res) => {
    const { action, data } = submitSchema.parse(req.body);
    res.json(await submit(req.params.id, req.params.taskId, action, data));
  }),
);

runsRouter.post(
  '/:id/cancel',
  wrap(async (req, res) => {
    res.json(await cancelRun(req.params.id));
  }),
);
