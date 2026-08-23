# Chat Client

A desktop chat client for Large Language Models focused on **recreating and managing multi-version conversation threads**.

The application lets you explore different answer versions, branch conversations, and keep a clear history of how a discussion evolved.

---

## Intentions

- Provide a clean interface for chatting with different LLM providers
- Treat conversation threads as first-class citizens (including multiple versions of answers)
- Keep all chat data local (SQLite)
- Work as a real desktop application (currently distributed as AppImage)

The Angular frontend talks exclusively to a local **chat-server**.  
The chat-server is responsible for:

- Storing chats and message versions in SQLite
- Proxying requests to LLM providers
- Exposing a simple REST API used by the Angular client

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
Your chat data is stored in:

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

---

## Architecture

```
┌─────────────────────┐
│   Angular Frontend  │
│  (Electron window)  │
└──────────┬──────────┘
           │ HTTP
           ▼
┌─────────────────────┐
│    chat-server      │
│  (Express + API)    │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│      SQLite         │
│  (chat history &    │
│   message versions) │
└─────────────────────┘
```

- The **Angular client** never talks directly to LLM providers.
- All communication goes through the **chat-server**.
- The chat-server uses **SQLite** to store chats, nodes, and version history.

---

## How to extend the project

### Adding a new API endpoint

1. Add the route in `chat-server/src/routes/`
2. Register it in `chat-server/src/app.js`
3. Call it from an Angular service

### Changing the database schema

Edit `chat-server/src/db.js`.  
The tables are created with `CREATE TABLE IF NOT EXISTS`, so you can extend them carefully.

### Adding a new LLM provider

The proxy layer lives in `chat-server/src/routes/proxy.js`.  
You can extend the provider handling there and expose the new provider through the existing API.

### UI changes

The Angular application lives under `src/`.  
Main chat-related components are located in `src/app/pages/chat/`.

---

## Scripts

| Command                  | Description                          |
|--------------------------|--------------------------------------|
| `npm run electron:dev`   | Start development mode               |
| `npm run build`          | Build the Angular frontend           |
| `npm run electron:build` | Build the production AppImage        |

---

## License

This project is licensed under the **Apache License 2.0**.
