import { Injectable, inject } from '@angular/core';
import { Chat, ChatNode, Persona, Project, Topic } from '../models/chat';
import { ChatService } from './chat.service';
import { ProjectService } from './project.service';
import { PersonaService } from './persona.service';

export const BUNDLE_FORMAT = 'aschoerk.chat.bundle';
export const BUNDLE_VERSION = 2;

export type BundleScope =
  | 'personas'
  | 'topic-project'
  | 'project-chats'
  | 'chat'
  | 'all-chats'
  | 'chats-only';

export type ImportPolicy = 'reuse' | 'create';

export interface PackedChat extends Chat {
  nodes: ChatNode[];
  projectName?: string | null;
  topicName?: string | null;
}

export interface ChatBundle {
  format: typeof BUNDLE_FORMAT;
  version: number;
  exportedAt: string;
  scope: BundleScope;
  includeChats: boolean;
  projects: Project[];
  topics: Topic[];
  personas: Persona[];
  chats: PackedChat[];
}

export interface BundleExportOptions {
  scope: BundleScope;
  includeChats: boolean;
  projectId: string | null;
  chatId: string | null;
  onProgress?: (message: string) => void;
}

export interface BundleImportResult {
  createdPersonas: number;
  reusedPersonas: number;
  createdProjects: number;
  reusedProjects: number;
  createdTopics: number;
  reusedTopics: number;
  createdChats: number;
  createdNodes: number;
  unresolvedProjects: number;
  warnings: string[];
}

export interface BundleExportSelection {
  projects: Project[];
  topics: Topic[];
  personas: Persona[];
  chats: Chat[];
}

function normName(value: string | null | undefined): string {
  return (value || '').trim().toLowerCase();
}

@Injectable({ providedIn: 'root' })
export class BundleService {
  private readonly chatService = inject(ChatService);
  private readonly projectService = inject(ProjectService);
  private readonly personaService = inject(PersonaService);

  isBundle(data: any): data is ChatBundle {
    return !!data && data.format === BUNDLE_FORMAT && typeof data === 'object';
  }

  async loadAll(): Promise<void> {
    await Promise.all([
      this.chatService.loadChats(),
      this.projectService.loadProjects(),
      this.projectService.loadTopics(),
      this.personaService.loadPersonas()
    ]);
  }

  planExport(options: BundleExportOptions): BundleExportSelection {
    const scope = options.scope;
    const allProjects = this.projectService.projects();
    const allTopics = this.projectService.topics();
    const allPersonas = this.personaService.personas();
    const allChats = this.chatService.chats();

    let projects: Project[] = [];
    let topics: Topic[] = [];
    let personas: Persona[] = [];
    let chats: Chat[] = [];

    if (scope === 'personas') {
      personas = allPersonas;
    } else if (scope === 'topic-project') {
      if (options.projectId) {
        projects = allProjects.filter(p => p.id === options.projectId);
      } else {
        projects = allProjects;
      }
      topics = this.topicsForProjects(allTopics, projects);
      personas = this.personasForProjects(allPersonas, projects);
      if (options.includeChats) {
        chats = this.chatsForProjects(allChats, projects);
      }
    } else if (scope === 'project-chats') {
      projects = options.projectId
        ? allProjects.filter(p => p.id === options.projectId)
        : allProjects;
      topics = this.topicsForProjects(allTopics, projects);
      personas = this.personasForProjects(allPersonas, projects);
      chats = this.chatsForProjects(allChats, projects);
    } else if (scope === 'chat') {
      const current = options.chatId
        ? allChats.find(c => c.id === options.chatId)
        : undefined;
      chats = current ? [current] : [];
      const usedProjectIds = new Set(chats.map(c => c.projectId).filter(Boolean) as string[]);
      projects = allProjects.filter(p => usedProjectIds.has(p.id));
      topics = this.topicsForProjects(allTopics, projects);
      personas = this.personasForProjects(allPersonas, projects);
    } else if (scope === 'all-chats') {
      chats = allChats;
      const usedProjectIds = new Set(chats.map(c => c.projectId).filter(Boolean) as string[]);
      projects = allProjects.filter(p => usedProjectIds.has(p.id));
      topics = this.topicsForProjects(allTopics, projects);
      personas = this.personasForProjects(allPersonas, projects);
    } else if (scope === 'chats-only') {
      if (options.chatId) {
        const current = allChats.find(c => c.id === options.chatId);
        chats = current ? [current] : [];
      } else if (options.projectId) {
        chats = allChats.filter(c => c.projectId === options.projectId);
      } else {
        chats = allChats;
      }
    }

    return { projects, topics, personas, chats };
  }

  async buildBundle(options: BundleExportOptions): Promise<ChatBundle> {
    const planned = this.planExport(options);
    const packed: PackedChat[] = [];
    for (const chat of planned.chats) {
      options.onProgress?.(`Exporting “${chat.title}”…`);
      const project = chat.projectId
        ? this.projectService.getProject(chat.projectId)
        : undefined;
      const topic = this.projectService.topicForProject(chat.projectId, this.projectService.topics());
      packed.push({
        ...chat,
        nodes: await this.chatService.fetchNodes(chat.id),
        projectName: project?.name ?? null,
        topicName: topic?.name ?? null
      });
    }

    return {
      format: BUNDLE_FORMAT,
      version: BUNDLE_VERSION,
      exportedAt: new Date().toISOString(),
      scope: options.scope,
      includeChats: packed.length > 0,
      projects: planned.projects,
      topics: planned.topics,
      personas: planned.personas,
      chats: packed
    };
  }

  bundleTitle(bundle: ChatBundle): string {
    const parts: string[] = [];
    if (bundle.personas?.length) parts.push(`${bundle.personas.length} persona(s)`);
    if (bundle.projects?.length) parts.push(`${bundle.projects.length} project(s)`);
    if (bundle.topics?.length) parts.push(`${bundle.topics.length} topic(s)`);
    if (bundle.chats?.length) parts.push(`${bundle.chats.length} chat(s)`);
    return parts.length ? `Bundle (${parts.join(', ')})` : 'Empty bundle';
  }

  async importBundle(bundle: ChatBundle, policy: ImportPolicy): Promise<BundleImportResult> {
    await this.loadAll();

    const result: BundleImportResult = {
      createdPersonas: 0,
      reusedPersonas: 0,
      createdProjects: 0,
      reusedProjects: 0,
      createdTopics: 0,
      reusedTopics: 0,
      createdChats: 0,
      createdNodes: 0,
      unresolvedProjects: 0,
      warnings: []
    };

    const chatsOnly = bundle.scope === 'chats-only' ||
      ((bundle.projects?.length ?? 0) === 0 &&
        (bundle.topics?.length ?? 0) === 0 &&
        (bundle.personas?.length ?? 0) === 0 &&
        (bundle.chats?.length ?? 0) > 0);

    const reuse = policy === 'reuse' || chatsOnly;

    const personaMap = await this.importPersonas(bundle.personas || [], reuse, result);
    const projectMap = await this.importProjects(bundle.projects || [], personaMap, reuse, chatsOnly, result);
    await this.importTopics(bundle.topics || [], projectMap, reuse, chatsOnly, result);

    if (chatsOnly) {
      this.fillExistingProjectMap(projectMap, bundle);
    }

    for (const chat of bundle.chats || []) {
      const mappedProjectId = this.resolveChatProjectId(chat, projectMap);
      if (chat.projectId && !mappedProjectId) {
        result.unresolvedProjects++;
        result.warnings.push(
          `Chat “${chat.title}” refers to project “${chat.projectName || chat.projectId}” which was not found; imported without project.`
        );
      }
      const created = await this.importChat(chat, mappedProjectId);
      result.createdChats++;
      result.createdNodes += created;
    }

    return result;
  }

  private topicsForProjects(allTopics: Topic[], projects: Project[]): Topic[] {
    const ids = new Set(projects.map(p => p.id));
    if (!ids.size) return [];
    return allTopics.filter(t => (t.projectIds || []).some(id => ids.has(id)));
  }

  private personasForProjects(allPersonas: Persona[], projects: Project[]): Persona[] {
    const ids = new Set(projects.flatMap(p => p.personaIds || []));
    if (!ids.size) return [];
    return allPersonas.filter(p => ids.has(p.id));
  }

  private chatsForProjects(allChats: Chat[], projects: Project[]): Chat[] {
    const ids = new Set(projects.map(p => p.id));
    if (!ids.size) return [];
    return allChats.filter(c => c.projectId && ids.has(c.projectId));
  }

  private async importPersonas(
    personas: Persona[],
    reuse: boolean,
    result: BundleImportResult
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const existing = this.personaService.personas();
    for (const p of personas) {
      const matched = reuse ? this.matchByIdOrName(existing, p.id, p.name) : undefined;
      if (matched) {
        map.set(p.id, matched.id);
        result.reusedPersonas++;
        continue;
      }
      const created = await this.personaService.createPersona({
        name: p.name,
        shortName: p.shortName,
        description: p.description,
        avatar: p.avatar
      });
      map.set(p.id, created.id);
      result.createdPersonas++;
    }
    return map;
  }

  private async importProjects(
    projects: Project[],
    personaMap: Map<string, string>,
    reuse: boolean,
    chatsOnly: boolean,
    result: BundleImportResult
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const existing = this.projectService.projects();
    for (const p of projects) {
      const matched = reuse ? this.matchByIdOrName(existing, p.id, p.name) : undefined;
      if (matched) {
        map.set(p.id, matched.id);
        result.reusedProjects++;
        continue;
      }
      if (chatsOnly) {
        continue;
      }
      const created = await this.projectService.createProject({
        name: p.name,
        greeting: p.greeting,
        systemPrompt: p.systemPrompt,
        defaultModelId: p.defaultModelId,
        chatParametersId: p.chatParametersId ?? null,
        avatar: p.avatar,
        personaIds: (p.personaIds || []).map(id => personaMap.get(id) || id)
      });
      map.set(p.id, created.id);
      result.createdProjects++;
    }
    return map;
  }

  private async importTopics(
    topics: Topic[],
    projectMap: Map<string, string>,
    reuse: boolean,
    chatsOnly: boolean,
    result: BundleImportResult
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const existing = this.projectService.topics();
    for (const t of topics) {
      const mappedProjectIds = (t.projectIds || [])
        .map(id => projectMap.get(id))
        .filter((id): id is string => !!id);

      const matched = reuse ? this.matchByIdOrName(existing, t.id, t.name) : undefined;
      if (matched) {
        map.set(t.id, matched.id);
        result.reusedTopics++;
        const missing = mappedProjectIds.filter(id => !(matched.projectIds || []).includes(id));
        for (const projectId of missing) {
          await this.projectService.addProjectToTopic(matched.id, projectId);
        }
        continue;
      }
      if (chatsOnly) {
        continue;
      }
      const created = await this.projectService.createTopic({
        name: t.name,
        description: t.description,
        defaultModelId: t.defaultModelId,
        chatParametersId: t.chatParametersId ?? null,
        defaultSystemPrompt: t.defaultSystemPrompt,
        icon: t.icon,
        projectIds: mappedProjectIds
      });
      map.set(t.id, created.id);
      result.createdTopics++;
    }
    return map;
  }

  private fillExistingProjectMap(projectMap: Map<string, string>, bundle: ChatBundle): void {
    const existing = this.projectService.projects();
    for (const p of bundle.projects || []) {
      if (projectMap.has(p.id)) continue;
      const matched = this.matchByIdOrName(existing, p.id, p.name);
      if (matched) projectMap.set(p.id, matched.id);
    }
    for (const chat of bundle.chats || []) {
      if (chat.projectId && !projectMap.has(chat.projectId)) {
        const matched = this.matchByIdOrName(existing, chat.projectId, chat.projectName);
        if (matched) projectMap.set(chat.projectId, matched.id);
      }
    }
  }

  private resolveChatProjectId(chat: PackedChat, projectMap: Map<string, string>): string | null {
    if (chat.projectId && projectMap.has(chat.projectId)) {
      return projectMap.get(chat.projectId)!;
    }
    if (chat.projectName) {
      const existing = this.matchByIdOrName(this.projectService.projects(), chat.projectId, chat.projectName);
      if (existing) return existing.id;
    }
    if (chat.projectId) {
      const existing = this.projectService.getProject(chat.projectId);
      if (existing) return existing.id;
    }
    return null;
  }

  private async importChat(chat: PackedChat, projectId: string | null): Promise<number> {
    const createdChat = await this.chatService.createChat(chat.title, projectId);
    if (chat.chatParametersId) {
      try {
        await this.chatService.reassignChatParams(createdChat.id, chat.chatParametersId);
      } catch {
        // parameters may not exist on the target workspace
      }
    }

    const idMap = new Map<string, string>();
    const pending = [...(chat.nodes || [])];
    const ready = (n: ChatNode) => !n.parentId || idMap.has(n.parentId);
    let created = 0;

    while (pending.length) {
      let idx = pending.findIndex(ready);
      if (idx < 0) {
        // orphan / broken parent pointer — attach as a new root
        idx = 0;
      }
      const [n] = pending.splice(idx, 1);
      const parentId = n.parentId && idMap.has(n.parentId) ? idMap.get(n.parentId)! : null;
      const createdNode = await this.chatService.createNodeForImport(createdChat.id, {
        parentId,
        role: n.role,
        content: n.content,
        thinking: n.thinking || undefined,
        modelId: n.modelId || undefined,
        providerId: n.providerId || undefined,
        attachments: n.attachments,
        chatParametersId: n.chatParametersId ?? null
      });
      idMap.set(n.id, createdNode.id);
      created++;
    }
    return created;
  }

  private matchByIdOrName<T extends { id: string; name: string }>(
    existing: T[],
    id: string | null | undefined,
    name: string | null | undefined
  ): T | undefined {
    if (id) {
      const byId = existing.find(item => item.id === id);
      if (byId) return byId;
    }
    const key = normName(name);
    if (!key) return undefined;
    return existing.find(item => normName(item.name) === key);
  }
}
