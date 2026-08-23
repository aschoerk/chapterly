const { app, BrowserWindow } = require('electron');
const path = require('path');
const net = require('net');
const { createApp } = require('../chat-server/src/app');

const PREFERRED_PORT = 3848;
let mainWindow;
let server;
let actualPort;

function findFreePort(startPort) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.listen(startPort, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });

    server.on('error', () => {
      // Port is taken → try next one
      resolve(findFreePort(startPort + 1));
    });
  });
}

async function startServer() {
  const port = await findFreePort(PREFERRED_PORT);   // ← we decide the port here

  process.env.PORT = String(port);

  const expressApp = createApp();          // ← only creates the Express app
  server = expressApp.listen(port, () => { // ← we tell it which port to use
    console.log(`✅ Chat server running on http://localhost:${port} started by electron`);
  });

  return port;
}

async function createWindow() {
  const port = await startServer();

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--server-port=${port}`]
    }
  });

  if (!app.isPackaged) {
    mainWindow.loadURL(`http://localhost:4200?port=${port}`);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, '../dist/chat/browser/index.html'),
      { query: { port: String(port) } }
    );
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (server) server.close();
  if (process.platform !== 'darwin') app.quit();
});
