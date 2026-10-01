import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { LlmLogService, LLM_LOG_LIMIT, LlmLogEntry, summarizeLlmRequest } from './llm-log.service';

describe('LlmLogService', () => {
  let service: LlmLogService;

  beforeEach(async () => {
    localStorage.clear();
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      providers: [provideHttpClient()]
    }).compileComponents();
    service = TestBed.inject(LlmLogService);
    await service.clear();
  });

  it('records a chat request with a timestamp and keeps full content', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const longText = 'A'.repeat(5000); // must NOT be shortened in the stored entry
    const entry = service.record({
      kind: 'chat',
      modelId: 'model/x',
      provider: 'https://provider',
      endpoint: 'chat/completions',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: longText },
      ],
      extras: { temperature: 0.7 },
    });

    await service.flush();

    // Timestamp present on the returned entry.
    expect(entry.ts).toBeGreaterThan(0);
    expect(entry.iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const entries = service.entries();
    expect(entries.length).toBeGreaterThan(0);
    const stored = entries.find(e => e.seq === entry.seq) ?? entry;
    // Full content, NOT shortened.
    expect(stored.messages?.[1]?.content).toBe(longText);
    // Summary exists (console one-liner shape), logged to console.
    expect(stored.summary).toContain('[llm:chat]');
    expect(stored.summary).toContain('messages=2');
    const logged = String(logSpy.mock.calls.find(c => String(c[0]).includes('[llm:chat]'))?.[0]);
    expect(logged).toContain('model=model/x');
    logSpy.mockRestore();
  });

  it('records an image request as a single full prompt', async () => {
    const prompt = 'P'.repeat(4000);
    const entry = service.record({
      kind: 'image',
      modelId: 'img/model',
      provider: 'https://provider',
      endpoint: 'images',
      prompt,
    });

    await service.flush();

    expect(entry.summary).toContain('[llm:image]');
    expect(entry.summary).toContain('messages=1');
    const stored = service.entries().find(e => e.seq === entry.seq) ?? entry;
    expect(stored.prompt).toBe(prompt);
  });

  it('keeps the chat title on the entry and includes it in the summary', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const entry = service.record({
      kind: 'chat',
      modelId: 'model/x',
      provider: 'https://provider',
      chatId: 'chat-1',
      chatTitle: 'My Story',
      messages: [{ role: 'user', content: 'hi' }],
    });

    await service.flush();

    const stored = service.entries().find(e => e.seq === entry.seq) ?? entry;
    expect(stored.chatId).toBe('chat-1');
    expect(stored.chatTitle).toBe('My Story');
    // The one-line output carries the chat title too.
    expect(entry.summary).toContain('chat="My Story"');
    const logged = String(logSpy.mock.calls.find(c => String(c[0]).includes('[llm:chat]'))?.[0]);
    expect(logged).toContain('chat="My Story"');
    logSpy.mockRestore();
  });

  it('escapes inner quotes / collapses newlines in the chat title label', () => {
    const line = summarizeLlmRequest({
      kind: 'image',
      modelId: 'm',
      provider: 'p',
      chatTitle: 'A "Great"\n\nTale',
      prompt: 'x',
    });
    expect(line).toContain('chat="A \\"Great\\" Tale"');
  });

  it('keeps a fixed FIFO buffer of at most 1000 entries (oldest dropped)', async () => {
    const total = LLM_LOG_LIMIT + 25;
    for (let i = 0; i < total; i++) {
      service.record({
        kind: 'chat',
        modelId: `m${i}`,
        provider: 'https://provider',
        messages: [{ role: 'user', content: `msg ${i}` }],
      });
    }
    await service.flush();

    const entries = service.entries();
    expect(entries.length).toBeLessThanOrEqual(LLM_LOG_LIMIT);
    // Newest kept (descending seq order).
    const newest = Math.max(...entries.map(e => e.seq));
    expect(newest).toBe(total);
    // Oldest dropped — the very first recorded entry is gone.
    expect(entries.some(e => e.modelId === 'm0')).toBe(false);
  });

  it('deletes oldest entries until the total fits under the configured byte size limit', async () => {
    // The minimum allowed limit is 1 MB — fill it with a few big entries.
    service.setSizeLimit(1 * 1024 * 1024);
    const big = 'X'.repeat(200 * 1024); // ~400 KB per entry (body + messages)
    for (let i = 0; i < 3; i++) {
      service.record({
        kind: 'chat',
        modelId: `m${i}`,
        provider: 'p',
        messages: [{ role: 'user', content: `${big}${i}` }],
        body: {
          model: `m${i}`,
          messages: [{ role: 'user', content: `${big}${i}` }],
          stream: false,
        },
      });
    }
    await service.flush();

    const entries = service.entries();
    // The oldest entry is gone — only newest entries fit the 1 MB cap.
    expect(entries.some(e => e.modelId === 'm0')).toBe(false);
    const total = entries.reduce((s, e) => s + (e.size ?? 0), 0);
    expect(total).toBeLessThanOrEqual(1 * 1024 * 1024);
    expect(entries.some(e => e.modelId === 'm2')).toBe(true);
  });

  it('setSizeLimit clamps to the allowed range and persists per-browser', async () => {
    service.setSizeLimit(10 * 1024 * 1024 * 1024); // > 1 GB → clamped to 1 GB
    expect(service.sizeLimit()).toBe(1024 * 1024 * 1024);
    expect(localStorage.getItem('chat.llmLog.sizeLimit')).toBe(String(1024 * 1024 * 1024));

    service.setSizeLimit(-5); // invalid (< 1 MB) → falls back to the default
    expect(service.sizeLimit()).toBe(50 * 1024 * 1024);
    await service.flush();
  });

  it('reads a previously stored size limit from localStorage', async () => {
    localStorage.setItem('chat.llmLog.sizeLimit', String(12 * 1024 * 1024));
    // A fresh module re-runs the service constructor, which reads the limit.
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      providers: [provideHttpClient()]
    }).compileComponents();
    const fresh = TestBed.inject(LlmLogService);
    await fresh.clear();
    expect(fresh.sizeLimit()).toBe(12 * 1024 * 1024);
  });

  it('clear() removes all entries', async () => {
    service.record({ kind: 'chat', modelId: 'm', provider: 'p', messages: [{ role: 'user', content: 'x' }] });
    await service.flush();
    expect(service.entries().length).toBeGreaterThan(0);

    await service.clear();
    expect(service.entries().length).toBe(0);
  });

  it('summarizeLlmRequest previews but never shortens storage (pure helper)', () => {
    const text = 'x'.repeat(400);
    const input = {
      kind: 'chat' as const,
      modelId: 'm',
      provider: 'p',
      messages: [{ role: 'user', content: text }],
    };
    const line = summarizeLlmRequest(input);
    expect(line).toContain('first={user/text → "');
    // Preview is shortened to 160 chars.
    expect(line.length).toBeLessThan(text.length + 120);
  });

  it('degrades gracefully to an in-memory buffer when IndexedDB is unavailable', async () => {
    // Simulate an env without indexedDB.
    const real = (globalThis as any).indexedDB;
    try {
      Object.defineProperty(globalThis, 'indexedDB', {
        configurable: true,
        value: undefined,
      });
      const svc = TestBed.inject(LlmLogService);
      await svc.clear();
      svc.record({ kind: 'chat', modelId: 'm', provider: 'p', messages: [{ role: 'user', content: 'hi' }] });
      await svc.flush();
      expect(svc.entries().length).toBe(1);
      expect(svc.persisted()).toBe(false);
    } finally {
      if (real === undefined) {
        delete (globalThis as any).indexedDB;
      } else {
        Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: real });
      }
    }
  });

  it('prunes the in-memory fallback buffer by size too', async () => {
    const real = (globalThis as any).indexedDB;
    try {
      Object.defineProperty(globalThis, 'indexedDB', {
        configurable: true,
        value: undefined,
      });
      const svc = TestBed.inject(LlmLogService);
      await svc.clear();
      svc.setSizeLimit(1 * 1024 * 1024);
      const big = 'Y'.repeat(200 * 1024);
      for (let i = 0; i < 3; i++) {
        svc.record({
          kind: 'chat',
          modelId: `mem${i}`,
          provider: 'p',
          messages: [{ role: 'user', content: `${big}${i}` }],
          body: {
            model: `mem${i}`,
            messages: [{ role: 'user', content: `${big}${i}` }],
            stream: false,
          },
        });
      }
      await svc.flush();
      const entries = svc.entries();
      expect(entries.some(e => e.modelId === 'mem0')).toBe(false);
      const total = entries.reduce((s, e) => s + (e.size ?? 0), 0);
      expect(total).toBeLessThanOrEqual(1 * 1024 * 1024);
    } finally {
      if (real === undefined) {
        delete (globalThis as any).indexedDB;
      } else {
        Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: real });
      }
    }
  });
});