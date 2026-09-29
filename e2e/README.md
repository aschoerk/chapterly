# Chapterly E2E tests (Playwright, Docker single-origin)

Browser-driven tests that **control the real UI** so you don't have to repeat
usecases by hand. The workflow:

> **Record** real usecase-steps once (by hand or via codegen) → **save** them as
> reusable step helpers → **parameterize** the steps over data tables so the
> same usecase runs repeatably for every scenario.

---

## The test stack (why Docker)

One Docker container serves **SPA + API + LLM proxy on a single origin**:

```
http://127.0.0.1:8081
   ├─ /                the Angular SPA (dist/chat/browser)
   ├─ /api/*           chapterly-api-server (memory, seeded from JSON)
   └─ /proxy/chat/completions   LLM calls (intercepted by the browser mock)
```

Single origin means **no CORS allowlist, no `?port=` query param, no hash-router
surprises** — the Angular client resolves `apiBase`/`proxyBase` from
`window.location` and everything just works. The API runs in **memory
persistence seeded from `e2e/fixtures/seed.json`** (`PERSISTENCE=memory` +
`CHAPTERLY_SEED_FILE`), so every run starts from the same deterministic data.

---

## One-time setup

```sh
npm install            # @playwright/test is a dev dependency
npm run e2e:build      # builds API dist + SPA + the chapterly-dev image
npm run e2e:install    # one-time: download Playwright browsers  (npx playwright install chromium)
```

`npm run e2e` then:

1. starts the Docker stack (`docker compose -f docker-compose.e2e.yml up`),
2. waits for `http://127.0.0.1:8081/api/health`,
3. runs the specs in `/e2e/tests`.

Sanity-check the seeded stack manually:

```sh
npm run e2e:serve      # keep it running in a terminal
curl -s http://127.0.0.1:8081/api/projects   # → demo project
# open http://127.0.0.1:8081 in a browser
```

> Note: the seeded data lives in the container's ephemeral memory — recreate
> the container (`docker compose -f docker-compose.e2e.yml down`) to reset.

---

## How the LLM is simulated (wiremock-style)

The UI streams answers from `POST {proxyBase}/chat/completions`. Instead of a
real provider, `e2e/support/llm-mock.ts` intercepts that request in the browser
(`page.route('**/proxy/chat/completions')`) and fulfills it with canned SSE —
exactly like a wiremock.

```ts
await mockLlm(page, { answer: ['The hero is Ada.'] });
await askQuestion(page, 'Who is the hero?');
await expectNodeText(page, 'The hero is Ada.');
```

`mockLlm` returns a log of every request it saw, so assertions can check which
model/provider/messages the UI actually sent.

---

## The record → parameterize workflow

### 1. Record the steps (one time)

**Option A — by hand:** `npm run e2e:serve`, open `http://127.0.0.1:8081`, do the
usecase, note the steps.

**Option B — Playwright Codegen:**

```sh
npm run e2e:serve      # terminal 1: docker stack
npm run e2e:codegen    # terminal 2: records your clicks into a spec skeleton
```

### 2. Promote the steps to helpers

Put each recorded step behind a named function in `e2e/support/ui.ts`
(e.g. `newStory`, `askQuestion`, `expectNodeText`). Tests then read like prose.

### 3. Parameterize (make it repeatable)

```ts
const scenarios = [
  { project: 'Demo Project', question: 'Who is the hero?', answer: 'The hero is Ada.' },
  { project: 'Demo Project', question: 'Where does it happen?', answer: 'In a floating castle.' },
];

for (const s of scenarios) {
  test(`create a story and ask: "${s.question}"`, async ({ page }) => {
    await mockLlm(page, { answer: [s.answer] });
    await openApp(page);
    await newStory(page, s.project);
    await askQuestion(page, s.question);
    await expectNodeText(page, s.answer);
  });
}
```

One recorded usecase → a repeatable matrix. Adding a scenario = one row.

---

## Layout

```
e2e/
  fixtures/seed.json      # deterministic backend state (memory persistence)
  support/
    llm-mock.ts           # wiremock-style /proxy/chat/completions interception
    ui.ts                 # reusable recorded steps (helpers)
  tests/                  # one file per usecase-template
    chat-create-navigate.spec.ts
docker-compose.e2e.yml    # single-origin test stack (memory + seeded)
```

## Editing the seed

`e2e/fixtures/seed.json` is a `PersistenceSnapshot`:
`{ topics: [TopicSnapshot], providers: [ProviderSnapshot] }`. Change the demo
project/chat/nodes there to shape what a fresh run starts from. The API server
imports it via `CHAPTERLY_SEED_FILE` (see
`chapterly-api-server/src/persistence/factory.ts`).

## Rebuilding after source edits

The compose mounts `chapterly-api-server/dist` and `dist/chat/browser`, so after
editing app/server sources, rebuild before re-running:

```sh
npm run build:server   # chapterly-api-server/dist
npx ng build           # dist/chat/browser
```

(Dockerfile.dev bakes a build too, but the mounts take precedence in this stack.)

## Tips

- `fullyParallel: false` + `workers: 1`: one seeded in-memory API is shared;
