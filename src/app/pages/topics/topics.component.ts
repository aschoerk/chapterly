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
import { ProjectService } from '../../core/project.service';
import { PersonaService } from '../../core/persona.service';
import { ConfirmService } from '../../core/confirm.service';
import { Topic } from '../../models/chat';
import { AvatarPickerComponent } from '../../components/avatar-picker/avatar-picker.component';
import { AvatarViewComponent } from '../../components/avatar-view/avatar-view.component';
import { I18nService } from '../../core/i18n/i18n.service';
import { TopicSelectionService } from '../../core/topic-selection.service';

@Component({
  selector: 'app-topics',
  standalone: true,
  imports: [CommonModule, FormsModule, AvatarPickerComponent, AvatarViewComponent],
  templateUrl: './topics.component.html',
  styleUrl: './topics.component.css'
})
export class TopicsComponent implements OnInit {
  private readonly projectService = inject(ProjectService);
  private readonly personaService = inject(PersonaService);
  private readonly confirm = inject(ConfirmService);
  readonly i18n = inject(I18nService);
  private readonly topicSelection = inject(TopicSelectionService);

  readonly topics = this.projectService.topics;
  readonly projects = this.projectService.projects;
  readonly personas = this.personaService.personas;

  readonly searchTerm = signal('');
  readonly showForm = signal(false);
  readonly editingId = signal<string | null>(null);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly openMenuId = signal<string | null>(null);
  /** The currently defined "current topic" (shared with sidebar + projects). */
  readonly selectedTopicId = this.topicSelection.selectedTopicId;

  /** Modal width in CSS pixels, already clamped to ≤ 90vw. */
  readonly editorWidthPx = signal(520);

  @ViewChild('descEditor') private descEditor?: ElementRef<HTMLTextAreaElement>;
  @ViewChild('topicModal') private topicModal?: ElementRef<HTMLElement>;

  // Form model
  form = {
    name: '',
    description: '',
    icon: '',
    defaultSystemPrompt: ''
  };

  /** Snapshot taken when the editor opens; used to detect unsaved edits. */
  private baseline: {
    name: string;
    description: string;
    icon: string;
    defaultSystemPrompt: string;
  } | null = null;

  private closeInFlight = false;

  readonly filteredTopics = computed(() => {
    const term = this.searchTerm().toLowerCase().trim();
    let list = this.topics();
    if (term) {
      list = list.filter(
        t =>
          t.name.toLowerCase().includes(term) ||
          (t.description || '').toLowerCase().includes(term) ||
          (t.defaultSystemPrompt || '').toLowerCase().includes(term)
      );
    }
    return this.applyTopicSort(list);
  });

  // ------------------------------------------------------------
  // Topic list sorting
  // ------------------------------------------------------------
  readonly sortMode = signal<'alpha' | 'updated'>('alpha');
  /** true: A→Z, false: Z→A */
  readonly alphaAsc = signal(true);
  /** true: most recent first, false: oldest first */
  readonly updatedDesc = signal(true);

  toggleSort(mode: 'alpha' | 'updated'): void {
    if (this.sortMode() === mode) {
      if (mode === 'alpha') this.alphaAsc.update(v => !v);
      else this.updatedDesc.update(v => !v);
    } else {
      this.sortMode.set(mode);
      // First click always starts with the primary direction.
      if (mode === 'alpha') this.alphaAsc.set(true);
      else this.updatedDesc.set(true);
    }
  }

  alphaLabel(): string {
    return this.sortMode() === 'alpha' && !this.alphaAsc() ? 'Z–A' : 'A–Z';
  }

  alphaSortTitleKey(): string {
    if (this.sortMode() !== 'alpha') return 'sort.alpha';
    return this.alphaAsc() ? 'sort.alphaAZ' : 'sort.alphaZA';
  }

  updatedSortTitleKey(): string {
    if (this.sortMode() !== 'updated') return 'sort.updated';
    return this.updatedDesc() ? 'sort.updatedNew' : 'sort.updatedOld';
  }

  private topicTime(t: Topic): number {
    return new Date(t.updatedAt || t.createdAt).getTime() || 0;
  }

  /** Sort by the active mode, then always keep the current topic first. */
  private applyTopicSort(list: Topic[]): Topic[] {
    list = [...list];
    if (this.sortMode() === 'alpha') {
      list.sort((a, b) => {
        const cmp = a.name.localeCompare(b.name, this.i18n.localeId());
        return this.alphaAsc() ? cmp : -cmp;
      });
    } else {
      list.sort((a, b) => this.topicTime(b) - this.topicTime(a));
      if (!this.updatedDesc()) list.reverse();
    }

    // The current topic always stays first.
    const currentId = this.selectedTopicId();
    if (currentId && currentId !== 'all' && currentId !== 'unassigned') {
      const current = list.find(t => t.id === currentId);
      if (current) {
        return [current, ...list.filter(t => t.id !== currentId)];
      }
    }
    return list;
  }

  /** The topic currently selected as "current topic", or null if "all". */
  readonly currentTopic = computed<Topic | null>(() => {
    const id = this.selectedTopicId();
    if (!id || id === 'all' || id === 'unassigned') return null;
    return this.topics().find(t => t.id === id) || null;
  });

  async ngOnInit() {
    try {
      await Promise.all([
        this.projectService.loadTopics(),
        this.projectService.loadProjects(),
        this.personaService.loadPersonas()
      ]);
    } catch (e) {
      console.error('Failed to load topics', e);
      this.error.set(this.i18n.t('topics.loadFailed'));
    }
  }

  projectCount(topic: Topic): number {
    return (topic.projectIds || []).length;
  }

  isCurrentTopic(topic: Topic): boolean {
    return this.selectedTopicId() === topic.id;
  }

  /** Define this topic as the current topic (syncs sidebar + projects). */
  setCurrentTopic(topic: Topic) {
    this.closeMenu();
    this.topicSelection.selectTopic(topic.id);
  }

  /** Reset the current topic back to "all". */
  clearCurrentTopic() {
    this.topicSelection.clear();
  }

  personaCount(topic: Topic): number {
    return this.personas().filter(p => p.mainTopicId === topic.id).length;
  }

  openCreate() {
    this.editingId.set(null);
    this.form = {
      name: '',
      description: '',
      icon: '',
      defaultSystemPrompt: ''
    };
    this.error.set(null);
    this.captureBaseline();
    this.showForm.set(true);
    this.scheduleFitEditor();
  }

  openEdit(topic: Topic) {
    this.closeMenu();
    this.editingId.set(topic.id);
    this.form = {
      name: topic.name,
      description: topic.description || '',
      icon: topic.icon || '',
      defaultSystemPrompt: topic.defaultSystemPrompt || ''
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
        title: this.i18n.t('personas.unsavedTitle'),
        message: this.i18n.t('topics.unsavedMsg'),
        confirmLabel: this.i18n.t('common.discard'),
        cancelLabel: this.i18n.t('common.keepEditing'),
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

    if (!name) {
      this.error.set(this.i18n.t('common.nameRequired'));
      return;
    }

    this.saving.set(true);
    this.error.set(null);

    try {
      if (this.editingId()) {
        await this.projectService.updateTopic(this.editingId()!, {
          name,
          description: this.form.description,
          icon: this.form.icon,
          defaultSystemPrompt: this.form.defaultSystemPrompt
        });
      } else {
        await this.projectService.createTopic({
          name,
          description: this.form.description,
          icon: this.form.icon,
          defaultSystemPrompt: this.form.defaultSystemPrompt
        });
      }
      this.closeForm();
    } catch (e: any) {
      console.error(e);
      this.error.set(e?.error?.error || e?.message || this.i18n.t('common.saveFailed'));
    } finally {
      this.saving.set(false);
    }
  }

  async deleteTopic(topic: Topic) {
    const count = this.projectCount(topic);
    const message = count === 0
      ? this.i18n.t('projects.deleteTopicEmpty', { name: topic.name })
      : this.i18n.t('projects.deleteTopicWithEnv', { name: topic.name, count });
    const ok = await this.confirm.ask({
      title: this.i18n.t('projects.deleteTopicAsk'),
      message,
      confirmLabel: this.i18n.t('common.delete'),
      cancelLabel: this.i18n.t('common.cancel'),
      danger: true
    });
    if (!ok) return;
    try {
      await this.projectService.deleteTopic(topic.id);
      if (this.selectedTopicId() === topic.id) {
        this.topicSelection.clear();
      }
    } catch (e: any) {
      console.error(e);
      alert(this.i18n.t('projects.deleteTopicFailed', { error: e?.error?.error || e?.message || '' }));
    }
  }

  toggleMenu(id: string, event: Event) {
    event.stopPropagation();
    this.openMenuId.update(current => (current === id ? null : id));
  }

  closeMenu() {
    this.openMenuId.set(null);
  }

  trackById(_: number, t: Topic) {
    return t.id;
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
      description: this.form.description,
      icon: this.form.icon,
      defaultSystemPrompt: this.form.defaultSystemPrompt
    };
  }

  private isDirty(): boolean {
    const b = this.baseline;
    if (!b) return false;
    return (
      this.form.name !== b.name ||
      this.form.description !== b.description ||
      this.form.icon !== b.icon ||
      this.form.defaultSystemPrompt !== b.defaultSystemPrompt
    );
  }

  /** Wait for the modal/textarea to exist in the DOM, then size them. */
  private scheduleFitEditor(retries = 0): void {
    requestAnimationFrame(() => {
      if (this.descEditor?.nativeElement && this.topicModal?.nativeElement) {
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

    requestAnimationFrame(() => {
      const textarea = this.descEditor?.nativeElement;
      const modal = this.topicModal?.nativeElement;
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

    const modalPad = 48;
    const measured = Math.ceil(longest + horizontalChrome + modalPad + 8);

    return Math.max(minWidth, Math.min(maxWidth, measured));
  }

  private parsePx(value: string): number {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : 0;
  }
}
