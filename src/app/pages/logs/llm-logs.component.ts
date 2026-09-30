import { Component, inject, signal } from '@angular/core';
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
export class LlmLogsComponent {
  private readonly logs = inject(LlmLogService);
  private readonly confirm = inject(ConfirmService);
  readonly i18n = inject(I18nService);

  readonly entries = this.logs.entries;
  readonly persisted = this.logs.persisted;
  readonly limit = LLM_LOG_LIMIT;

  /** Expanded entry seq (single expanded row). */
  readonly expandedSeq = signal<number | null>(null);
  /** Entry seq whose FULL raw request JSON is shown. */
  readonly showBodyJson = signal<number | null>(null);
  /** Entry seq whose FULL response JSON is shown. */
  readonly showResponse = signal<number | null>(null);

  constructor() {
    // Re-load on navigation into the page (in case new calls were logged).
    this.logs.refresh().catch(() => { /* non-fatal */ });
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