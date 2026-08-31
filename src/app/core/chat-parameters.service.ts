import { Injectable, inject, signal } from '@angular/core';
import {
  ChatParameters,
  ChatParametersDraft,
  ParametersOwnerType,
  ResolvedChatParameters,
  draftFromParameters,
  emptyParametersDraft,
  isDraftEmpty,
  mergeParameters
} from '../models/chat-parameters';
import { Chat, Project, Topic } from '../models/chat';
import { ModelEntry } from '../models/chat-config';
import { CHAT_API } from '../api/chat-api.token';

@Injectable({ providedIn: 'root' })
export class ChatParametersService {
  private readonly api = inject(CHAT_API);

  private readonly _byId = signal<Record<string, ChatParameters>>({});

  peek(id: string | null | undefined): ChatParameters | null {
    if (!id) return null;
    return this._byId()[id] ?? null;
  }

  async get(id: string): Promise<ChatParameters | null> {
    const cached = this.peek(id);
    if (cached) return cached;
    try {
      const row = await this.api.getChatParameter(id);
      this.remember(row);
      return row;
    } catch {
      return null;
    }
  }

  async list(): Promise<ChatParameters[]> {
    const rows = await this.api.getChatParameters();
    rows.forEach(r => this.remember(r));
    return rows;
  }

  async create(draft: ChatParametersDraft): Promise<ChatParameters> {
    const row = await this.api.createChatParameters(draft);
    this.remember(row);
    return row;
  }

  async update(id: string, draft: ChatParametersDraft): Promise<ChatParameters> {
    const row = await this.api.updateChatParameters(id, draft);
    this.remember(row);
    return row;
  }

  async remove(id: string): Promise<void> {
    await this.api.deleteChatParameters(id);
    this._byId.update(map => {
      const copy = { ...map };
      delete copy[id];
      return copy;
    });
  }

  /**
   * Persist editor state onto an owner.
   * Returns the id to store as chatParametersId (or null to inherit).
   */
  async persistDraft(
    previousId: string | null | undefined,
    override: boolean,
    draft: ChatParametersDraft
  ): Promise<string | null> {
    if (!override || isDraftEmpty(draft)) {
      return null;
    }
    if (previousId) {
      await this.update(previousId, draft);
      return previousId;
    }
    const created = await this.create(draft);
    return created.id;
  }

  async loadMany(ids: Array<string | null | undefined>): Promise<void> {
    const missing = [...new Set(ids.filter((id): id is string => !!id && !this.peek(id)))];
    await Promise.all(missing.map(id => this.get(id)));
  }

  resolve(owners: Array<{ type: ParametersOwnerType; id: string; chatParametersId?: string | null }>): ResolvedChatParameters {
    const layers: Array<{ type: ParametersOwnerType; id: string; params: ChatParameters }> = [];
    for (const owner of owners) {
      const params = this.peek(owner.chatParametersId);
      if (params) layers.push({ type: owner.type, id: owner.id, params });
    }
    return mergeParameters(layers);
  }

  resolveForChat(opts: {
    model?: ModelEntry | null;
    topic?: Topic | null;
    project?: Project | null;
    chat?: Chat | null;
  }): ResolvedChatParameters {
    const owners: Array<{ type: ParametersOwnerType; id: string; chatParametersId?: string | null }> = [];
    if (opts.model) owners.push({ type: 'model', id: opts.model.id, chatParametersId: opts.model.chatParametersId });
    if (opts.topic) owners.push({ type: 'topic', id: opts.topic.id, chatParametersId: opts.topic.chatParametersId });
    if (opts.project) owners.push({ type: 'project', id: opts.project.id, chatParametersId: opts.project.chatParametersId });
    if (opts.chat) owners.push({ type: 'chat', id: opts.chat.id, chatParametersId: opts.chat.chatParametersId });
    return this.resolve(owners);
  }

  topicForProject(projectId: string | null | undefined, topics: Topic[]): Topic | undefined {
    if (!projectId) return undefined;
    return topics.find(t => t.projectIds?.includes(projectId));
  }

  toLlmExtras(resolved: ResolvedChatParameters): Record<string, unknown> {
    const extras: Record<string, unknown> = {};
    if (resolved.temperature != null) extras['temperature'] = resolved.temperature;
    if (resolved.topK != null) extras['top_k'] = resolved.topK;
    if (resolved.topM != null) extras['top_p'] = resolved.topM;
    extras['stream'] = resolved.stream ?? true;

    if (resolved.thinking === false) {
      extras['include_reasoning'] = false;
      return extras;
    }

    if (resolved.thinking === true || resolved.thinkingLevel) {
      extras['include_reasoning'] = true;
      if (resolved.thinkingLevel && resolved.thinkingLevel !== 'none') {
        extras['reasoning'] = { effort: resolved.thinkingLevel };
      } else if (resolved.thinkingLevel === 'none') {
        extras['include_reasoning'] = false;
      } else {
        extras['reasoning'] = { enabled: true };
      }
    }
    return extras;
  }

  private remember(row: ChatParameters): void {
    this._byId.update(map => ({ ...map, [row.id]: row }));
  }

}

export function cloneDraft(draft?: ChatParametersDraft | null): ChatParametersDraft {
  return { ...(draft ?? emptyParametersDraft()) };
}
