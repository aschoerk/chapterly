import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { I18nService } from '../../core/i18n/i18n.service';
import { IllustrateDialogService } from '../../core/illustrate-dialog.service';
import { ILLUSTRATE_COUNT_MIN } from '../../models/illustrate-options';

@Component({
  selector: 'app-illustrate-dialog',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './illustrate-dialog.component.html',
  styleUrl: './illustrate-dialog.component.css'
})
export class IllustrateDialogComponent {
  readonly dialog = inject(IllustrateDialogService);
  readonly i18n = inject(I18nService);

  readonly count = signal(1);
  readonly style = signal('');
  readonly storyboardPrompt = signal('');
  readonly showStoryboard = computed(() => this.count() > 1);

  constructor() {
    effect(() => {
      const s = this.dialog.current();
      if (!s) return;
      // Seed the editor from the options the dialog was opened with.
      this.count.set(s.count);
      this.style.set(s.style);
      this.storyboardPrompt.set(s.storyboardPrompt);
    });
  }

  onCountInput(value: string): void {
    const n = Number(value);
    if (Number.isFinite(n) && n >= ILLUSTRATE_COUNT_MIN) {
      this.count.set(Math.floor(n));
    }
  }

  submit(): void {
    this.dialog.submit({
      count: this.count(),
      style: this.style(),
      storyboardPrompt: this.storyboardPrompt()
    });
  }

  onBackdrop(ev: MouseEvent): void {
    if (ev.target === ev.currentTarget) this.dialog.cancel();
  }

  onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') this.dialog.cancel();
  }
}