import { Component, effect, inject, signal, HostListener } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { I18nService } from '../../core/i18n/i18n.service';
import { PrependDialogService } from '../../core/prepend-dialog.service';

@Component({
  selector: 'app-prepend-dialog',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './prepend-dialog.component.html',
  styleUrl: './prepend-dialog.component.css'
})
export class PrependDialogComponent {
  readonly dialog = inject(PrependDialogService);
  readonly i18n = inject(I18nService);

  readonly text = signal('');

  constructor() {
    effect(() => {
      const s = this.dialog.current();
      if (!s) return;
      // Seed the editor from the proposed director text.
      this.text.set(s.text);
    });
  }

  submit(): void {
    this.dialog.submit(this.text());
  }

  onBackdrop(ev: MouseEvent): void {
    if (ev.target === ev.currentTarget) this.dialog.cancel();
  }

  onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') this.dialog.cancel();
  }

  /**
   * Escape cancels the dialog. Handled at document level so it works even
   * when focus is outside the dialog (the backdrop only catches keys once
   * an inner control has focus). Guarded by the open state, so it never
   * interferes while the dialog is closed.
   */
  @HostListener('document:keydown', ['$event'])
  onDocumentKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape' && this.dialog.current()) {
      ev.preventDefault();
      this.dialog.cancel();
    }
  }
}