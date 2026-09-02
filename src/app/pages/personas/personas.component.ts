import {
  Component,
  inject,
  signal,
  OnInit,
  computed,
  ViewChild,
  ElementRef,
  HostListener
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ChatService } from '../../core/chat.service';
import { ConfirmService } from '../../core/confirm.service';
import { Persona } from '../../models/chat';
import { AvatarPickerComponent } from '../../components/avatar-picker/avatar-picker.component';
import { AvatarViewComponent } from '../../components/avatar-view/avatar-view.component';

@Component({
  selector: 'app-personas',
  standalone: true,
  imports: [CommonModule, FormsModule, AvatarPickerComponent, AvatarViewComponent],
  templateUrl: './personas.component.html',
  styleUrl: './personas.component.css'
})
export class PersonasComponent implements OnInit {
  private readonly chatService = inject(ChatService);
  private readonly router = inject(Router);
  private readonly confirm = inject(ConfirmService);

  readonly personas = this.chatService.personas;

  readonly searchTerm = signal('');
  readonly showForm = signal(false);
  readonly editingId = signal<string | null>(null);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly openMenuId = signal<string | null>(null);

  /** Modal width in CSS pixels, already clamped to ≤ 90vw. */
  readonly editorWidthPx = signal(520);

  @ViewChild('descEditor') private descEditor?: ElementRef<HTMLTextAreaElement>;
  @ViewChild('personaModal') private personaModal?: ElementRef<HTMLElement>;

  // Form model
  form = {
    name: '',
    shortName: '',
    description: '',
    avatar: ''
  };

  /** Snapshot taken when the editor opens; used to detect unsaved edits. */
  private baseline: {
    name: string;
    shortName: string;
    description: string;
    avatar: string;
  } | null = null;

  private closeInFlight = false;

  readonly filteredPersonas = computed(() => {
    const term = this.searchTerm().toLowerCase().trim();
    const list = this.personas();
    if (!term) return list;
    return list.filter(
      p =>
        p.name.toLowerCase().includes(term) ||
        p.shortName.toLowerCase().includes(term) ||
        (p.description || '').toLowerCase().includes(term)
    );
  });

  async ngOnInit() {
    try {
      await this.chatService.loadPersonas();
    } catch (e) {
      console.error('Failed to load personas', e);
      this.error.set('Failed to load personas from server.');
    }
  }

  goToChat() {
    this.router.navigate(['/chat']);
  }

  openCreate() {
    this.editingId.set(null);
    this.form = {
      name: '',
      shortName: '',
      description: '',
      avatar: ''
    };
    this.error.set(null);
    this.captureBaseline();
    this.showForm.set(true);
    this.scheduleFitEditor();
  }

  openEdit(persona: Persona) {
    this.closeMenu();
    this.editingId.set(persona.id);
    this.form = {
      name: persona.name,
      shortName: persona.shortName,
      description: persona.description || '',
      avatar: persona.avatar || ''
    };
    this.error.set(null);
    this.captureBaseline();
    this.showForm.set(true);
    this.scheduleFitEditor();
  }

  /**
   * Close the editor. If the form is unchanged, close immediately.
   * If anything was edited, ask before discarding.
   */
  async requestClose(): Promise<void> {
    if (!this.showForm() || this.closeInFlight) return;

    if (this.isDirty()) {
      this.closeInFlight = true;
      const discard = await this.confirm.ask({
        title: 'Unsaved changes',
        message: 'This persona has edits that are not saved yet.\nDiscard them?',
        confirmLabel: 'Discard',
        cancelLabel: 'Keep editing',
        danger: true
      });
      this.closeInFlight = false;
      if (!discard) return;
    }

    this.closeForm();
  }

  closeForm() {
    this.showForm.set(false);
    this.editingId.set(null);
    this.error.set(null);
    this.baseline = null;
    this.editorWidthPx.set(Math.min(520, Math.floor(window.innerWidth * 0.9)));
  }

  async save() {
    const name = this.form.name.trim();
    const shortName = this.form.shortName.trim();

    if (!name) {
      this.error.set('Name is required');
      return;
    }
    if (!shortName) {
      this.error.set('Short name is required');
      return;
    }

    this.saving.set(true);
    this.error.set(null);

    try {
      if (this.editingId()) {
        await this.chatService.updatePersona(this.editingId()!, {
          name,
          shortName,
          description: this.form.description,
          avatar: this.form.avatar
        });
      } else {
        await this.chatService.createPersona({
          name,
          shortName,
          description: this.form.description,
          avatar: this.form.avatar
        });
      }
      this.closeForm();
    } catch (e: any) {
      console.error(e);
      this.error.set(e?.error?.error || e?.message || 'Save failed');
    } finally {
      this.saving.set(false);
    }
  }

  async deletePersona(persona: Persona) {
    if (!confirm(`Delete persona "${persona.name}"? This cannot be undone.`)) {
      return;
    }
    try {
      await this.chatService.deletePersona(persona.id);
    } catch (e) {
      console.error(e);
      alert('Failed to delete persona');
    }
  }

  onAvatarSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      this.error.set('Please select an image file');
      return;
    }

    // Limit size roughly (data URLs get large)
    if (file.size > 800_000) {
      this.error.set('Image is too large (max ~800 KB). Please choose a smaller one.');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      this.form.avatar = reader.result as string;
      this.error.set(null);
    };
    reader.onerror = () => {
      this.error.set('Failed to read image');
    };
    reader.readAsDataURL(file);
  }

  clearAvatar() {
    this.form.avatar = '';
  }

  toggleMenu(id: string, event: Event) {
    event.stopPropagation();
    this.openMenuId.update(current => (current === id ? null : id));
  }

  closeMenu() {
    this.openMenuId.set(null);
  }

  trackById(_: number, p: Persona) {
    return p.id;
  }

  isCurrent(persona: Persona): boolean {
    return this.chatService.currentPersonaId() === persona.id;
  }

  setAsCurrent(persona: Persona): void {
    this.chatService.setCurrentPersona(persona.id);
    this.closeMenu();
  }

  clearCurrent(): void {
    this.chatService.setCurrentPersona(null);
  }

  onDescriptionChange(): void {
    this.fitEditorToDescription();
  }

  @HostListener('window:resize')
  onWindowResize(): void {
    if (this.showForm()) {
      this.fitEditorToDescription();
    }
  }

  @HostListener('document:keydown', ['$event'])
  onDocumentKeydown(ev: KeyboardEvent): void {
    if (ev.key !== 'Escape') return;

    // Confirm dialog is already up — Escape means "keep editing".
    if (this.confirm.current()) {
      ev.preventDefault();
      this.confirm.close(false);
      return;
    }

    if (!this.showForm()) return;
    ev.preventDefault();
    void this.requestClose();
  }

  private captureBaseline(): void {
    this.baseline = {
      name: this.form.name,
      shortName: this.form.shortName,
      description: this.form.description,
      avatar: this.form.avatar
    };
  }

  private isDirty(): boolean {
    const b = this.baseline;
    if (!b) return false;
    return (
      this.form.name !== b.name ||
      this.form.shortName !== b.shortName ||
      this.form.description !== b.description ||
      this.form.avatar !== b.avatar
    );
  }

  /** Wait for the modal/textarea to exist in the DOM, then size them. */
  private scheduleFitEditor(retries = 0): void {
    requestAnimationFrame(() => {
      if (this.descEditor?.nativeElement && this.personaModal?.nativeElement) {
        this.fitEditorToDescription();
        return;
      }
      if (retries < 20 && this.showForm()) {
        this.scheduleFitEditor(retries + 1);
      }
    });
  }

  /**
   * Grow the modal and description textarea to the description text.
   * Width and the overall editor are capped at 90% of the viewport.
   */
  private fitEditorToDescription(): void {
    const ta = this.descEditor?.nativeElement;
    if (!ta || !this.showForm()) {
      return;
    }

    const maxWidth = Math.floor(window.innerWidth * 0.9);
    const maxHeight = Math.floor(window.innerHeight * 0.9);
    const minWidth = Math.min(520, maxWidth);
    const minTextareaHeight = 100;

    const text = this.form.description ?? '';
    const width = this.measureEditorWidth(text, ta, minWidth, maxWidth);
    this.editorWidthPx.set(width);

    // Let the new width apply, then measure wrapped height.
    requestAnimationFrame(() => {
      const textarea = this.descEditor?.nativeElement;
      const modal = this.personaModal?.nativeElement;
      if (!textarea || !modal) return;

      textarea.style.height = 'auto';
      const needed = Math.max(textarea.scrollHeight, minTextareaHeight);

      const chrome = modal.scrollHeight - textarea.offsetHeight;
      const availableForTextarea = Math.max(
        minTextareaHeight,
        maxHeight - chrome
      );

      const nextHeight = Math.min(needed, availableForTextarea);
      textarea.style.height = `${nextHeight}px`;
      textarea.style.overflowY = needed > availableForTextarea ? 'auto' : 'hidden';
    });
  }

  /**
   * Width tracks the longest description line (plus field padding),
   * but never exceeds 90vw and never shrinks below the compact default.
   */
  private measureEditorWidth(
    text: string,
    textarea: HTMLTextAreaElement,
    minWidth: number,
    maxWidth: number
  ): number {
    if (!text.trim()) return minWidth;

    const style = window.getComputedStyle(textarea);
    const font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return minWidth;
    ctx.font = font;

    let longest = 0;
    for (const line of text.split('\n')) {
      longest = Math.max(longest, ctx.measureText(line).width);
    }

    const horizontalChrome =
      this.parsePx(style.paddingLeft) +
      this.parsePx(style.paddingRight) +
      this.parsePx(style.borderLeftWidth) +
      this.parsePx(style.borderRightWidth);

    // Modal padding (1.5rem each side) sits outside the textarea.
    const modalPad = 48;
    const measured = Math.ceil(longest + horizontalChrome + modalPad + 8);

    return Math.max(minWidth, Math.min(maxWidth, measured));
  }

  private parsePx(value: string): number {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : 0;
  }
}
