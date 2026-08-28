import { ChatMessage, ChatNode } from '../models/chat';
import { ModelEntry } from '../models/chat-config';
import { getServerConfig } from './server-config';
import { inject, Injectable } from '@angular/core';
import { ChatService } from './chat.service';

export interface LlmChunk {
  content?: string;
  thinking?: string;
}

@Injectable({ providedIn: 'root' })
export class LlmService {
  private readonly chatService = inject(ChatService);

  async askLlm(
    providerBaseUrl: string,
    apiKey: string,
    modelId: string,
    messages: ChatMessage[],
    onChunk?: (chunk: LlmChunk) => void,
    signal?: AbortSignal,
    extras: Record<string, unknown> = {}
  ): Promise<{ content: string; thinking: string }> {
    const config = getServerConfig();

    const response = await fetch(`${config.proxyBase}/chat/completions`, {
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
        temperature: 0.7,
        stream: true,
        ...extras
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

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let content = '';
    let thinking = '';
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
          if (!trimmed.startsWith('data: ')) continue;

          try {
            const json = JSON.parse(trimmed.slice(6));
            const delta = json.choices?.[0]?.delta ?? {};
            const contentBit = this.asText(delta.content);
            const thinkingBit = this.extractThinking(delta);
            if (!contentBit && !thinkingBit) continue;

            if (contentBit) content += contentBit;
            if (thinkingBit) thinking += thinkingBit;
            onChunk?.({
              content: contentBit || undefined,
              thinking: thinkingBit || undefined
            });
          } catch {
            // incomplete SSE line
          }
        }
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        return { content: content.trim(), thinking: thinking.trim() };
      }
      throw err;
    } finally {
      try {
        reader.releaseLock();
      } catch { /* ignore */ }
    }

    return {
      content: content.trim() || (thinking.trim() ? '' : '(no response)'),
      thinking: thinking.trim()
    };
  }

  async streamAnswer(
    chatId: string,
    questionNodeId: string,
    provider: { baseUrl: string; apiKey: string },
    model: Pick<ModelEntry, 'modelId' | 'providerId' | 'reasoning' | 'supportedParameters' | 'supported_parameters'>,
    messages: ChatMessage[],
    onChunk?: (chunk: LlmChunk) => void
  ): Promise<ChatNode> {
    const answerNode = await this.chatService.addNode(chatId, {
      parentId: questionNodeId,
      type: 'answer',
      content: '',
      thinking: '',
      modelId: model.modelId,
      providerId: model.providerId
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
        chunk => {
          if (chunk.content) accContent += chunk.content;
          if (chunk.thinking) accThinking += chunk.thinking;
          writeLive();
          onChunk?.(chunk);
        },
        signal,
        this.reasoningExtras(model)
      );

      accContent = result.content;
      accThinking = result.thinking;
      writeLive();

      if (accContent.trim() || accThinking.trim()) {
        const versioned = await this.chatService.editAnswer(
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
      if (accContent.trim() || accThinking.trim()) {
        const current = this.chatService.getActiveChild(questionNodeId) ?? answerNode;
        await this.chatService.ensureDraftAtLeaf(chatId);
        this.chatService.scrollToNode?.(current.id);
      }
    }
  }

  private reasoningExtras(
    model: Pick<ModelEntry, 'reasoning' | 'supportedParameters' | 'supported_parameters'>
  ): Record<string, unknown> {
    const params = model.supportedParameters ?? model.supported_parameters ?? [];
    const listed = params.some(p => /reasoning|include_reasoning|thinking/i.test(p));
    const meta = model.reasoning;
    if (!listed && !meta) return {};

    const extras: Record<string, unknown> = { include_reasoning: true };
    const effort = meta?.default_effort ?? meta?.supported_efforts?.[0];
    if (effort) extras['reasoning'] = { effort };
    else extras['reasoning'] = { enabled: true };
    return extras;
  }

  private extractThinking(delta: any): string {
    return this.asText(
      delta?.reasoning_content ??
      delta?.reasoning ??
      delta?.thinking ??
      delta?.reasoning_text
    );
  }

  private asText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      return value.map(part => this.asText(
        typeof part === 'string' ? part : (part as any)?.text ?? (part as any)?.content
      )).join('');
    }
    if (value && typeof value === 'object' && 'text' in (value as any)) {
      return this.asText((value as any).text);
    }
    return '';
  }
}
