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
import { ActivatedRoute, Router } from '@angular/router';
import { ChatService } from '../../core/chat.service';
import { ProjectService} from '../../core/project.service';
import { ConfirmService } from '../../core/confirm.service';
import { SettingsService } from '../../core/settings.service';
import { Project, Persona, Topic } from '../../models/chat';
import { ChatParametersService } from '../../core/chat-parameters.service';
import { ChatParametersEditorComponent } from '../../components/chat-parameters-editor/chat-parameters-editor.component';
import { AvatarPickerComponent } from '../../components/avatar-picker/avatar-picker.component';
import { AvatarViewComponent } from '../../components/avatar-view/avatar-view.component';
import { isImageRef } from '../../core/image-ref';
import {
  ChatParametersDraft,
  ResolvedChatParameters,
  draftFromParameters,
  emptyParametersDraft
} from '../../models/chat-parameters';
import {PersonaService} from '../../core/persona.service';

@Component({
  selector: 'app-projects',
  standalone: true,
  imports: [CommonModule, FormsModule, ChatParametersEditorComponent, AvatarPickerComponent, AvatarViewComponent],
  templateUrl: './projects.component.html',
  styleUrl: './projects.component.css'
})
export class ProjectsComponent implements OnInit {
  private readonly chatService = inject(ChatService);
  private readonly projectService = inject(ProjectService);
  private readonly personaService = inject(PersonaService);
  private readonly settings = inject(SettingsService);
  private readonly parameters = inject(ChatParametersService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly confirm = inject(ConfirmService);

  /** Modal width in CSS pixels, already clamped to ≤ 90vw. */
  readonly editorWidthPx = signal(560);

  @ViewChild('greetingEditor') private greetingEditor?: ElementRef<HTMLTextAreaElement>;
  @ViewChild('systemPromptEditor') private systemPromptEditor?: ElementRef<HTMLTextAreaElement>;
  @ViewChild('projectModal') private projectModal?: ElementRef<HTMLElement>;

  private projectBaseline: {
    name: string;
    greeting: string;
    systemPrompt: string;
    defaultModelId: string | null;
    avatar: string;
    personaIds: string;
  } | null = null;

  private topicBaseline: {
    name: string;
    description: string;
    icon: string;
    defaultModelId: string | null;
    defaultSystemPrompt: string;
  } | null = null;

  private closeInFlight = false;

  readonly projects = this.projectService.projects;
  readonly personas = this.personaService.personas;
  readonly enabledModels = this.settings.enabledModels;
  readonly topics = this.projectService.topics;          // already loaded via ChatService
// ============================================================
// Topic form state
// ============================================================

  readonly showTopicForm = signal(false);
  readonly editingTopicId = signal<string | null>(null);
  readonly topicSaving = signal(false);
  readonly topicError = signal<string | null>(null);


  readonly searchTerm = signal('');
  readonly showForm = signal(false);
  readonly editingId = signal<string | null>(null);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly openMenuId = signal<string | null>(null);
  /** Currently selected filter in the left column */
  readonly selectedTopicId = signal<string | 'all' | 'unassigned'>('all');

  // form fields
  readonly topicName = signal('');
  readonly topicDescription = signal('');
  readonly topicIcon = signal('');
  readonly topicDefaultModelId = signal<string | null>(null);
  readonly topicDefaultSystemPrompt = signal('');
  readonly topicParamsOverride = signal(false);
  readonly topicParamsDraft = signal<ChatParametersDraft>(emptyParametersDraft());
  readonly topicParamsInherited = signal<ResolvedChatParameters | null>(null);
  private topicParamsId: string | null = null;

  form = {
    name: '',
    greeting: '',
    systemPrompt: '',
    defaultModelId: null as string | null,
    avatar: '',
    personaIds: [] as string[],
    chatParametersId: null as string | null
  };
  readonly projectParamsOverride = signal(false);
  readonly projectParamsDraft = signal<ChatParametersDraft>(emptyParametersDraft());
  readonly projectParamsInherited = signal<ResolvedChatParameters | null>(null);

  readonly filteredProjects = computed(() => {
    const term = this.searchTerm().toLowerCase().trim();
    const list = this.projects();
    if (!term) return list;
    return list.filter(
      p =>
        p.name.toLowerCase().includes(term) ||
        (p.systemPrompt || '').toLowerCase().includes(term)
    );
  });

  async ngOnInit() {
    try {
      await Promise.all([
        this.projectService.loadProjects(),
        this.personaService.loadPersonas(),
        this.projectService.loadTopics(),
        this.settings.loadAll()
      ]);
    } catch (e) {
      console.error('Failed to load projects', e);
      this.error.set('Failed to load books from server.');
    }
    this.openFromQuery();
  }

  private openFromQuery() {
    const params = this.route.snapshot.queryParamMap;
    const projectId = params.get('editProject');
    const topicId = params.get('editTopic');
    if (projectId) {
      const project = this.projects().find(p => p.id === projectId);
      if (project) this.openEdit(project);
    } else if (topicId) {
      const topic = this.topics().find(t => t.id === topicId);
      if (topic) {
        this.selectedTopicId.set(topic.id);
        this.openEditTopic(topic);
      }
    }
    if (projectId || topicId) {
      void this.router.navigate([], { relativeTo: this.route, queryParams: {}, replaceUrl: true });
    }
  }

  goToChat() {
    this.router.navigate(['/chat']);
  }

  modelLabel(id: string | null | undefined): string {
    if (!id) return 'No default model';
    const m = this.enabledModels().find(x => x.id === id);
    return m?.displayName || id;
  }

  personasFor(project: Project): Persona[] {
    const ids = project.personaIds || [];
    if (!ids.length) return [];
    const map = new Map(this.personas().map(p => [p.id, p]));
    return ids.map(id => map.get(id)).filter((p): p is Persona => !!p);
  }

  isPersonaSelected(id: string): boolean {
    return this.form.personaIds.includes(id);
  }

  togglePersona(id: string) {
    if (this.form.personaIds.includes(id)) {
      this.form.personaIds = this.form.personaIds.filter(x => x !== id);
    } else {
      this.form.personaIds = [...this.form.personaIds, id];
    }
  }

  sortedFormPersonas(): Persona[] {
    const selected = new Set(this.form.personaIds);
    return [...this.personas()].sort((a, b) => {
      const aOn = selected.has(a.id) ? 0 : 1;
      const bOn = selected.has(b.id) ? 0 : 1;
      if (aOn !== bOn) return aOn - bOn;
      return a.name.localeCompare(b.name);
    });
  }


  openCreate() {
    this.editingId.set(null);
    this.form = {
      name: '',
      greeting: '',
      systemPrompt: '',
      defaultModelId: null,
      avatar: '',
      personaIds: [],
      chatParametersId: null
    };
    this.projectParamsOverride.set(false);
    this.projectParamsDraft.set(emptyParametersDraft());
    this.refreshProjectInherited(null);
    this.error.set(null);
    this.captureProjectBaseline();
    this.showForm.set(true);
    this.scheduleFitEditor();
  }

  openEdit(project: Project) {
    this.closeMenu();
    this.editingId.set(project.id);
    this.form = {
      name: project.name,
      greeting: project.greeting || '',
      systemPrompt: project.systemPrompt || '',
      defaultModelId: project.defaultModelId,
      avatar: project.avatar || '',
      personaIds: [...(project.personaIds || [])],
      chatParametersId: project.chatParametersId || null
    };
    void this.loadProjectParams(project);
    this.error.set(null);
    this.captureProjectBaseline();
    this.showForm.set(true);
    this.scheduleFitEditor();
  }

  async requestClose(): Promise<void> {
    if (!this.showForm() || this.closeInFlight) return;

    if (this.isProjectDirty()) {
      this.closeInFlight = true;
      const discard = await this.confirm.ask({
        title: 'Unsaved changes',
        message: 'This environment has edits that are not saved yet.\nDiscard them?',
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
    this.projectBaseline = null;
    this.editorWidthPx.set(Math.min(560, Math.floor(window.innerWidth * 0.9)));
  }

  async save() {
    const name = this.form.name.trim();
    if (!name) {
      this.error.set('Name is required');
      return;
    }

    this.saving.set(true);
    this.error.set(null);

    try {
      const payload = {
        name,
        greeting: this.form.greeting,
        systemPrompt: this.form.systemPrompt,
        defaultModelId: this.form.defaultModelId,
        avatar: this.form.avatar,
        personaIds: this.form.personaIds,
        chatParametersId: await this.parameters.persistDraft(
          this.form.chatParametersId,
          this.projectParamsOverride(),
          this.projectParamsDraft()
        )
      };

      if (this.editingId()) {
        await this.projectService.updateProject(this.editingId()!, payload);
      } else {
        const created = await this.projectService.createProject(payload);
        // if a concrete topic is selected, attach the project to it
        const topicId = this.selectedTopicId();
        if (topicId && topicId !== 'all' && topicId !== 'unassigned') {
          await this.projectService.addProjectToTopic(topicId, created.id);
        }
      }
      this.closeForm();
    } catch (e: any) {
      console.error(e);
      this.error.set(e?.error?.error || e?.message || 'Save failed');
    } finally {
      this.saving.set(false);
    }
  }

  async deleteProject(project: Project) {

    const chatsForProject = this.chatService.chatsByProject().get(project.id);
    const chatCount = chatsForProject ? chatsForProject.length : 0;
    const message = chatCount === 0
      ? `Delete environment “${project.name}”?`
      : `Environment “${project.name}” contains ${chatCount} stor${chatCount === 1 ? 'y' : 'ies'}.\n\n` +
      `Delete will remove the environment AND all of its stories.`;
    const ok = await this.confirm.ask({
      title: 'Delete environment',
      message,
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      danger: true
    });
    if (!ok)
      return;
    try {
      await this.projectService.deleteProject(project.id);
    } catch (e) {
      console.error(e);
      alert('Failed to delete environment');
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

  trackById(_: number, p: Project) {
    return p.id;
  }

  /** Returns true when the icon is an image (data-URL or http) */
  isImageIcon(icon: string | null | undefined): boolean {
    return isImageRef(icon);
  }

  /** Topics sorted alphabetically */
  readonly sortedTopics = computed(() =>
    [...this.topics()].sort((a, b) => a.name.localeCompare(b.name))
  );


  /** Projects visible on the right side according to the current filter */
  readonly visibleProjects = computed(() => {
    const all = this.projects();
    const sel = this.selectedTopicId();

    if (sel === 'all') return all;

    if (sel === 'unassigned') {
      // projects that appear in zero topics
      const assignedIds = new Set(
        this.topics().flatMap(t => t.projectIds)
      );
      return all.filter(p => !assignedIds.has(p.id));
    }

    // concrete topic
    const topic = this.topics().find(t => t.id === sel);
    if (!topic) return [];
    const idSet = new Set(topic.projectIds);
    return all.filter(p => idSet.has(p.id));
  });

// ============================================================
// Open / Close
// ============================================================

  openCreateTopic() {
    this.editingTopicId.set(null);
    this.topicName.set('');
    this.topicDescription.set('');
    this.topicIcon.set('');
    this.topicDefaultModelId.set(null);
    this.topicDefaultSystemPrompt.set('');
    this.topicParamsOverride.set(false);
    this.topicParamsDraft.set(emptyParametersDraft());
    this.topicParamsId = null;
    this.refreshTopicInherited(null);
    this.topicError.set(null);
    this.captureTopicBaseline();
    this.showTopicForm.set(true);
  }

  openEditTopic(topic: Topic) {
    this.editingTopicId.set(topic.id);
    this.topicName.set(topic.name);
    this.topicDescription.set(topic.description || '');
    this.topicIcon.set(topic.icon || '');
    this.topicDefaultModelId.set(topic.defaultModelId);
    this.topicDefaultSystemPrompt.set(topic.defaultSystemPrompt || '');
    void this.loadTopicParams(topic);
    this.topicError.set(null);
    this.captureTopicBaseline();
    this.showTopicForm.set(true);
  }

  async requestCloseTopic(): Promise<void> {
    if (!this.showTopicForm() || this.closeInFlight) return;

    if (this.isTopicDirty()) {
      this.closeInFlight = true;
      const discard = await this.confirm.ask({
        title: 'Unsaved changes',
        message: 'This topic has edits that are not saved yet.\nDiscard them?',
        confirmLabel: 'Discard',
        cancelLabel: 'Keep editing',
        danger: true
      });
      this.closeInFlight = false;
      if (!discard) return;
    }

    this.closeTopicForm();
  }

  closeTopicForm() {
    this.showTopicForm.set(false);
    this.editingTopicId.set(null);
    this.topicError.set(null);
    this.topicBaseline = null;
  }

// ============================================================
// Save (Create or Update)
// ============================================================

  async saveTopic() {
    const name = this.topicName().trim();
    if (!name) {
      this.topicError.set('Name is required');
      return;
    }

    this.topicSaving.set(true);
    this.topicError.set(null);

    try {
      const payload = {
        name,
        description: this.topicDescription().trim(),
        icon: this.topicIcon().trim(),
        defaultModelId: this.topicDefaultModelId(),
        defaultSystemPrompt: this.topicDefaultSystemPrompt().trim(),
        chatParametersId: await this.parameters.persistDraft(
          this.topicParamsId,
          this.topicParamsOverride(),
          this.topicParamsDraft()
        )
      };

      const editingId = this.editingTopicId();

      if (editingId) {
        // ---------- UPDATE ----------
        await this.projectService.updateTopic(editingId, payload);
      } else {
        // ---------- CREATE ----------
        const created = await this.projectService.createTopic(payload);
        // optionally select the newly created topic
        this.selectedTopicId.set(created.id);
      }

      this.closeTopicForm();
    } catch (err: any) {
      console.error(err);
      this.topicError.set(err?.error?.error || err?.message || 'Save failed');
    } finally {
      this.topicSaving.set(false);
    }
  }

// ============================================================
// Delete
// ============================================================

  async deleteTopic(topic: Topic, event?: Event) {
    event?.stopPropagation();

    const projectCount = topic.projectIds?.length ?? 0;
    const message = projectCount > 0
      ? `Delete topic “${topic.name}”?\nIt currently contains ${projectCount} environment(s).\nEnvironments themselves will NOT be deleted.`
      : `Delete topic “${topic.name}”?`;

    const ok = await this.confirm.ask({
      title: 'Delete topic',
      message,
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      danger: true
    });
    if (!ok) return;

    try {
      await this.projectService.deleteTopic(topic.id);
      if (this.selectedTopicId() === topic.id) {
        this.selectedTopicId.set('all');
      }
    } catch (err: any) {
      console.error(err);
      alert('Could not delete topic: ' + (err?.message || err));
    }
  }

// ============================================================
// Membership helpers (already sketched earlier, complete versions)
// ============================================================

  async addProjectToCurrentTopic(projectId: string) {
    const topicId = this.selectedTopicId();
    if (topicId === 'all' || topicId === 'unassigned') return;

    try {
      await this.projectService.addProjectToTopic(topicId, projectId);
    } catch (err: any) {
      console.error(err);
      alert('Could not add environment to topic');
    }
  }

  async removeProjectFromCurrentTopic(projectId: string) {
    const topicId = this.selectedTopicId();
    if (topicId === 'all' || topicId === 'unassigned') return;

    try {
      await this.projectService.removeProjectFromTopic(topicId, projectId);
    } catch (err: any) {
      console.error(err);
      alert('Could not remove environment from topic');
    }
  }

  async onAddToTopic(projectId: string, event: Event) {
    const select = event.target as HTMLSelectElement;
    const topicId = select.value;
    if (!topicId) return;

    await this.projectService.addProjectToTopic(topicId, projectId);
    select.value = '';          // reset the dropdown
  }

  /** Returns all topics that currently contain the given project */
  topicsOf(projectId: string): Topic[] {
    return this.topics().filter(t => t.projectIds.includes(projectId));
  }

  selectTopic(id: string | 'all' | 'unassigned') {
    this.selectedTopicId.set(id);
  }

  onTopicIconSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      this.topicError.set('Please select an image file');
      return;
    }

    if (file.size > 800_000) {
      this.topicError.set('Image is too large (max ~800 KB). Please choose a smaller one.');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      this.topicIcon.set(reader.result as string);   // data URL
      this.topicError.set(null);
    };
    reader.onerror = () => {
      this.topicError.set('Failed to read image');
    };
    reader.readAsDataURL(file);

    // allow selecting the same file again later
    input.value = '';
  }

  clearTopicIcon() {
    this.topicIcon.set('');
  }


  onTopicParamsChanged(event: { override: boolean; draft: ChatParametersDraft }) {
    this.topicParamsOverride.set(event.override);
    this.topicParamsDraft.set(event.draft);
  }

  onProjectParamsChanged(event: { override: boolean; draft: ChatParametersDraft }) {
    this.projectParamsOverride.set(event.override);
    this.projectParamsDraft.set(event.draft);
  }

  private async loadTopicParams(topic: Topic) {
    this.topicParamsId = topic.chatParametersId || null;
    await this.parameters.loadMany([
      this.topicParamsId,
      this.settings.models().find(m => m.id === topic.defaultModelId)?.chatParametersId
    ]);
    const row = this.topicParamsId ? await this.parameters.get(this.topicParamsId) : null;
    this.topicParamsOverride.set(!!row);
    this.topicParamsDraft.set(draftFromParameters(row));
    this.refreshTopicInherited(topic.defaultModelId);
  }

  private async loadProjectParams(project: Project) {
    const topic = this.parameters.topicForProject(project.id, this.topics());
    const model = this.settings.models().find(m => m.id === project.defaultModelId);
    await this.parameters.loadMany([
      project.chatParametersId,
      topic?.chatParametersId,
      model?.chatParametersId
    ]);
    const row = project.chatParametersId ? await this.parameters.get(project.chatParametersId) : null;
    this.projectParamsOverride.set(!!row);
    this.projectParamsDraft.set(draftFromParameters(row));
    this.refreshProjectInherited(project);
  }

  private refreshTopicInherited(defaultModelId: string | null) {
    const model = this.settings.models().find(m => m.id === defaultModelId) || null;
    this.topicParamsInherited.set(this.parameters.resolveForChat({ model }));
  }

  private refreshProjectInherited(project: Project | null) {
    const modelId = project?.defaultModelId ?? this.form.defaultModelId;
    const model = this.settings.models().find(m => m.id === modelId) || null;
    const topic = this.parameters.topicForProject(project?.id ?? null, this.topics()) || null;
    this.projectParamsInherited.set(this.parameters.resolveForChat({ model, topic }));
  }

  onLongTextChange(): void {
    this.fitEditorToContent();
  }

  @HostListener('window:resize')
  onWindowResize(): void {
    if (this.showForm()) this.fitEditorToContent();
  }

  @HostListener('document:keydown', ['$event'])
  onDocumentKeydown(ev: KeyboardEvent): void {
    if (ev.key !== 'Escape') return;

    if (this.confirm.current()) {
      ev.preventDefault();
      this.confirm.close(false);
      return;
    }

    if (this.showForm()) {
      ev.preventDefault();
      void this.requestClose();
      return;
    }

    if (this.showTopicForm()) {
      ev.preventDefault();
      void this.requestCloseTopic();
    }
  }

  private captureProjectBaseline(): void {
    this.projectBaseline = {
      name: this.form.name,
      greeting: this.form.greeting,
      systemPrompt: this.form.systemPrompt,
      defaultModelId: this.form.defaultModelId,
      avatar: this.form.avatar,
      personaIds: JSON.stringify(this.form.personaIds)
    };
  }

  private isProjectDirty(): boolean {
    const b = this.projectBaseline;
    if (!b) return false;
    return (
      this.form.name !== b.name ||
      this.form.greeting !== b.greeting ||
      this.form.systemPrompt !== b.systemPrompt ||
      this.form.defaultModelId !== b.defaultModelId ||
      this.form.avatar !== b.avatar ||
      JSON.stringify(this.form.personaIds) !== b.personaIds
    );
  }

  private captureTopicBaseline(): void {
    this.topicBaseline = {
      name: this.topicName(),
      description: this.topicDescription(),
      icon: this.topicIcon(),
      defaultModelId: this.topicDefaultModelId(),
      defaultSystemPrompt: this.topicDefaultSystemPrompt()
    };
  }

  private isTopicDirty(): boolean {
    const b = this.topicBaseline;
    if (!b) return false;
    return (
      this.topicName() !== b.name ||
      this.topicDescription() !== b.description ||
      this.topicIcon() !== b.icon ||
      this.topicDefaultModelId() !== b.defaultModelId ||
      this.topicDefaultSystemPrompt() !== b.defaultSystemPrompt
    );
  }

  private scheduleFitEditor(retries = 0): void {
    requestAnimationFrame(() => {
      if (
        this.greetingEditor?.nativeElement &&
        this.systemPromptEditor?.nativeElement &&
        this.projectModal?.nativeElement
      ) {
        this.fitEditorToContent();
        return;
      }
      if (retries < 20 && this.showForm()) {
        this.scheduleFitEditor(retries + 1);
      }
    });
  }

  /**
   * Size the environment modal from greeting + system prompt.
   * Width follows the longest line; height is split between the two
   * textareas. Both axes cap at 90% of the viewport.
   */
  private fitEditorToContent(): void {
    const greeting = this.greetingEditor?.nativeElement;
    const system = this.systemPromptEditor?.nativeElement;
    if (!greeting || !system || !this.showForm()) return;

    const maxWidth = Math.floor(window.innerWidth * 0.9);
    const maxHeight = Math.floor(window.innerHeight * 0.9);
    const minWidth = Math.min(560, maxWidth);
    const minGreeting = 88;
    const minDefinition = minGreeting * 2;

    const combined = `${this.form.greeting ?? ''}\n${this.form.systemPrompt ?? ''}`;
    this.editorWidthPx.set(
      this.measureEditorWidth(combined, greeting, minWidth, maxWidth)
    );

    requestAnimationFrame(() => {
      const g = this.greetingEditor?.nativeElement;
      const s = this.systemPromptEditor?.nativeElement;
      const modal = this.projectModal?.nativeElement;
      if (!g || !s || !modal) return;

      g.style.height = 'auto';
      s.style.height = 'auto';
      const needG = Math.max(g.scrollHeight, minGreeting);
      const needS = Math.max(s.scrollHeight, minDefinition);

      const chrome = modal.scrollHeight - g.offsetHeight - s.offsetHeight;
      const available = Math.max(minGreeting + minDefinition, maxHeight - chrome)

      if (needG + needS <= available) {
        this.applyTextareaHeight(g, needG, false);
        this.applyTextareaHeight(s, needS, false);
        return;
      }

      const extra = Math.max(0, available - minGreeting - minDefinition);
      const growG = Math.max(0, needG - minGreeting);
      const growS = Math.max(0, needS - minDefinition);
      const growTotal = growG + growS || 1;
      const heightG = minGreeting + Math.floor(extra * (growG / growTotal));
      const heightS = available - heightG;
      this.applyTextareaHeight(g, heightG, needG > heightG);
      this.applyTextareaHeight(s, heightS, needS > heightS);
    });
  }

  private applyTextareaHeight(
    ta: HTMLTextAreaElement,
    height: number,
    scroll: boolean
  ): void {
    ta.style.height = `${height}px`;
    ta.style.overflowY = scroll ? 'auto' : 'hidden';
  }

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
