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
});