import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import {Chat, ChatNode, CreateNodeRequest, Project, Persona, Topic, NodeAttachment} from '../models/chat';
import { getServerConfig } from '../core/server-config';
import {
  AskLlmOptions,
  BranchQuestionRequest,
  CreatePersonaRequest,
  CreateProjectRequest,
  CreateTopicRequest,
  LlmChatMessage,
  PatchChatRequest,
  UpdatePersonaRequest,
  UpdateProjectRequest,
  UpdateTopicRequest
} from './chat-api.types';

/**
 * Thin HTTP client for the chat-server REST API and the LLM proxy.
 * No local state — ChatService remains the store / facade.
 */
@Injectable({
  providedIn: 'root'
})
export class ChatApiService {
  private readonly http = inject(HttpClient);
  private readonly config = getServerConfig();

  private api(path: string): string {
    return `${this.config.apiBase}${path}`;
  }

  // ---------- Projects ----------

  getProjects(): Promise<Project[]> {
    return firstValueFrom(this.http.get<Project[]>(this.api('/projects')));
  }

  createProject(data: CreateProjectRequest): Promise<Project> {
    return firstValueFrom(this.http.post<Project>(this.api('/projects'), data));
  }

  updateProject(id: string, data: UpdateProjectRequest): Promise<Project> {
    return firstValueFrom(this.http.put<Project>(this.api(`/projects/${id}`), data));
  }

  deleteProject(id: string, deleteChats = false): Promise<void> {
    const qs = deleteChats ? '?deleteChats=true' : '';
    return firstValueFrom(this.http.delete<void>(this.api(`/projects/${id}${qs}`)));
  }

  // ---------- Chats ----------

  getChats(): Promise<Chat[]> {
    return firstValueFrom(this.http.get<Chat[]>(this.api('/chats')));
  }

  createChat(title: string, projectId: string | null = null): Promise<Chat> {
    return firstValueFrom(
      this.http.post<Chat>(this.api('/chats'), { title, projectId })
    );
  }

  deleteChat(id: string): Promise<void> {
    return firstValueFrom(this.http.delete<void>(this.api(`/chats/${id}`)));
  }

  patchChat(id: string, data: PatchChatRequest): Promise<Chat> {
    return firstValueFrom(this.http.patch<Chat>(this.api(`/chats/${id}`), data));
  }

  // ---------- Nodes ----------

  getNodes(chatId: string): Promise<ChatNode[]> {
    return firstValueFrom(
      this.http.get<ChatNode[]>(this.api(`/chats/${chatId}/nodes`))
    );
  }

  createNode(chatId: string, data: CreateNodeRequest): Promise<ChatNode> {
    return firstValueFrom(
      this.http.post<ChatNode>(this.api(`/chats/${chatId}/nodes`), data)
    );
  }

  editAnswer(chatId: string, nodeId: string, content: string, attachments?: NodeAttachment[]): Promise<ChatNode> {
    const body: any = { content };
    if (attachments !== undefined) body.attachments = attachments;

    return firstValueFrom(
      this.http.post<ChatNode>(
        this.api(`/chats/${chatId}/nodes/${nodeId}/edit-answer`),
        body
      )
    );
  }

  branchQuestion(chatId: string, nodeId: string, data: BranchQuestionRequest): Promise<ChatNode> {
    return firstValueFrom(
      this.http.post<ChatNode>(
        this.api(`/chats/${chatId}/nodes/${nodeId}/branch-question`),
        data
      )
    );
  }

  deleteNode(chatId: string, nodeId: string): Promise<void> {
    return firstValueFrom(
      this.http.delete<void>(this.api(`/chats/${chatId}/nodes/${nodeId}`))
    );
  }

  // ---------- Personas ----------

  getPersonas(): Promise<Persona[]> {
    return firstValueFrom(this.http.get<Persona[]>(this.api('/personas')));
  }

  createPersona(data: CreatePersonaRequest): Promise<Persona> {
    return firstValueFrom(this.http.post<Persona>(this.api('/personas'), data));
  }

  updatePersona(id: string, data: UpdatePersonaRequest): Promise<Persona> {
    return firstValueFrom(this.http.put<Persona>(this.api(`/personas/${id}`), data));
  }

  deletePersona(id: string): Promise<void> {
    return firstValueFrom(this.http.delete<void>(this.api(`/personas/${id}`)));
  }

  // ---------- Topics ----------

  getTopics(): Promise<Topic[]> {
    return firstValueFrom(this.http.get<Topic[]>(this.api('/topics')));
  }

  createTopic(data: CreateTopicRequest): Promise<Topic> {
    return firstValueFrom(this.http.post<Topic>(this.api('/topics'), data));
  }

  updateTopic(id: string, data: UpdateTopicRequest): Promise<Topic> {
    return firstValueFrom(this.http.put<Topic>(this.api(`/topics/${id}`), data));
  }

  deleteTopic(id: string): Promise<void> {
    return firstValueFrom(this.http.delete<void>(this.api(`/topics/${id}`)));
  }

  addProjectToTopic(topicId: string, projectId: string): Promise<Topic> {
    return firstValueFrom(
      this.http.post<Topic>(this.api(`/topics/${topicId}/projects`), { projectId })
    );
  }

  removeProjectFromTopic(topicId: string, projectId: string): Promise<Topic> {
    return firstValueFrom(
      this.http.delete<Topic>(this.api(`/topics/${topicId}/projects/${projectId}`))
    );
  }

  // ---------- LLM proxy (streaming) ----------

  /**
   * POST /proxy/chat/completions with SSE-style `data:` chunks.
   * Returns the concatenated assistant text (or whatever arrived before abort).
   */
  async streamChatCompletions(options: AskLlmOptions): Promise<string> {
    const {
      providerBaseUrl,
      apiKey,
      modelId,
      messages,
      onChunk,
      signal,
      temperature = 0.7
    } = options;

    const response = await fetch(`${this.config.proxyBase}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'x-target-base': providerBaseUrl,
        'HTTP-Referer': 'https://chat-client.local',
        'X-Title': 'Chat Client'
      },
      body: JSON.stringify({
        model: modelId,
        messages,
        temperature,
        stream: true
      }),
      signal
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`LLM request failed: ${response.status} ${errText}`);
    }

    if (!response.body) {
      throw new Error('No response body for streaming');
    }

    return this.readSseContent(response.body, onChunk, signal);
  }

  private async readSseContent(
    body: ReadableStream<Uint8Array>,
    onChunk?: (chunk: string) => void,
    _signal?: AbortSignal
  ): Promise<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;

          if (trimmed.startsWith('data: ')) {
            try {
              const json = JSON.parse(trimmed.slice(6));
              const delta = json.choices?.[0]?.delta?.content;
              if (typeof delta === 'string' && delta.length > 0) {
                fullContent += delta;
                onChunk?.(delta);
              }
            } catch {
              // ignore partial / malformed chunks
            }
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return fullContent.trim();
      }
      const named = err as { name?: string };
      if (named?.name === 'AbortError') {
        return fullContent.trim();
      }
      throw err;
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }

    return fullContent.trim() || '(no response)';
  }
}

export type { LlmChatMessage };
