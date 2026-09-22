const { app, BrowserWindow, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');

let mainWindow = null;
let serverInstance = null;

/**
 * Finds a free port starting from the preferred one.
 */
function findFreePort(startPort = 3847) {
  return new Promise((resolve) => {
    const tester = net.createServer();

    tester.once('error', () => {
      // Port is taken → try next
      resolve(findFreePort(startPort + 1));
    });

    tester.once('listening', () => {
      const { port } = tester.address();
      tester.close(() => resolve(port));
    });

    tester.listen(startPort, '127.0.0.1');
  });
}

/**
 * Starts the chapterly-api-server on a free port.
 *
 * The server is written in TypeScript and shipped as compiled ESM in
 * chapterly-api-server/dist (see Dockerfile.dev, which runs `node dist/server.js`).
 * We run it in-process: createPersistence() picks the sqlite store (kept under
 * the Electron userData dir), then createApp(store) serves the REST API and,
 * if present, the built Angular SPA.
 */
async function startServer() {
  const port = await findFreePort(3847);

  // Important: set the port before the server is created so every part of the
  // process that reads process.env.PORT (store, server, SPA query param) agrees.
  process.env.PORT = String(port);

  const serverDist = path.join(__dirname, '..', 'chapterly-api-server', 'dist', 'http', 'create-app.js');
  const factoryDist = path.join(__dirname, '..', 'chapterly-api-server', 'dist', 'persistence', 'factory.js');

  if (!fs.existsSync(serverDist) || !fs.existsSync(factoryDist)) {
    throw new Error(
      'chapterly-api-server/dist is missing or incomplete.\n' +
      'Build it first with:  cd chapterly-api-server && npm run build'
    );
  }

  // chapterly-api-server is an ES module ("type": "module") — load it with a
  // dynamic import instead of require().
  const { createPersistence } = await import(`file://${factoryDist}`);
  const { createApp } = await import(`file://${serverDist}`);

  const store = await createPersistence();
  const expressApp = createApp(store);

  const server = expressApp.listen(port, '127.0.0.1', () => {
    console.log(`✅ chapterly-api-server running on http://localhost:${port} (${store.kind}) (started by Electron)`);
  });

  return { port, server };
}

/**
 * Creates the main application window.
 */
async function createWindow() {
  let port;
  try {
    const started = await startServer();
    port = started.port;
    serverInstance = started.server;
  } catch (err) {
    console.error('❌ Failed to start chapterly-api-server:', err);
    dialog.showErrorBox(
      'Chapterly',
      `Could not start the local API server:\n\n${err.message}`
    );
    app.quit();
    return;
  }

  // In-app nav already has Stories / Read / … — hide the native File/Window menu
  // that otherwise sits on top of the Chapterly header.
  Menu.setApplicationMenu(null);

  const iconCandidates = [
    path.join(__dirname, 'icon.png'),
    path.join(__dirname, '..', 'public', 'favicon.png'),
    path.join(__dirname, 'renderer', 'browser', 'favicon.png'),
    path.join(__dirname, '..', 'public', 'favicon.svg'),
  ];
  const icon = iconCandidates.find(candidate => fs.existsSync(candidate));
  if (!icon) {
    console.warn('Chapterly window icon not found. Looked in:', iconCandidates);
  } else {
    console.log('Chapterly window icon:', icon);
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    show: true,
    title: 'Chapterly',
    autoHideMenuBar: true,
    icon: icon || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const isDev = !app.isPackaged;

  if (isDev) {
    // ---------- Development ----------
    await mainWindow.loadURL(`http://localhost:4200?port=${port}`);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    // ---------- Production ----------
    // Angular is built into: electron/renderer/
    const indexPath = path.join(__dirname, 'renderer', 'browser', 'index.html');

    if (!fs.existsSync(indexPath)) {
      console.error('❌ index.html not found at:', indexPath);
      app.quit();
      return;
    }

    console.log('✅ Loading frontend from:', indexPath);

    await mainWindow.loadFile(indexPath, {
      query: { port: String(port) },
    });
  }

  // Extra safety
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

// Also force it after a short delay
  setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) {
      console.log('Window was not visible – forcing show()');
      mainWindow.show();
      mainWindow.focus();
    }
  }, 800);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// --------------------------------------------------
// App lifecycle
// --------------------------------------------------

app.whenReady().then(createWindow);

function cleanup() {
  if (serverInstance) {
    try {
      serverInstance.close();
      console.log('chapterly-api-server closed');
    } catch (e) {
      console.warn('Error closing server:', e);
    }
    serverInstance = null;
  }
}

app.on('window-all-closed', () => {
  cleanup();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', cleanup);
app.on('will-quit', cleanup);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Optional: clean shutdown
app.on('before-quit', () => {
  if (serverInstance) {
    serverInstance.close();
  }
});
