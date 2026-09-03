import { ChatMessage, ChatNode } from '../models/chat';
import { ModelEntry } from '../models/chat-config';
import { getServerConfig } from './server-config';
import { inject, Injectable } from '@angular/core';
import { ChatService } from './chat.service';
import { ChatParametersService } from './chat-parameters.service';
import { normalizeChatMessages } from './llm-message';
import { extractLlmDelta, LlmChunk, readSseStream } from './llm-sse';
import { ResolvedChatParameters } from '../models/chat-parameters';
import { ProjectService } from "./project.service";

export type { LlmChunk };

@Injectable({ providedIn: 'root' })
export class LlmService {
  private readonly chatService = inject(ChatService);
  private readonly projectService = inject(ProjectService);
  private readonly parameters = inject(ChatParametersService);

  async askLlm(
    providerBaseUrl: string,
    apiKey: string,
    modelId: string,
    messages: ChatMessage[],
    stream: boolean | null,
    onChunk?: (chunk: LlmChunk) => void,
    signal?: AbortSignal,
    extras: Record<string, unknown> = {}
  ): Promise<{ content: string; thinking: string }> {
    const config = getServerConfig();
    const payloadMessages = normalizeChatMessages(messages);
    const useStream = stream !== false && extras['stream'] !== false;
    const { stream: _ignoredStream, ...restExtras } = extras;

    const body =  JSON.stringify({
      model: modelId,
      messages: payloadMessages,
      temperature: restExtras['temperature'] ?? 0.7,
      ...restExtras,
      stream: useStream
    });

    const response =    await fetch(`${config.proxyBase}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'x-target-base': providerBaseUrl,
        'HTTP-Referer': 'https://chat-client.local',
        'X-Title': 'Chapterly'
      },
      body:  JSON.stringify({
        model: modelId,
        messages: payloadMessages,
        temperature: restExtras['temperature'] ?? 0.7,
        ...restExtras,
        stream: useStream
      }),
      signal
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`LLM request failed: ${response.status} ${errText}`);
    }
    if (!response.body) {
      throw new Error('No response body');
    }

    try {
      return await this.readCompletion(response, useStream, onChunk);
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        return { content: '', thinking: '' };
      }
      throw err;
    }
  }

  private async readCompletion(
    response: Response,
    useStream: boolean,
    onChunk?: (chunk: LlmChunk) => void
  ): Promise<{ content: string; thinking: string }> {
    const contentType = response.headers.get('content-type') || '';
    const looksSse = /text\/event-stream/i.test(contentType);

    // Provider honored stream:false → one JSON object, choices[0].message
    if (!useStream && !looksSse) {
      return this.finishNonStream(await response.json(), onChunk);
    }

    // Provider ignored stream:false and still sent SSE
    if (looksSse || useStream) {
      const assembled = await readSseStream(response.body!, onChunk);
      return {
        content: assembled.content.trim() || (assembled.thinking.trim() ? '' : '(no response)'),
        thinking: assembled.thinking.trim()
      };
    }

    return this.finishNonStream(await response.json(), onChunk);
  }

  private finishNonStream(
    json: unknown,
    onChunk?: (chunk: LlmChunk) => void
  ): { content: string; thinking: string } {
    const assembled = extractLlmDelta(json);
    const content = assembled.content.trim() || (assembled.thinking.trim() ? '' : '(no response)');
    const thinking = assembled.thinking.trim();
    if (onChunk && (content || thinking)) {
      onChunk({ content, thinking });
    }
    return { content, thinking };
  }

  async streamAnswer(
    chatId: string,
    questionNodeId: string,
    provider: { baseUrl: string; apiKey: string },
    model: ModelEntry,
    messages: ChatMessage[],
    onChunk?: (chunk: LlmChunk) => void
  ): Promise<ChatNode> {
    const resolved = await this.resolveForCurrentChat(model);
    const extras = {
      ...this.reasoningExtras(model, resolved),
      ...this.parameters.toLlmExtras(resolved)
    };

    const answerNode = await this.chatService.addNode(chatId, {
      parentId: questionNodeId,
      role: 'assistant',
      content: '',
      thinking: '',
      modelId: model.modelId,
      providerId: model.providerId,
      chatParametersId: this.chatService.chats().find(c => c.id === chatId)?.chatParametersId
        || model.chatParametersId
        || undefined
    });

    this.chatService.setActiveChild(questionNodeId, answerNode.id);

    const signal = this.chatService.startGeneration(answerNode.id);
    let accContent = '';
    let accThinking = '';

    const writeLive = () => {
      this.chatService.updateNodes(list =>
        list.map(n =>
          n.id === answerNode.id
            ? { ...n, content: accContent, thinking: accThinking }
            : n
        )
      );
    };

    try {
      const result = await this.askLlm(
        provider.baseUrl,
        provider.apiKey,
        model.modelId,
        messages,
        resolved.stream,
        chunk => {
          if (chunk.content) accContent += chunk.content;
          if (chunk.thinking) accThinking += chunk.thinking;
          writeLive();
          onChunk?.(chunk);
        },
        signal,
        extras
      );

      accContent = result.content;
      accThinking = result.thinking;
      writeLive();

      if (accContent.trim() || accThinking.trim()) {
        const versioned = await this.chatService.editAssistant(
          chatId,
          answerNode.id,
          accContent,
          undefined,
          accThinking
        );
        this.chatService.setActiveChild(questionNodeId, versioned.id);
        return versioned;
      }
      return answerNode;
    } catch {
      return answerNode;
    } finally {
      this.chatService.stopGeneration();
      if (this.chatService.alwaysOpenAtLeaf() && (accContent.trim() || accThinking.trim())) {
        const current = this.chatService.getActiveChild(questionNodeId) ?? answerNode;
        await this.chatService.ensureDraftAtLeaf(chatId);
        this.chatService.scrollToNode?.(current.id);
      }
    }
  }

  private reasoningExtras(
    model: Pick<ModelEntry, 'reasoning' | 'supportedParameters' | 'supported_parameters'>,
    resolved?: ResolvedChatParameters
  ): Record<string, unknown> {
    if (resolved?.thinking === false || resolved?.thinkingLevel === 'none') {
      return {};
    }
    const params = model.supportedParameters ?? model.supported_parameters ?? [];
    const listed = params.some(p => /reasoning|include_reasoning|thinking/i.test(p));
    const meta = model.reasoning;
    if (!listed && !meta && !resolved?.thinking && !resolved?.thinkingLevel) return {};

    const extras: Record<string, unknown> = { include_reasoning: true };
    const effort = resolved?.thinkingLevel
      || meta?.default_effort
      || meta?.supported_efforts?.[0];
    if (effort && effort !== 'none') extras['reasoning'] = { effort };
    else extras['reasoning'] = { enabled: true };
    return extras;
  }

  async resolveForCurrentChat(model: ModelEntry): Promise<ResolvedChatParameters> {
    const chatId = this.chatService.currentChatId();
    const chat = this.chatService.chats().find(c => c.id === chatId) ?? null;
    const project = chat?.projectId ? this.projectService.getProject(chat.projectId) ?? null : null;
    const topic = this.parameters.topicForProject(project?.id, this.projectService.topics()) ?? null;
    await this.parameters.loadMany([
      model.chatParametersId,
      topic?.chatParametersId,
      project?.chatParametersId,
      chat?.chatParametersId
    ]);
    return this.parameters.resolveForChat({ model, topic, project, chat });
  }
}
