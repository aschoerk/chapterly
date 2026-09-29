import { Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Wiremock-style LLM for E2E tests.
//
// The Angular client calls POST {proxyBase}/chat/completions
// (proxyBase = the single E2E origin, e.g. http://127.0.0.1:8081/proxy) and
// streams the answer as a sequence of SSE `data:` events. Instead of letting
// the API server proxy to a real provider, these helpers intercept that
// request in the browser and fulfill it with a canned, deterministic SSE
// stream — exactly like a wiremock.
// ---------------------------------------------------------------------------

export const CHAT_COMPLETIONS_GLOB = '**/proxy/chat/completions';

export interface MockedLlmRequest {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}

export interface LlmMockScript {
  /** Assistant text lines — each emitted as its own content delta. */
  answer?: string[];
  /** Optional reasoning/thinking text streamed before the answer. */
  thinking?: string[];
  /** Optional extra raw SSE `data:` payloads (before [DONE]). */
  extraData?: string[];
  /** If true, respond with a non-stream JSON payload instead of SSE. */
  nonStream?: boolean;
}

const openaiData = (delta: Record<string, unknown>) =>
  `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;

const DONE = 'data: [DONE]\n\n';

/** Build an SSE body from a script. Separate events are concatenated. */
export function sseBody(script: LlmMockScript): string {
  if (script.nonStream) {
    throw new Error('sseBody() is only for streaming scripts');
  }
  const parts: string[] = [];
  for (const piece of script.thinking ?? []) {
    parts.push(openaiData({ reasoning_content: piece }));
  }
  for (const line of script.answer ?? ['(empty answer)']) {
    parts.push(openaiData({ content: line }));
  }
  for (const raw of script.extraData ?? []) {
    parts.push(`data: ${raw}\n\n`);
  }
  parts.push(DONE);
  return parts.join('');
}

/** Non-streaming OpenAI-style completion JSON. */
export function completionJson(answer: string): string {
  return JSON.stringify({
    choices: [{ message: { role: 'assistant', content: answer } }],
  });
}

/**
 * Install a wiremock for /proxy/chat/completions on `page`.
 * Returns the request log so tests can assert on what the UI actually sent
 * (model id, provider, message history, …).
 */
export async function mockLlm(
  page: Page,
  script: LlmMockScript = {}
): Promise<MockedLlmRequest[]> {
  const log: MockedLlmRequest[] = [];

  await page.route(CHAT_COMPLETIONS_GLOB, async (route) => {
    const req = route.request();
    const url = req.url();
    const method = req.method();
    const headers = req.headers();
    let body: MockedLlmRequest['body'] = null;
    try {
      const raw = req.postData();
      if (raw) body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      /* leave null */
    }
    log.push({ url, method, body, headers });

    const contentType = script.nonStream
      ? 'application/json'
      : 'text/event-stream';
    const bodyText = script.nonStream
      ? completionJson((script.answer ?? ['']).join('\n'))
      : sseBody(script);

    await route.fulfill({
      status: 200,
      contentType,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      },
      body: bodyText,
    });
  });

  return log;
}

/** Convenience: install + wait until at least one request has been recorded. */
export async function withLlmMock(
  page: Page,
  script: LlmMockScript = {},
  run: (log: MockedLlmRequest[]) => Promise<void>
): Promise<MockedLlmRequest[]> {
  const log = await mockLlm(page, script);
  await run(log);
  return log;
}