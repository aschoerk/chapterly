import {ChatMessage, ChatNode} from '../models/chat';
import {getServerConfig} from './server-config';
import {inject, Injectable} from '@angular/core';
import {ChatService} from './chat.service';

@Injectable({
  providedIn: "root"
})
export class LlmService {
  private readonly chatService = inject(ChatService)

  async askLlm(
    providerBaseUrl: string,
    apiKey: string,
    modelId: string,
    messages: ChatMessage[],
    onChunk?: (chunk: string) => void,
    signal?: AbortSignal
  ): Promise<string> {
    const config = getServerConfig();

    const response = await fetch(`${config.proxyBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'x-target-base': providerBaseUrl,
        'HTTP-Referer': 'https://chat-client.local',
        'X-Title': 'Chat Client'
      },
      body: JSON.stringify({
        model: modelId,
        messages,
        temperature: 0.7,
        stream: true
      }),
      signal                               // ← allows cancellation
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
  let fullContent = '';
  let buffer = '';

  try {
    while (true) {
      // This will throw if the signal is aborted
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
  } catch (err: any) {
    // AbortError is expected when the user clicks Stop
    if (err?.name === 'AbortError') {
      // Return whatever we have received so far
      return fullContent.trim();
    }
    throw err;
  } finally {
    // Make sure the reader is released
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }

  return fullContent.trim() || '(no response)';
  }

  /**
   * Creates an empty answer node under the given question and streams the LLM response into it.
   * Supports cancellation via the generation AbortController.
   * Returns the final (or partial) content that was written.
   */
  async streamAnswer(
    chatId: string,
    questionNodeId: string,
    provider: { baseUrl: string; apiKey: string },
  model: { modelId: string; providerId: string },
  messages: ChatMessage[],
    onChunk?: (chunk: string) => void
  ): Promise<ChatNode> {

    const answerNode = await this.chatService.addNode(chatId, {
      parentId: questionNodeId,
      type: 'answer',
      content: '',
      modelId: model.modelId,
      providerId: model.providerId
    });

    this.chatService.setActiveChild(questionNodeId, answerNode.id);

    const signal = this.chatService.startGeneration(answerNode.id);
    let accumulated = '';

    try {
      accumulated = await this.askLlm(
        provider.baseUrl,
        provider.apiKey,
        model.modelId,
        messages,
        (chunk: string) => {
          accumulated += chunk;

          // Live update in the local store
          this.chatService.updateNodes(
            list =>
              list.map(n =>
                n.id === answerNode.id ? { ...n, content: accumulated } : n
              )
          )

          onChunk?.(chunk);
        },
        signal
      );

      // 3. Persist final / partial answer
      if (accumulated.trim()) {
    const versioned = await this.chatService.editAnswer(chatId, answerNode.id, accumulated);
        this.chatService.setActiveChild(questionNodeId, versioned.id);
    return versioned;
  }
  return answerNode;
  } catch (err) {
    // abort / network — keep whatever tokens we already wrote locally
    return answerNode;
  } finally {
      this.chatService.stopGeneration();
    if (accumulated.trim()) {
      const current = this.chatService.getActiveChild(questionNodeId) ?? answerNode;
      await this.chatService.ensureDraftAtLeaf(chatId);
      this.chatService.scrollToNode?.(current.id);
    }
  }
  }
}
