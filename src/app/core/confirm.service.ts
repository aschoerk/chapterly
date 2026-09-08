import { Injectable, inject, signal } from '@angular/core';
import { I18nService } from './i18n/i18n.service';

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface ConfirmState extends ConfirmRequest {
  resolve: (value: boolean) => void;
}

@Injectable({ providedIn: 'root' })
export class ConfirmService {
  private readonly i18n = inject(I18nService);
  readonly current = signal<ConfirmState | null>(null);

  ask(req: ConfirmRequest): Promise<boolean> {
    return new Promise(resolve => {
      this.current.set({
        title: req.title,
        message: req.message,
        confirmLabel: req.confirmLabel ?? this.i18n.t('common.discard'),
        cancelLabel: req.cancelLabel ?? this.i18n.t('common.keepEditing'),
        danger: req.danger ?? true,
        resolve
      });
    });
  }

  close(result: boolean): void {
    const cur = this.current();
    if (!cur) return;
    this.current.set(null);
    cur.resolve(result);
  }
}
