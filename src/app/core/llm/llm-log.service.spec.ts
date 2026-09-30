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
});