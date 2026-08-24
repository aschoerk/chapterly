import { Component, inject, signal, OnInit, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ChatService } from '../../core/chat.service';
import { SettingsService } from '../../core/settings.service';
import { Project, Persona } from '../../models/chat';

@Component({
  selector: 'app-projects',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './projects.component.html',
  styleUrl: './projects.component.css'
})
export class ProjectsComponent implements OnInit {
  private readonly chatService = inject(ChatService);
  private readonly settings = inject(SettingsService);
  private readonly router = inject(Router);

  readonly projects = this.chatService.projects;
  readonly personas = this.chatService.personas;
  readonly enabledModels = this.settings.enabledModels;

  readonly searchTerm = signal('');
  readonly showForm = signal(false);
  readonly editingId = signal<string | null>(null);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly openMenuId = signal<string | null>(null);

  form = {
    name: '',
    greeting: '',
    systemPrompt: '',
    defaultModelId: null as string | null,
    avatar: '',
    personaIds: [] as string[]
  };

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
        this.chatService.loadProjects(),
        this.chatService.loadPersonas(),
        this.settings.loadAll()
      ]);
    } catch (e) {
      console.error('Failed to load projects', e);
      this.error.set('Failed to load projects from server.');
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

  openCreate() {
    this.editingId.set(null);
    this.form = {
      name: '',
      greeting: '',
      systemPrompt: '',
      defaultModelId: null,
      avatar: '',
      personaIds: []
    };
    this.error.set(null);
    this.showForm.set(true);
  }

  openEdit(project: Project) {
    this.editingId.set(project.id);
    this.form = {
      name: project.name,
      greeting: project.greeting,
      systemPrompt: project.systemPrompt || '',
      defaultModelId: project.defaultModelId,
      avatar: project.avatar || '',
      personaIds: [...(project.personaIds || [])]
    };
    this.error.set(null);
    this.showForm.set(true);
  }

  closeForm() {
    this.showForm.set(false);
    this.editingId.set(null);
    this.error.set(null);
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
        personaIds: this.form.personaIds
      };

      if (this.editingId()) {
        await this.chatService.updateProject(this.editingId()!, payload);
      } else {
        await this.chatService.createProject(payload);
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
    if (!confirm(`Delete project "${project.name}"?\nChats will become unassigned.`)) {
      return;
    }
    try {
      await this.chatService.deleteProject(project.id);
    } catch (e) {
      console.error(e);
      alert('Failed to delete project');
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
}
