'use strict';

/**
 * Logging stand-in for openrouter.ai.
 *
 * Point Chapterly's provider base_url (settings / wallet provider) at
 *   http://127.0.0.1:3848
 * or
 *   http://127.0.0.1:3848/api/v1
 * instead of https://openrouter.ai or https://openrouter.ai/api/v1.
 *
 * chat-server is not modified. It already forwards to whatever is in
 * x-target-base / provider.base_url.
 */

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

const LISTEN_HOST = process.env.LISTEN_HOST || '127.0.0.1';
const LISTEN_PORT = Number(process.env.PORT || 3848);
const UPSTREAM = process.env.OPENROUTER_ORIGIN || 'https://openrouter.ai';
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, 'logs');
const REDACT_AUTH = process.env.REDACT_AUTH !== '0';
const LOG_STREAM_CHUNKS = process.env.LOG_STREAM_CHUNKS === '1';
const MAX_BODY_LOG = Number(process.env.MAX_BODY_LOG || 2_000_000);

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

let seq = 0;

function nowStamp() {
  return new Date().toISOString();
}

function nextId() {
  seq += 1;
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(seq, 4)}`;
}

function redactHeaders(headers) {
  const out = { ...headers };
  const keys = Object.keys(out);
  for (const k of keys) {
    if (k.toLowerCase() === 'authorization' && REDACT_AUTH) {
      const v = String(out[k] || '');
      const m = v.match(/^(Bearer\s+)(.+)$/i);
      if (m) {
        const tok = m[2];
        const keep = tok.length <= 8 ? '…' : `${tok.slice(0, 4)}…${tok.slice(-4)}`;
        out[k] = `${m[1]}${keep}`;
      } else {
        out[k] = '[redacted]';
      }
    }
  }
  return out;
}

function clip(buf) {
  if (!buf) return '';
  const s = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  if (s.length <= MAX_BODY_LOG) return s;
  return s.slice(0, MAX_BODY_LOG) + `\n… [truncated ${s.length - MAX_BODY_LOG} chars]`;
}

/**
 * OpenRouter's public API is https://openrouter.ai/api/v1/...
 * Clients that speak OpenAI-style base URLs often call /v1/models.
 * That path is the marketing site (HTML), not the JSON API.
 */
function rewriteUpstreamPath(rawUrl) {
  const raw = rawUrl || '/';
  const qIndex = raw.indexOf('?');
  const pathname = qIndex === -1 ? raw : raw.slice(0, qIndex);
  const search = qIndex === -1 ? '' : raw.slice(qIndex);

  if (pathname === '/v1' || pathname.startsWith('/v1/')) {
    return `/api${pathname}${search}`;
  }
  if (pathname === '/models' || pathname.startsWith('/models/')) {
    return `/api/v1${pathname}${search}`;
  }
  if (pathname === '/chat' || pathname.startsWith('/chat/')) {
    return `/api/v1${pathname}${search}`;
  }
  return raw;
}

function decodeBody(buf, encoding) {
  if (!buf || !buf.length) return buf;
  const enc = String(encoding || '').toLowerCase();
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf);
    if (enc === 'deflate') return zlib.inflateSync(buf);
    if (enc === 'br') return zlib.brotliDecompressSync(buf);
  } catch (err) {
    return Buffer.concat([
      Buffer.from(`[decode ${enc} failed: ${err.message}]\n`, 'utf8'),
      buf
    ]);
  }
  return buf;
}

function tryPretty(text) {
  const t = text.trim();
  if (!t) return text;
  if (t[0] !== '{' && t[0] !== '[') return text;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return text;
  }
}

function writeExchange(id, record) {
  const file = path.join(LOG_DIR, `${id}.log`);
  const lines = [];
  lines.push(`=== ${record.startedAt}  ${record.method} ${record.url}`);
  lines.push(`id: ${id}`);
  lines.push(`client: ${record.client}`);
  lines.push(`upstream: ${record.upstreamUrl}`);
  lines.push('');
  lines.push('--- request headers ---');
  lines.push(JSON.stringify(record.reqHeaders, null, 2));
  lines.push('');
  lines.push('--- request body ---');
  lines.push(record.reqBody || '(empty)');
  lines.push('');
  lines.push(`--- response status ${record.statusCode} ${record.statusMessage || ''} ---`);
  lines.push('--- response headers ---');
  lines.push(JSON.stringify(record.resHeaders, null, 2));
  lines.push('');
  lines.push('--- response body ---');
  lines.push(record.resBody || '(empty)');
  if (record.error) {
    lines.push('');
    lines.push('--- error ---');
    lines.push(record.error);
  }
  lines.push('');
  lines.push(`=== done ${record.finishedAt}  ${record.durationMs}ms`);
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
}

function consoleBanner(kind, id, extra) {
  console.log(`[${nowStamp()}] [${id}] ${kind} ${extra}`);
}

const server = http.createServer((clientReq, clientRes) => {
  const id = nextId();
  const started = Date.now();
  const startedAt = nowStamp();

  const upstreamBase = new URL(UPSTREAM);
  const incomingPath = clientReq.url || '/';
  const targetPath = rewriteUpstreamPath(incomingPath);
  const upstreamUrl = `${upstreamBase.origin}${targetPath}`;

  const reqChunks = [];
  clientReq.on('data', (c) => reqChunks.push(c));

  clientReq.on('end', () => {
    const reqBuf = Buffer.concat(reqChunks);
    const reqBodyRaw = clip(reqBuf);
    const reqBody = tryPretty(reqBodyRaw);

    const fwdHeaders = { ...clientReq.headers };
    // Node will set Host from the request options.
    delete fwdHeaders.host;
    delete fwdHeaders.connection;

    const isHttps = upstreamBase.protocol === 'https:';
    const lib = isHttps ? https : http;

    const options = {
      protocol: upstreamBase.protocol,
      hostname: upstreamBase.hostname,
      port: upstreamBase.port || (isHttps ? 443 : 80),
      method: clientReq.method,
      path: targetPath,
      headers: {
        ...fwdHeaders,
        host: upstreamBase.host
      }
    };

    consoleBanner(
      '→',
      id,
      `${clientReq.method} ${incomingPath}` +
        (incomingPath !== targetPath ? `  rewritten→ ${targetPath}` : '') +
        `  →  ${upstreamUrl}  (${reqBuf.length} bytes)`
    );

    const upReq = lib.request(options, (upRes) => {
      const resChunks = [];
      const ct = String(upRes.headers['content-type'] || '');
      const streaming = /text\/event-stream/i.test(ct) || clientReq.headers.accept === 'text/event-stream';

      clientRes.writeHead(upRes.statusCode || 502, upRes.headers);

      upRes.on('data', (c) => {
        resChunks.push(c);
        clientRes.write(c);
        if (LOG_STREAM_CHUNKS && streaming) {
          console.log(`[${nowStamp()}] [${id}] chunk ${c.length}B: ${clip(c).slice(0, 200).replace(/\n/g, '\\n')}`);
        }
      });

      upRes.on('end', () => {
        clientRes.end();
        const resBuf = Buffer.concat(resChunks);
        const decoded = decodeBody(resBuf, upRes.headers['content-encoding']);
        const resBodyRaw = clip(decoded);
        const resBody = streaming ? resBodyRaw : tryPretty(resBodyRaw);
        const finishedAt = nowStamp();
        const file = writeExchange(id, {
          startedAt,
          finishedAt,
          durationMs: Date.now() - started,
          method: clientReq.method,
          url: incomingPath !== targetPath ? `${incomingPath} → ${targetPath}` : incomingPath,
          client: `${clientReq.socket.remoteAddress}:${clientReq.socket.remotePort}`,
          upstreamUrl,
          reqHeaders: redactHeaders(clientReq.headers),
          reqBody,
          statusCode: upRes.statusCode,
          statusMessage: upRes.statusMessage,
          resHeaders: upRes.headers,
          resBody
        });
        consoleBanner(
          '←',
          id,
          `${upRes.statusCode}  ${resBuf.length} bytes  ${Date.now() - started}ms  log=${file}`
        );
      });
    });

    upReq.on('error', (err) => {
      console.error(`[${nowStamp()}] [${id}] upstream error: ${err.message}`);
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'content-type': 'application/json' });
      }
      const body = JSON.stringify({ error: 'openrouter-logger-proxy upstream error', message: err.message });
      clientRes.end(body);
      writeExchange(id, {
        startedAt,
        finishedAt: nowStamp(),
        durationMs: Date.now() - started,
        method: clientReq.method,
        url: targetPath,
        client: `${clientReq.socket.remoteAddress}:${clientReq.socket.remotePort}`,
        upstreamUrl,
        reqHeaders: redactHeaders(clientReq.headers),
        reqBody,
        statusCode: 502,
        statusMessage: 'Bad Gateway',
        resHeaders: {},
        resBody: body,
        error: err.stack || err.message
      });
    });

    if (reqBuf.length) upReq.write(reqBuf);
    upReq.end();
  });

  clientReq.on('error', (err) => {
    console.error(`[${nowStamp()}] [${id}] client error: ${err.message}`);
  });
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`openrouter-logger-proxy listening on http://${LISTEN_HOST}:${LISTEN_PORT}`);
  console.log(`upstream: ${UPSTREAM}`);
  console.log(`logs:     ${LOG_DIR}`);
  console.log('');
  console.log('In Chapterly settings / provider base_url replace');
  console.log('  https://openrouter.ai');
  console.log('with');
  console.log(`  http://${LISTEN_HOST}:${LISTEN_PORT}`);
  console.log('Keep the same path suffix you already use (e.g. /api/v1).');
  console.log('Do not change chat-server.');
});
