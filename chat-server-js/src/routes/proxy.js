const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const db = require('../db');
const {
  extractBearer,
  validateAccessToken,
  claimAllowsProvider,
  contingentBlocked
} = require('../oauth');

const router = express.Router();

function normalizeBase(url) {
  if (!url || typeof url !== 'string') return '';
  const trimmed = url.trim();
  try {
    const u = new URL(trimmed);
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

function providersInWallet(walletId) {
  return db.prepare(
    `SELECT id, name, base_url, api_key, enabled
     FROM providers
     WHERE wallet_id = ?
     ORDER BY created_at`
  ).all(walletId);
}

/**
 * If Authorization is a Chapterly access token, bind the wallet from its
 * provider claim. Provider API keys (standalone BYOK) are left untouched.
 *
 * On success returns { auth, walletId, provider } or { passthrough: true }.
 * On failure returns { error, status }.
 */
function resolveProxyAuth(req) {
  const raw = extractBearer(req);
  if (!raw) return { passthrough: true };

  const info = validateAccessToken(raw);
  if (!info.active) return { passthrough: true };

  const providerClaim = info.claims && info.claims.provider;
  if (!claimAllowsProvider(providerClaim, 'run') || !providerClaim.walletId) {
    return { error: 'token has no provider wallet', status: 403 };
  }

  const blocked = contingentBlocked(providerClaim.contingent);
  if (blocked) return { error: blocked, status: 403 };

  const walletId = providerClaim.walletId;
  const wallet = db.prepare('SELECT id FROM wallets WHERE id = ?').get(walletId);
  if (!wallet) return { error: 'wallet not found', status: 403 };

  const providers = providersInWallet(walletId).filter(p => p.enabled !== 0);
  const requestedProviderId = req.headers['x-provider-id'];
  const requestedBase = req.headers['x-target-base'];

  let provider = null;
  if (requestedProviderId) {
    provider = providers.find(p => p.id === requestedProviderId);
    if (!provider) return { error: 'provider is not in this wallet', status: 403 };
  } else if (requestedBase) {
    const want = normalizeBase(requestedBase);
    provider = providers.find(p => normalizeBase(p.base_url) === want);
    if (!provider) return { error: 'target is not in this wallet', status: 403 };
  } else if (providers.length === 1) {
    provider = providers[0];
  } else if (providers.length === 0) {
    return { error: 'wallet has no providers', status: 403 };
  } else {
    return { error: 'Missing x-target-base or x-provider-id header', status: 400 };
  }

  return { auth: info, walletId, provider };
}

router.use((req, res, next) => {
  const resolved = resolveProxyAuth(req);
  if (resolved.error) {
    return res.status(resolved.status).json({ error: resolved.error });
  }

  if (!resolved.passthrough) {
    req.auth = resolved.auth;
    req.walletId = resolved.walletId;
    req.walletProvider = resolved.provider;
    req.headers['x-target-base'] = resolved.provider.base_url;
    req.headers.authorization = `Bearer ${resolved.provider.api_key}`;
  }

  const targetBase = req.headers['x-target-base'];

  if (!targetBase) {
    return res.status(400).json({ error: 'Missing x-target-base header' });
  }

  console.log(`→ ${req.method} ${req.url}  →  ${targetBase}` +
    (req.walletId ? `  wallet=${req.walletId}` : ''));

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
        proxyReq.removeHeader('x-target-base');
        proxyReq.removeHeader('x-provider-id');
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
module.exports.resolveProxyAuth = resolveProxyAuth;
module.exports.normalizeBase = normalizeBase;
