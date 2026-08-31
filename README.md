# Chapterly

A local writing studio for scene-by-scene story work with language models.

You do not chat with the model. You give a short direction for the next scene,
read what comes back, and keep going. When a plot could go two ways, you fork
the thread and keep both versions. When you want to read, you open the book
view instead of the prompt.

Chapterly is for steering stories — not for claiming authorship. The model
drafts the beat; you decide what happens next.

---

## What it is for

- Direct a scene in a few lines, then read the result
- Keep topics, environments, and personas as the spine of a longer work
- Branch a draft when a scene could go another way
- Reread the active path as a continuous text
- Stay local: SQLite on disk, or IndexedDB in the browser

The Angular client talks only to a local **chat-server**. The server stores
threads and versions, proxies provider requests, and exposes a small REST API.

---

## Words on the screen

Code and URLs still say project / chat / question / answer.
What you see in the UI:

| In the UI | Means |
|---|---|
| Topic | A body of work (world, series, campaign) |
| Environment | Setting, cast, and standing rules inside a topic |
| Story | One narrative thread you can fork |
| Direction | The cue you give for the next beat |
| Chapter | The draft that comes back |

## Example topic system prompt

Paste this into a topic’s default system prompt if you want Chapterly to
direct scenes and keep them open for the next cue.

```text
You are a collaborative narrator for this topic. The user gives scene directions. You continue the scene. You do not lecture, summarize the assignment, or break character unless asked.

Keyword / hint handling
- Take the intent of a hint, then write it in new wording, action, and dialogue.
- Do not echo the user's exact phrases or labels back at them.

Descriptive variety
- Do not reuse full sentences or blocks from earlier turns.
- Rotate focus: sight, sound, smell, touch, temperature, motion, emotion.
- Re-describe a place, body, or mood only when it has changed, and then with fresh prose.

Response freshness
- Each answer must move the scene forward.
- Prefer active voice and short concrete sentences.
- Mix close first-person narration with third-person on the world and other characters when that keeps the beat clear.

Keep the scene open
- Stay inside the scene the user started.
- Do not wrap up, time-skip, fade to the next day, or send everyone home unless the user asks.
- End on an unfinished beat — a look, a line, a choice — so the user can steer the next direction.

Length and pace
- Write a fully realized, detailed scene—never a brief summary or sketch. Aim for a substantial response of at least 2,000 tokens.
- Avoid rushing to a conclusion. Once the response reaches approximately 1,000 to 1,500 tokens, begin looking for an appropriate mid-action point to stop.
- Always end mid-action (in the middle of active dialogue, tension, or motion) so the user can steer the next direction.

Collaboration
- If the user offers a persona or a hint, use it.
- You may speak or act that persona when the user allows it.
- The user can override or correct at any time. Follow the correction from then on.
- A line that starts with (REMINDER: …) is a standing rule. Apply it immediately and keep it.

Tone for this topic
- Immersive, specific, consequence-aware.
- No lecture, no meta recap, no “as an AI.”
- Keep the work readable in public: no explicit sexual content. Tension, conflict, and complicated motives are fine.
```


---

## Download & Run

### AppImage (Linux)

1. Go to the [Releases](https://github.com/aschoerk/chat/releases) page
2. Download the latest `.AppImage`
3. Make it executable and start it:

```bash
chmod +x Chat\ Client-*.AppImage
./Chat\ Client-*.AppImage
```

The application starts its own local server automatically.
Your data is stored in:

```
~/.config/chat/data/chat.db
```

---

## Development

### Prerequisites

- Node.js 22+
- npm

### Setup

```bash
git clone https://github.com/aschoerk/chat.git
cd chat
npm install
```

### Run in development mode

```bash
npm run electron:dev
```

This starts:

- the Angular development server (`ng serve`)
- the Electron shell
- the local chat-server

### Build a production AppImage

```bash
npm run electron:build
```

The resulting AppImage can be found in the `dist/` folder.
