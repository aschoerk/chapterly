import { Component, inject } from '@angular/core';
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
}
