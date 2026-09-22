# chapterly-api-server

Typed TypeScript server for Chapterly `ChatApiPort`
(`src/app/api/chat-api.port.ts` in the Angular app).

HTTP paths match `ChatApiService` (`/api/projects`, `/api/chats`, …).

## Layers

- **ChatApiPort** — same methods as the Angular port
- **PersistencePort** — port + `kind` / `init` / `close`
- **MemoryPersistence** — domain logic (clone, node versions, topic↔project)
- **SnapshotBackend** — replaceable store

## Snapshots

Persistence is partitioned, not one global blob:

| Partition | Contents |
|-----------|----------|
| **topic** | topic, projects, personas, chats, nodes, content chat-parameters |
| **provider** | provider, models, model chat-parameters |

Chats/personas without a topic use `_unscoped`.

Each snapshot has:

- `revision` — integer; compare-and-swap on flush
- `updateId` — UUID of the last successful writer

If another node already flushed the same topic/provider, save returns **409**.

Backends:

- `PERSISTENCE=memory` — in-process only
- `PERSISTENCE=sqlite` — default local / Electron (`data/chapterly.sqlite`)
- `PERSISTENCE=firebase` — Cloud Run / AWS default (`topic_snapshots`, `provider_snapshots`)

## Run

```
npm install
PERSISTENCE=memory npm run dev
```

Default port is `3847`. Electron: bind `127.0.0.1`, pass `?port=` as today.

OAuth and LLM `/proxy` are not in this package (not on `ChatApiPort`).
