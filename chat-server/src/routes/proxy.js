const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const router = express.Router();

router.use((req, res, next) => {
  const targetBase = req.headers['x-target-base'];

  if (!targetBase) {
    return res.status(400).json({ error: 'Missing x-target-base header' });
  }

  console.log(`→ ${req.method} ${req.url}  →  ${targetBase}`);

  const proxy = createProxyMiddleware({
    target: targetBase,
    changeOrigin: true,
    secure: false,
    pathRewrite: { '^/': '' }, // because we are already under /proxy
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
      proxyRes: (proxyRes) => {
        console.log(`← Status: ${proxyRes.statusCode}`);
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

module.exports = router;
