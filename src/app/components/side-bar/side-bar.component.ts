import {Component, inject, signal, OnInit, computed} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChatService } from '../../core/chat.service';
import { Router } from '@angular/router';
import { LastModelService } from '../../core/last-model.service';
import { SettingsService } from '../../core/settings.service';
import { Chat, Project } from '../../models/chat';

const LS_EXPANDED_KEY = 'chat-client.projects.expanded';

@Component({
  selector: 'side-bar',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './side-bar.component.html',
  styleUrls: ['./side-bar.component.css']
})
export class SideBarComponent implements OnInit {
  private readonly chatService = inject(ChatService);
  private readonly settings = inject(SettingsService);
  private readonly lastModelService = inject(LastModelService);
  private readonly router = inject(Router);

  readonly projects = this.chatService.projects;
  readonly currentChatId = this.chatService.currentChatId;
  readonly chatsByProject = this.chatService.chatsByProject;
  readonly enabledModels = this.settings.enabledModels;
  readonly searchQuery = signal('');

  /** projectId → expanded (persisted in localStorage) */
  readonly expanded = signal<Record<string, boolean>>({});

  // --- New project form ---
  readonly showNewProject = signal(false);
  readonly newProjectName = signal('');
  readonly newProjectSystemPrompt = signal('');
  readonly newProjectDefaultModelId = signal<string | null>(null);

  // --- Inline edit project ---
  readonly editingProjectId = signal<string | null>(null);
  readonly editName = signal('');
  readonly editSystemPrompt = signal('');
  readonly editDefaultModelId = signal<string | null>(null);

  filteredProjects = computed(() => {
    const q = this.searchQuery().trim().toLowerCase();
    if (!q) return this.projects();
    return this.projects().filter(p =>
      p.name.toLowerCase().includes(q) ||
      this.getChatsForProject(p.id).some(c => c.title.toLowerCase().includes(q))
    );
  });

  async ngOnInit() {
    await Promise.all([
      this.chatService.loadProjects(),
      this.chatService.loadChats(),
      this.settings.loadAll()
    ]);
    this.loadExpandedState();
  }

  // ---------- Expand / collapse (localStorage) ----------

  private loadExpandedState() {
    try {
      const raw = localStorage.getItem(LS_EXPANDED_KEY);
      if (raw) this.expanded.set(JSON.parse(raw));
    } catch { /* ignore */ }
  }

  private persistExpanded() {
    try {
      localStorage.setItem(LS_EXPANDED_KEY, JSON.stringify(this.expanded()));
    } catch { /* ignore */ }
  }

  isExpanded(projectId: string): boolean {
    // default = true (expanded) unless explicitly set to false
    return this.expanded()[projectId] !== false;
  }

  toggleExpanded(projectId: string, event?: Event) {
    event?.stopPropagation();
    this.expanded.update(m => ({
      ...m,
      [projectId]: !this.isExpanded(projectId)
    }));
    this.persistExpanded();
  }

  // ---------- Project CRUD ----------

  startCreateProject() {
    this.showNewProject.set(true);
    this.newProjectName.set('');
    this.newProjectSystemPrompt.set('');
    this.newProjectDefaultModelId.set(null);
  }

  cancelCreateProject() {
    this.showNewProject.set(false);
  }

  async createProject() {
    const name = this.newProjectName().trim();
    if (!name) return;

    const project = await this.chatService.createProject({
      name,
      systemPrompt: this.newProjectSystemPrompt(),
      defaultModelId: this.newProjectDefaultModelId()
    });

    // new projects start expanded
    this.expanded.update(m => ({ ...m, [project.id]: true }));
    this.persistExpanded();
    this.showNewProject.set(false);
  }

  startEditProject(project: Project, event?: Event) {
    event?.stopPropagation();
    this.editingProjectId.set(project.id);
    this.editName.set(project.name);
    this.editSystemPrompt.set(project.systemPrompt || '');
    this.editDefaultModelId.set(project.defaultModelId);
  }

  cancelEditProject() {
    this.editingProjectId.set(null);
  }

  async saveProject() {
    const id = this.editingProjectId();
    if (!id) return;
    const name = this.editName().trim();
    if (!name) return;

    await this.chatService.updateProject(id, {
      name,
      systemPrompt: this.editSystemPrompt(),
      defaultModelId: this.editDefaultModelId()
    });
    this.editingProjectId.set(null);
  }

  async deleteProject(project: Project, event: Event) {
    event.stopPropagation();
    if (!confirm(`Delete project "${project.name}"?\nChats will become unassigned.`)) return;

    await this.chatService.deleteProject(project.id);
    this.expanded.update(m => {
      const next = { ...m };
      delete next[project.id];
      return next;
    });
    this.persistExpanded();
  }

  // ---------- Chats under a project ----------

  async createChatForProject(project: Project, event?: Event) {
    event?.stopPropagation();

    // Title is initialized (user can change it later via the title editor)
    const title = `${project.name} – New Chat`;
    const chat = await this.chatService.createChat(title, project.id);
    await this.chatService.selectChat(chat.id);

    // Apply project's default model
    if (project.defaultModelId) {
      this.lastModelService.setSelectedModel(project.defaultModelId);
      this.lastModelService.saveLastUsedModel(project.defaultModelId);
    } else if (this.lastModelService.lastUsedModelId()) {
      this.lastModelService.setLastModel(this.lastModelService.lastUsedModelId());
    } else {
      this.lastModelService.setSelectedModel('');
    }

    // Make sure the project is visible
    if (!this.isExpanded(project.id)) {
      this.toggleExpanded(project.id);
    }
  }

  async selectChat(chat: Chat) {
    await this.chatService.selectChat(chat.id);
    this.lastModelService.setLastUsedModel();
  }

  async deleteChat(chat: Chat, event: Event) {
    event.stopPropagation();
    if (confirm(`Delete chat "${chat.title}"?`)) {
      await this.chatService.deleteChat(chat.id);
    }
  }

  getChatsForProject(projectId: string | null): Chat[] {
    return this.chatsByProject().get(projectId) || [];
  }

  async goToConfig() {
    await this.router.navigate(['/config']);
  }

  async goToImport() {
    await this.router.navigate(['/import']);
  }
}
