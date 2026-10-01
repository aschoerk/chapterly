import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { I18nService } from '../../core/i18n/i18n.service';
import { ConfirmService } from '../../core/confirm.service';
import { LlmLogService } from '../../core/llm/llm-log.service';
import { LlmLogsComponent } from './llm-logs.component';

describe('LlmLogsComponent', () => {
  let fixture: ComponentFixture<LlmLogsComponent>;
  let component: LlmLogsComponent;
  let logs: LlmLogService;
  let confirm: ConfirmService;

  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [LlmLogsComponent],
      providers: [provideZonelessChangeDetection(), provideHttpClient()]
    }).compileComponents();

    TestBed.inject(I18nService).setLocale('en');
    logs = TestBed.inject(LlmLogService);
    confirm = TestBed.inject(ConfirmService);
    await logs.clear();

    fixture = TestBed.createComponent(LlmLogsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('shows the empty state when nothing is logged', async () => {
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('LLM call log');
    expect(text).toContain('No LLM calls logged yet.');
  });

  it('lists recorded entries with model + kind badge', async () => {
    logs.record({
      kind: 'chat', modelId: 'openai/gpt-4o-mini', provider: 'https://p',
      messages: [{ role: 'user', content: 'Hello' }],
    });
    logs.record({
      kind: 'image', modelId: 'x-ai/grok-imagine', provider: 'https://p',
      prompt: 'A castle',
    });
    await logs.flush();
    await fixture.whenStable();
    fixture.detectChanges();

    const native = fixture.nativeElement as HTMLElement;
    const text = native.textContent ?? '';
    expect(text).toContain('openai/gpt-4o-mini');
    expect(text).toContain('x-ai/grok-imagine');
    // Kind badges use i18n labels text/image.
    expect(text).toContain('text');
    expect(text).toContain('image');
  });

  it('shows the chat title the call was made for', async () => {
    logs.record({
      kind: 'chat', modelId: 'm/1', provider: 'https://p',
      chatId: 'chat-1', chatTitle: 'The Great Tale',
      messages: [{ role: 'user', content: 'Hello' }],
    });
    await logs.flush();
    await fixture.whenStable();
    fixture.detectChanges();

    const native = fixture.nativeElement as HTMLElement;
    const text = native.textContent ?? '';
    expect(text).toContain('The Great Tale');
    // Rendered as a chat badge with a "Chat: …" tooltip.
    const badge = native.querySelector('.log-chat');
    expect(badge).not.toBeNull();
    expect(badge?.getAttribute('title')).toBe('Chat: The Great Tale');
  });

  it('expands an entry to show the full (unshortened) message content', async () => {
    const long = 'L'.repeat(3000);
    logs.record({
      kind: 'chat', modelId: 'm/1', provider: 'https://p',
      messages: [{ role: 'user', content: long }],
      body: {
        model: 'm/1',
        messages: [{ role: 'user', content: long }],
        temperature: 0.7,
        stream: false
      }
    });
    await logs.flush();
    await fixture.whenStable();
    fixture.detectChanges();

    const entry = logs.entries()[0];
    component.toggle(entry.seq);
    await fixture.whenStable();
    fixture.detectChanges();

    // The message list shows the full message content (never truncated).
    const native = fixture.nativeElement as HTMLElement;
    const msgPre = native.querySelector('.log-msg pre');
    expect(msgPre).not.toBeNull();
    expect((msgPre?.textContent ?? '')).toContain(long);
  });

  it('reveals the FULL request JSON body (all messages + the rest of the json)', async () => {
    const lastText = 'The final instruction, in full, '.repeat(40);
    logs.record({
      kind: 'chat', modelId: 'm/1', provider: 'https://p',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: lastText },
      ],
      body: {
        model: 'm/1',
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: lastText },
        ],
        temperature: 0.3,
        tools: [{ type: 'function', name: 'x' }],
        stream: false
      }
    });
    await logs.flush();
    await fixture.whenStable();
    fixture.detectChanges();

    const entry = logs.entries()[0];
    component.toggle(entry.seq);
    await fixture.whenStable();
    fixture.detectChanges();

    // Before showing, no `<pre>` with the raw body is rendered.
    const native = fixture.nativeElement as HTMLElement;
    component.toggleBodyJson(entry.seq);
    await fixture.whenStable();
    fixture.detectChanges();

    const bodyText = native.textContent ?? '';
    expect(bodyText).toContain('temperature');
    expect(bodyText).toContain('tools');
    // The FULL last message (the whole instruction) is present in the JSON.
    expect(bodyText).toContain(lastText);
  });

  it('clear() removes all entries after confirmation', async () => {
    logs.record({ kind: 'chat', modelId: 'm', provider: 'p', messages: [{ role: 'user', content: 'x' }] });
    await logs.flush();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(logs.entries().length).toBe(1);

    vi.spyOn(confirm, 'ask').mockResolvedValue(true);
    await component.clear();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(logs.entries().length).toBe(0);
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('No LLM calls logged yet.');
  });

  it('formatSize renders B / KB / MB labels', () => {
    expect(component.formatSize(0)).toBe('0 B');
    expect(component.formatSize(512)).toBe('512 B');
    expect(component.formatSize(2048)).toBe('2.0 KB');
    expect(component.formatSize(3 * 1024 * 1024)).toBe('3.00 MB');
    expect(component.formatSize(undefined)).toBe('');
  });

  it('shows the stored size badge in the entry header', async () => {
    logs.record({
      kind: 'chat', modelId: 'm/1', provider: 'https://p',
      messages: [{ role: 'user', content: 'Hello' }],
      body: { model: 'm/1', messages: [{ role: 'user', content: 'Hello' }], stream: false },
    });
    await logs.flush();
    await fixture.whenStable();
    fixture.detectChanges();

    const entry = logs.entries()[0];
    expect(entry.size).toBeGreaterThan(0);

    const native = fixture.nativeElement as HTMLElement;
    const size = native.querySelector('.log-size');
    expect(size).not.toBeNull();
    expect(size?.textContent?.trim()).toContain('B');
  });

  it('the size grows after the response is attached (complete)', async () => {
    const entry = logs.record({
      kind: 'chat', modelId: 'm/1', provider: 'https://p',
      messages: [{ role: 'user', content: 'hi' }],
      body: { model: 'm/1', messages: [{ role: 'user', content: 'hi' }], stream: false },
    });
    await logs.flush();
    const before = entry.size ?? 0;

    logs.complete(entry, {
      response: { choices: [{ message: { content: 'answer…'.repeat(50) } }] },
    });
    await logs.flush();

    expect(entry.size ?? 0).toBeGreaterThan(before);
    fixture.detectChanges();
  });

  it('copies the request-body JSON to the clipboard (fallback path)', async () => {
    // jsdom has no async Clipboard API → the hidden-textarea fallback runs.
    Object.defineProperty(window.navigator, 'clipboard', { value: undefined, configurable: true });
    const body = {
      model: 'm/1',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.3,
      stream: false,
    };
    const expected = JSON.stringify(body, null, 2);
    logs.record({
      kind: 'chat', modelId: 'm/1', provider: 'https://p',
      messages: [{ role: 'user', content: 'hello' }],
      body,
    });
    await logs.flush();
    await fixture.whenStable();

    const entry = logs.entries()[0];
    const exec = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    let copiedText = '';
    const originalAppend = document.body.appendChild.bind(document.body);
    vi.spyOn(document.body, 'appendChild').mockImplementation((node: Node) => {
      if (node instanceof HTMLTextAreaElement) copiedText = node.value;
      return originalAppend(node);
    });

    component.copyRequestBody(entry);

    expect(copiedText).toBe(expected);
    expect(exec).toHaveBeenCalledWith('copy');
    // The temporary textarea is cleaned up afterwards.
    expect(document.body.querySelector('textarea')).toBeNull();
    // “Copied” feedback flashed on the exact button.
    expect(component.isCopied(entry.seq, 'body')).toBe(true);
    expect(component.isCopied(entry.seq, 'response')).toBe(false);
    component.ngOnDestroy();
  });

  it('copies the response body via the async Clipboard API', async () => {
    const response = { choices: [{ message: { content: 'The answer is 42.' } }] };
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });

    const entry = logs.record({
      kind: 'chat', modelId: 'm/1', provider: 'https://p',
      messages: [{ role: 'user', content: 'hi' }],
      body: { model: 'm/1', messages: [{ role: 'user', content: 'hi' }], stream: false },
    });
    logs.complete(entry, { response });
    await logs.flush();
    await fixture.whenStable();

    component.copyResponse(entry);
    await fixture.whenStable();

    expect(writeText).toHaveBeenCalledWith(JSON.stringify(response, null, 2));
    expect(component.isCopied(entry.seq, 'response')).toBe(true);
    component.ngOnDestroy();
  });

  it('shows the total stored size and the default 50 MB limit', async () => {
    logs.record({
      kind: 'chat', modelId: 'm/1', provider: 'https://p',
      messages: [{ role: 'user', content: 'Hello' }],
      body: { model: 'm/1', messages: [{ role: 'user', content: 'Hello' }], stream: false },
    });
    await logs.flush();
    await fixture.whenStable();
    fixture.detectChanges();

    const native = fixture.nativeElement as HTMLElement;
    const usage = native.querySelector('.log-size-usage');
    expect(usage).not.toBeNull();
    expect(usage?.textContent ?? '').toContain('B'); // total in bytes
    expect(usage?.textContent ?? '').toContain('50.00 MB'); // default limit
  });

  it('applies a new size limit from the input field', async () => {
    const input = fixture.nativeElement.querySelector('.log-size-limit input') as HTMLInputElement;
    expect(input).not.toBeNull();
    input.value = '12';
    input.dispatchEvent(new Event('change'));
    await fixture.whenStable();

    expect(logs.sizeLimit()).toBe(12 * 1024 * 1024);
    // The input refletcs the applied (clamped) value.
    expect(component.sizeLimitMb()).toBe(12);
  });

  it('ignores an invalid/empty size limit input', async () => {
    const input = fixture.nativeElement.querySelector('.log-size-limit input') as HTMLInputElement;
    input.value = '';
    input.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(logs.sizeLimit()).toBe(50 * 1024 * 1024);
  });
});