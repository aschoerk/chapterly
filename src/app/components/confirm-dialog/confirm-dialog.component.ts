import { Component, inject, HostListener } from '@angular/core';
import { ConfirmService } from '../../core/confirm.service';

@Component({
  selector: 'app-confirm-dialog',
  standalone: true,
  templateUrl: './confirm-dialog.component.html',
  styleUrl: './confirm-dialog.component.css'
})
export class ConfirmDialogComponent {
  readonly confirm = inject(ConfirmService);

  onBackdrop(ev: MouseEvent): void {
    if (ev.target === ev.currentTarget) this.confirm.close(false);
  }

  onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') this.confirm.close(false);
    if (ev.key === 'Enter') this.confirm.close(true);
  }

  /**
   * Escape cancels the dialog. Handled at document level so it works even
   * when focus is outside the dialog (the backdrop only catches keys once
   * an inner control has focus). Guarded by the open state, so it never
   * interferes while the dialog is closed.
   */
  @HostListener('document:keydown', ['$event'])
  onDocumentKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape' && this.confirm.current()) {
      ev.preventDefault();
      this.confirm.close(false);
    }
  }
}
