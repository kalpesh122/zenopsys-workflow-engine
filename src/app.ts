import express, { Express } from 'express';
import { errorHandler } from './errors';
import { rejectUnsafeJson } from './jsonGuard';
import { definitionsRouter } from './routes/definitions';
import { runsRouter } from './routes/runs';

export function createApp(): Express {
  const app = express();
  app.use(express.json({ limit: '1mb', reviver: rejectUnsafeJson }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.use('/definitions', definitionsRouter);
  app.use('/runs', runsRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found', details: null } });
  });
  app.use(errorHandler);
  return app;
}
