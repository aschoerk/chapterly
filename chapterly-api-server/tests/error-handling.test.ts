/**
 * Regression test: an error thrown AFTER the response headers were already
 * sent (e.g. a mid-stream proxy failure) must not crash with
 * ERR_HTTP_HEADERS_SENT. The error handler should detect the committed
 * response and close the connection instead of trying to send a JSON body.
 */

import { beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { errorHandler } from '../src/http/create-app.js';

let app: Express;

beforeAll(() => {
  app = express();

  // Throwing routes registered BEFORE the error handler (matching real
  // ordering: /api + /proxy routes come before the error middleware).
  app.get('/api/__boom-before', () => {
    throw new Error('kaboom');
  });
  app.get('/api/__boom-before-next', (_req, _res, next) => {
    next(new Error('kaboom-next'));
  });
  app.get('/api/__boom-after', (_req, res) => {
    res.status(200);
    res.setHeader('Content-Type', 'text/plain');
    res.write('partial');
    throw new Error('mid-stream failure');
  });
  app.get('/api/__boom-after-next', (_req, res, next) => {
    res.status(200);
    res.setHeader('Content-Type', 'text/plain');
    res.write('partial');
    next(new Error('mid-stream failure next'));
  });

  // 4-argument function → Express classifies it as an ERROR handler.
  app.use((err: unknown, _req: unknown, res: Parameters<typeof errorHandler>[1], _next: unknown) => {
    errorHandler(err, res);
  });
  app.use((_req: unknown, res: Parameters<typeof errorHandler>[1]) => {
    res.status(404).json({ error: 'not found' });
  });
});

describe('error handling', () => {
  test('returns a 500 JSON body for an error passed via next()', async () => {
    const res = await request(app).get('/api/__boom-before-next');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('kaboom-next');
  });

  test('closes the connection when an error occurs after headers were sent (next)', async () => {
    const res = await request(app).get('/api/__boom-after-next');
    expect(res.status).toBe(200);
    expect(res.text).toBe('partial');
  });

  test('responds 404 through the normal fallback when no error is thrown', async () => {
    const res = await request(app).get('/api/__missing');
    expect(res.status).toBe(404);
  });
});