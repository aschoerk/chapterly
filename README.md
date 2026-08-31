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

```
| In the UI   | Means                                                                        |
| ----------- | ---------------------------------------------------------------------------- |
| Topic       | A body of work, plus the standing narrator rules (system prompt)             |
| Environment | A general setting-idea inside that topic: place, tone, who tends to be there |
| Story       | One narrative thread you can fork                                            |
| Direction   | The cue you give for the next beat                                           |
| Chapter     | The draft that comes back                                                    |
```

## First hour

Chapterly does not ship a model. You bring a provider key, pick a model,
then set the room the story happens in.

### 1. API token

You need an API token from a provider that speaks the OpenAI-style chat API.

[OpenRouter](https://openrouter.ai/) is the usual choice: one key, many models.
DeepSeek (including Pro), GLM, Kimi, Claude Sonnet, and Grok are available
there or from the vendor’s own endpoint.

In **Settings → Providers** add the provider (name, base URL, token).
For OpenRouter the base URL is `https://openrouter.ai/api/v1`.

Keep the token on this machine. Chapterly only talks to your local server;
the server is what calls the provider.

### 2. Choose a model

Still in **Settings**, fetch the provider’s catalog and enable the models
you actually want. Mark one as a preset if you use it all the time.

A long-context, instruction-following model is enough. You are giving
scene directions, not running a toolbox agent.

### 3. Topic rules, environment, personas, first direction

The **Topic** holds how the narrator writes. The **Environment** only says
what kind of place this is.

1. Open **Environments**. Create a **Topic** and paste the system prompt from
   the section below into the topic’s default system prompt.
2. Create an **Environment** in that topic. Do not paste the long narrator
   rules again. Write a short setting-idea: where we are in general, the
   mood, the kind of people who show up. Leave room for many stories.
3. Create the **Personas** that belong here and attach them to the
   environment. They are who the narrator may speak for.
4. Open **Stories** and start a story in that environment.
5. The first **Direction** is the Situation: this hour, these people, this
   pressure. Then read the **Chapter**. Later directions only steer.

Environment example (setting-idea, not a scene):

```text
A provincial night-train line that never quite reaches the capital.
Second-class compartments, weak tea, letters people should have sent.
Quiet, slightly wrong, no rush to explain the world.
```

Situation example (first direction of one story):

```text
Night train, second-class compartment. Mara has the window seat and a
folded letter she has not opened. A conductor passes and does not stop.
Begin with the letter. Do not skip to the destination.
```


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
- Write a full scene beat, not a sketch. Aim for a long, detailed passage.
- After the draft is already long, do not rush to a conclusion. Stop mid-action.

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
chmod +x Chapterly-*.AppImage
./Chapterly-*.AppImage
```

The application starts its own local server automatically.
Your data is stored in:

```
~/.config/chat/data/chat.db
```

### Windows

1. Go to the [Releases](https://github.com/aschoerk/chat/releases) page
2. Download the latest Windows installer (`Chapterly Setup *.exe`, NSIS)
3. Run the installer. You can choose the folder; it is not a one-click-only install.
4. Start **Chapterly** from the Start menu or the desktop shortcut.

The application starts its own local server automatically.
Your data is stored in:

```
%APPDATA%\chat\data\chat.db
```

If Windows Defender SmartScreen warns about an unknown publisher, choose
**More info** → **Run anyway**. The build is unsigned unless a code-signing
certificate is added later.

To build the installer yourself on Windows:

```bash
npm install
npm run electron:build
```

The `.exe` installer is written to the `dist/` folder.

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

On Windows the same command builds the NSIS installer instead of an AppImage.
