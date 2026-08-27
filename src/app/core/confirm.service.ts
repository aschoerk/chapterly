import { Injectable, signal } from '@angular/core';

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
  readonly current = signal<ConfirmState | null>(null);

  ask(req: ConfirmRequest): Promise<boolean> {
    return new Promise(resolve => {
      this.current.set({
        title: req.title,
        message: req.message,
        confirmLabel: req.confirmLabel ?? 'Discard',
        cancelLabel: req.cancelLabel ?? 'Keep editing',
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
