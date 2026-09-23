import { createPersistence, detectPersistenceKind } from './persistence/factory.js';
import { createApp } from './http/create-app.js';

async function main(): Promise<void> {
  const store = await createPersistence();
  const app = createApp(store);
  const port = Number(process.env.PORT ?? 3847);
  const host = process.versions.electron ? '127.0.0.1' : '0.0.0.0';
  app.listen(port, host, () => {
    console.log(`chapterly-api ${store.kind} on ${host}:${port} (detect=${detectPersistenceKind()})`);
  });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
