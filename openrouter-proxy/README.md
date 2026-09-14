# openrouter-logger-proxy

A second local server next to Chapterly `chat-server`. It pretends to be OpenRouter so you can point Chapterly at `localhost` and see the exact HTTP conversation between **chat-server** and **openrouter.ai**.

`chat-server` is not modified. It already sends LLM traffic to whatever URL is stored as the provider `base_url` / `x-target-base`.

## Run

```bash
cd openrouter-proxy
npm install
npm start
```

Listens on `http://127.0.0.1:3848` by default (`chat-server` uses `3847`).

## Point Chapterly at it

In Chapterly settings (wallet provider / OpenRouter base URL) replace only the host:

| was | use |
|---|---|
| `https://openrouter.ai` | `http://127.0.0.1:3848` |
| `https://openrouter.ai/api/v1` | `http://127.0.0.1:3848/api/v1` |

Leave the API key as-is.

OpenRouter JSON lives at `/api/v1`, not `/v1`. `GET /v1/models` is the website
(HTML). The proxy rewrites `/v1/...` → `/api/v1/...` (and `/models`, `/chat/...`
the same way). Restart the proxy after pulling the updated `server.js`.

## Logs

Each exchange is written under `./logs/` as `YYYYMMDD-HHMMSS-NNNN.log`:

- request method, URL, headers (Authorization redacted unless `REDACT_AUTH=0`)
- request body (JSON pretty-printed when possible)
- response status, headers, body (SSE streams kept as raw text)

Console shows a one-line `→` and `←` per call.

## Env

| variable | default | meaning |
|---|---|---|
| `PORT` | `3848` | listen port |
| `LISTEN_HOST` | `127.0.0.1` | listen address |
| `OPENROUTER_ORIGIN` | `https://openrouter.ai` | real upstream |
| `LOG_DIR` | `./logs` | log directory |
| `REDACT_AUTH` | `1` | set `0` to log full Bearer tokens |
| `LOG_STREAM_CHUNKS` | `0` | set `1` to print SSE chunks live |
| `MAX_BODY_LOG` | `2000000` | max chars stored per body |

Example:

```bash
PORT=3848 LOG_STREAM_CHUNKS=1 npm start
```
