import { Component, inject, signal, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { I18nService } from '../../core/i18n/i18n.service';
import { ConfirmService } from '../../core/confirm.service';
import { LlmLogService, LlmLogEntry, LlmLogMessage, LLM_LOG_LIMIT } from '../../core/llm/llm-log.service';

@Component({
  selector: 'app-logs',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './llm-logs.component.html',
  styleUrls: ['../config/config-shared.css', './llm-logs.component.css']
})
export class LlmLogsComponent implements OnDestroy {
  private readonly logs = inject(LlmLogService);
  private readonly confirm = inject(ConfirmService);
  readonly i18n = inject(I18nService);

  readonly entries = this.logs.entries;
  readonly persisted = this.logs.persisted;
  readonly sizeLimit = this.logs.sizeLimit;
  readonly limit = LLM_LOG_LIMIT;

  /** Expanded entry seq (single expanded row). */
  readonly expandedSeq = signal<number | null>(null);
  /** Entry seq whose FULL raw request JSON is shown. */
  readonly showBodyJson = signal<number | null>(null);
  /** Entry seq whose FULL response JSON is shown. */
  readonly showResponse = signal<number | null>(null);
  /** Copy feedback: which copy button was pressed (flashes "Copied"). */
  readonly copied = signal<{ seq: number; which: 'body' | 'response' } | null>(null);
  private copiedTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Re-load on navigation into the page (in case new calls were logged).
    this.logs.refresh().catch(() => { /* non-fatal */ });
  }

  ngOnDestroy(): void {
    if (this.copiedTimer) {
      clearTimeout(this.copiedTimer);
      this.copiedTimer = null;
    }
  }

  toggle(seq: number): void {
    this.expandedSeq.set(this.expandedSeq() === seq ? null : seq);
    if (this.expandedSeq() !== seq) {
      this.showBodyJson.set(null);
      this.showResponse.set(null);
    }
  }

  isExpanded(seq: number): boolean {
    return this.expandedSeq() === seq;
  }

  toggleBodyJson(seq: number): void {
    this.showBodyJson.set(this.showBodyJson() === seq ? null : seq);
  }

  isBodyJsonOpen(seq: number): boolean {
    return this.showBodyJson() === seq;
  }

  toggleResponse(seq: number): void {
    this.showResponse.set(this.showResponse() === seq ? null : seq);
  }

  isResponseOpen(seq: number): boolean {
    return this.showResponse() === seq;
  }

  /** All messages of a chat entry (the full array — never truncated). */
  messagesOf(e: LlmLogEntry): LlmLogMessage[] {
    return e.kind === 'chat' ? (e.messages ?? []) : [];
  }

  formatTimestamp(iso: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  }

  /** Full content formatting for a single message (never truncated). */
  formatMessageContent(m: LlmLogMessage): string {
    const content = m?.content;
    if (typeof content === 'string') return content;
    if (content == null) return '';
    return JSON.stringify(content, null, 2);
  }

  /** The COMPLETE request payload as it was sent (full JSON, verbatim). */
  formatBodyJson(body: Record<string, unknown> | undefined): string {
    if (!body) return '';
    // `messages` is fully retained; everything else (temperature, stream,
    // extras, modalities, n…) stays in the same object — the whole JSON.
    return JSON.stringify(body, null, 2);
  }

  /** The COMPLETE response JSON the provider returned (full, verbatim). */
  formatResponse(response: unknown): string {
    if (response == null) return '';
    if (typeof response === 'string') return response;
    return JSON.stringify(response, null, 2);
  }

  /** True when a completed response or error exists for an entry. */
  hasResponse(e: LlmLogEntry): boolean {
    return !!e.completed && (e.response != null || !!e.error);
  }

  /**
   * Human-readable size label for a stored entry (e.g. "1.2 KB"). Tolerates
   * entries recorded before the size field existed (`undefined` -> '').
   */
  formatSize(bytes: number | undefined): string {
    if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    return `${(kb / 1024).toFixed(2)} MB`;
  }

  /** Total byte size of the currently held entries (display). */
  totalBytes(): number {
    return this.entries().reduce(
      (sum, e) => sum + ((typeof e.size === 'number' && e.size > 0) ? e.size : 0),
      0
    );
  }

  /** Current size limit in whole MiB (for the input field). */
  sizeLimitMb(): number {
    return Math.round(this.logs.sizeLimit() / (1024 * 1024));
  }

  /** Apply a new size limit (in MiB, clamped by the service) from the input. */
  onSizeLimitInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    const mb = Number(target?.value);
    if (!Number.isFinite(mb) || mb <= 0) return;
    void this.logs.setSizeLimit(mb * 1024 * 1024);
  }

  /** The exact request-body JSON text for an entry ('' when absent). */
  requestBodyText(e: LlmLogEntry): string {
    return this.formatBodyJson(e.body);
  }

  /** The exact response (or error) text for an entry ('' when absent). */
  responseText(e: LlmLogEntry): string {
    if (!e.completed) return '';
    if (e.error) return e.error.text ?? '';
    return this.formatResponse(e.response);
  }

  /** Copy the request-body JSON into the clipboard (with "Copied" feedback). */
  copyRequestBody(e: LlmLogEntry): void {
    this.copyToClipboard(this.requestBodyText(e), e.seq, 'body');
  }

  /** Copy the response/error text into the clipboard (with "Copied" feedback). */
  copyResponse(e: LlmLogEntry): void {
    this.copyToClipboard(this.responseText(e), e.seq, 'response');
  }

  /** True while the "Copied" flash is active for the given button. */
  isCopied(seq: number, which: 'body' | 'response'): boolean {
    const c = this.copied();
    return !!c && c.seq === seq && c.which === which;
  }

  /**
   * Copy `text` to the clipboard, preferring the async Clipboard API and
   * falling back to a hidden textarea + execCommand('copy') for non-secure
   * contexts / Electron. Flashes the button label for ~2s on success.
   */
  private copyToClipboard(text: string, seq: number, which: 'body' | 'response'): void {
    if (!text) return;
    const flash = (): void => {
      this.copied.set({ seq, which });
      if (this.copiedTimer) clearTimeout(this.copiedTimer);
      this.copiedTimer = setTimeout(() => this.copied.set(null), 2000);
    };
    const fallback = (): void => {
      this.fallbackCopy(text);
      flash();
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(flash).catch(fallback);
    } else {
      fallback();
    }
  }

  /** execCommand-based copy used when the async Clipboard API is unavailable. */
  private fallbackCopy(text: string): void {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch { /* ignore — copy buttons are best-effort */ }
  }

  async clear(): Promise<void> {
    const ok = await this.confirm.ask({
      title: this.i18n.t('logs.clearTitle'),
      message: this.i18n.t('logs.clearMsg'),
      confirmLabel: this.i18n.t('logs.clear'),
      cancelLabel: this.i18n.t('common.cancel'),
      danger: true
    });
    if (!ok) return;
    await this.logs.clear();
    this.expandedSeq.set(null);
    this.showBodyJson.set(null);
    this.showResponse.set(null);
  }
}