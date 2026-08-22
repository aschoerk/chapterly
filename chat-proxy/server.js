const express = require('express');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');
const http = require('http');

const app = express();
const STARTPORT = 3000;
const fs = require('fs');
const path = require('path');
const portfinder = require('portfinder');

// Very permissive CORS for local development
app.use(cors({
  origin: 'http://localhost:4200',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'x-target-base',
    'HTTP-Referer',
    'X-Title'
  ]
}));

// 2. Proxy MUST come BEFORE express.json()
app.use('/proxy', (req, res, next) => {
  const targetBase = req.headers['x-target-base'];

  if (!targetBase) {
    return res.status(400).json({ error: 'Missing x-target-base header' });
  }

  console.log(`→ Proxying ${req.method} ${req.url}  to  ${targetBase}`);

  const proxy = createProxyMiddleware({
    target: targetBase,
    changeOrigin: true,
    secure: false,
    pathRewrite: {
      '^/proxy': ''
    },
    on: {
      proxyReq: (proxyReq, req) => {
        if (req.headers.authorization) {
          proxyReq.setHeader('Authorization', req.headers.authorization);
        }
        if (req.headers['http-referer']) {
          proxyReq.setHeader('HTTP-Referer', req.headers['http-referer']);
        }
        if (req.headers['x-title']) {
          proxyReq.setHeader('X-Title', req.headers['x-title']);
        }
      },
      // Log the response from the provider
      proxyRes: (proxyRes, req, res) => {
        const status = proxyRes.statusCode;
        console.log(`← Response status: ${status}`);

        // Only collect and print the body on errors (4xx / 5xx)
        if (status >= 400) {
          let body = [];

          proxyRes.on('data', (chunk) => {
            body.push(chunk);
          });

          proxyRes.on('end', () => {
            const bodyString = Buffer.concat(body).toString('utf8');
            try {
              const json = JSON.parse(bodyString);
              console.log('← Error body:', JSON.stringify(json, null, 2));
            } catch {
              console.log('← Error body:', bodyString.substring(0, 800));
            }
            console.log('----------------------------------------');
          });
        } else {
          console.log('----------------------------------------');
        }
      },
      error: (err, req, res) => {
        console.error('Proxy error:', err.message);
        if (!res.headersSent) {
          res.status(500).json({ error: err.message });
        }
      }
    }
  });

  return proxy(req, res, next);
});

// 3. Body parser only AFTER the proxy
app.use(express.json({ limit: '10mb' }));

// Health check
app.get('/', (req, res) => {
  res.send('Chat Proxy is running');
});


(async () => {
  // Start looking from port 3000
  portfinder.basePort = STARTPORT;

  const PORT = await portfinder.getPortPromise();

  // Write the chosen port so Angular can read it
  const configPath = path.join(__dirname, '../src/assets/proxy-config.json');

  // Ensure the assets folder exists
  const assetsDir = path.dirname(configPath);
  if (!fs.existsSync(assetsDir)) {
    fs.mkdirSync(assetsDir, { recursive: true });
  }

  fs.writeFileSync(configPath, JSON.stringify({ port: PORT }, null, 2));
  console.log(`📝 Wrote proxy port ${PORT} to ${configPath}`);

  app.listen(PORT, () => {
    console.log(`✅ Proxy server running on http://localhost:${PORT}`);
  });
})();
