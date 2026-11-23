import './models'; // register models before sync()
import { createApp } from './app';
import { initDb } from './db';

async function main() {
  await initDb();
  const port = Number(process.env.PORT ?? 3000);
  createApp().listen(port, () => console.log(`Workflow engine listening on :${port}`));
}

main().catch((err) => {
  console.error('Failed to start', err);
  process.exit(1);
});
