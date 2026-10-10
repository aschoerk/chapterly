import {
  Component,
  ElementRef,
  HostListener,
  inject,
  viewChild,
  ViewEncapsulation,
  effect,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SearchReplaceService } from '../../core/search-replace/search-replace.service';
import { I18nService } from '../../core/i18n/i18n.service';

interface Focusable {
  focus(): void;
}

@Component({
  selector: 'app-search-replace',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './search-replace.component.html',
  styleUrl: './search-replace.component.css',
  encapsulation: ViewEncapsulation.None,
})
export class SearchReplaceComponent {
  readonly search = inject(SearchReplaceService);
  readonly i18n = inject(I18nService);

  private readonly termInput = viewChild<ElementRef<Focusable> & ElementRef<HTMLInputElement>>('termInput');

  constructor() {
    // Auto-focus the search field whenever the dialog opens.
    effect(() => {
      if (this.search.open()) {
        queueMicrotask(() => this.termInput()?.nativeElement?.focus());
      }
    });
  }

  /** Focus the search box when the dialog opens. */
  onOpen(): void {
    queueMicrotask(() => {
      this.termInput()?.nativeElement?.focus();
    });
  }

  isScopeActive(id: string): boolean {
    return this.search.scope() === id;
  }

  counter(): string {
    const total = this.search.total();
    if (total === 0) return this.i18n.t('search.noResults');
    const n = Math.min(Math.max(this.search.currentIndex(), 0), total - 1);
    return `${n + 1} / ${total}`;
  }

  findNextInput(event: Event): void {
    event.preventDefault();
    this.search.findNext();
  }

  findPrevInput(event: Event): void {
    event.preventDefault();
    this.search.findPrev();
  }

  async replaceCurrent(): Promise<void> {
    await this.search.replaceCurrent();
  }

  async replaceAndFindNext(): Promise<void> {
    await this.search.replaceAndFindNext();
  }

  async replaceAll(): Promise<void> {
    await this.search.replaceAll();
  }

  selectScope(id: string): void {
    this.search.setScope(id as never);
    this.search.navigateToCurrent();
  }

  /** Global keys: F3 next, Shift+F3 prev, Ctrl+F open, Escape close. */
  @HostListener('window:keydown', ['$event'])
  onWindowKey(event: KeyboardEvent): void {
    if (event.key === 'F3') {
      if (!this.search.open()) {
        this.search.openDialog();
        this.onOpen();
        return;
      }
      event.preventDefault();
      if (event.shiftKey) this.search.findPrev();
      else this.search.findNext();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && (event.key === 'f' || event.key === 'F')) {
      event.preventDefault();
      if (this.search.open()) {
        this.onOpen();
      } else {
        this.search.openDialog();
        this.onOpen();
      }
    }
  }

  /** Escape inside the dialog closes it (document so it works while focusing inputs). */
  @HostListener('document:keydown', ['$event'])
  onDocumentKey(event: KeyboardEvent): void {
    if (!this.search.open()) return;
    if (event.key !== 'Escape') return;
    // A node editor textarea owns Escape (cancel edit) — don't steal it.
    const active = document.activeElement as HTMLElement | null;
    if (active?.classList.contains('editor-textarea')) return;
    event.preventDefault();
    this.search.close();
  }
}