import { Injectable, signal, computed, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Chat, ChatNode, CreateNodeRequest, Project, Persona, Topic, ChatMessage, NodeAttachment } from '../models/chat';
import { CHAT_API } from '../api/chat-api.token';
import {
  CreateProjectRequest,
  CreateTopicRequest,
  UpdateProjectRequest,
  UpdateTopicRequest
} from '../api/chat-api.types';
import {ChatService} from './chat.service';

@Injectable({
  providedIn: 'root'
})
export class ProjectService {
  private readonly api = inject(CHAT_API);
  readonly chatService = inject(ChatService);

  private readonly _projects = signal<Project[]>([]);
  private readonly _topics = signal<Topic[]>([]);
  readonly projects = computed(() => this._projects());
  readonly topics = computed(() => this._topics());


  // ---------- Projects ----------

  async loadProjects(): Promise<void> {
    this._projects.set(await this.api.getProjects());
  }

  async createProject(data: CreateProjectRequest): Promise<Project> {
    const project = await this.api.createProject(data);
    this._projects.update(list =>
      [...list, project].sort((a, b) => a.name.localeCompare(b.name))
    );
    return project;
  }

  async updateProject(id: string, data: UpdateProjectRequest): Promise<Project> {
    const project = await this.api.updateProject(id, data);
    this._projects.update(list =>
      list
        .map(p => (p.id === id ? project : p))
        .sort((a, b) => a.name.localeCompare(b.name))
    );
    return project;
  }

  async deleteProject(id: string, deleteChats = false): Promise<void> {
    await this.api.deleteProject(id, deleteChats);
    this._projects.update(list => list.filter(p => p.id !== id));

    if (deleteChats) {
      this.chatService._chats.update(list => list.filter(c => c.projectId !== id));
    } else {
      this.chatService._chats.update(list =>
        list.map(c => (c.projectId === id ? {...c, projectId: null} : c))
      );
    }
  }

  getProject(id: string | null | undefined): Project | undefined {
    if (!id) return undefined;
    return this._projects().find(p => p.id === id);
  }

  async loadTopics(): Promise<void> {
    this._topics.set(await this.api.getTopics());
  }

  async createTopic(data: CreateTopicRequest): Promise<Topic> {
    const topic = await this.api.createTopic(data);
    this._topics.update(list =>
      [...list, topic].sort((a, b) => a.name.localeCompare(b.name))
    );
    return topic;
  }

  async updateTopic(id: string, data: UpdateTopicRequest): Promise<Topic> {
    const topic = await this.api.updateTopic(id, data);
    this._topics.update(list =>
      list
        .map(t => (t.id === id ? topic : t))
        .sort((a, b) => a.name.localeCompare(b.name))
    );
    return topic;
  }

  async deleteTopic(id: string): Promise<void> {
    await this.api.deleteTopic(id);
    this._topics.update(list => list.filter(t => t.id !== id));
  }

  /** Add a project to a topic */
  async addProjectToTopic(topicId: string, projectId: string): Promise<Topic> {
    const topic = await this.api.addProjectToTopic(topicId, projectId);
    this._topics.update(list =>
      list.map(t => (t.id === topicId ? topic : t))
    );
    return topic;
  }

  /** Remove a project from a topic */
  async removeProjectFromTopic(topicId: string, projectId: string): Promise<Topic> {
    const topic = await this.api.removeProjectFromTopic(topicId, projectId);
    this._topics.update(list =>
      list.map(t => (t.id === topicId ? topic : t))
    );
    return topic;
  }

  getTopic(id: string | null | undefined): Topic | undefined {
    if (!id) return undefined;
    return this._topics().find(t => t.id === id);
  }


}
