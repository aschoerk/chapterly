import { inject, Injectable } from '@angular/core';
import { ChatNode, NodeAttachment } from '../../../models/chat';
import { newId } from '../../common/helpers';
import {
  imagePartToAttachment,
  textPromptAttachment
} from '../llm-message';
import type { EvalSlots, ImageScene, UsecaseContext } from './types';
import { ChatService } from '../../chat.service';

/**
 * Result of placing a use-case outcome — WHAT the chat should get. The
 * placement logic is pure (testable without the service); applying it to
 * ChatService is a thin, single write-site so the chat is handled
 * consistently. The dialog wiring (later) calls `apply`. For scenes with no
 * image we persist a `refused-prompt-N.txt` so the exact prompt stays
 * findable, mirroring the behavior of the legacy illustration flow.
 */
export interface PlacementPlan {
  /** The chat node that should carry the new content/attachments. */
  targetNodeId: string;
  /** Attachments to persist on the target chapter. */
  attachments: NodeAttachment[];
  /** Human summary of the outcome (for alerts). */
  summary: {
    imagesTotal: number;
    imagesRefused: number;
    /** True when the first/only scene produced nothing. */
    allRefused: boolean;
    /** True when a storyboard partially completed. */
    partial: boolean;
  };
}

/**
 * Placement for the `append` use case (normal text send). The chat gains a
 * NEW assistant node under the user/director node at the end of the chat.
 */
export interface AppendPlacement {
  /** Chat the answer belongs to. */
  chatId: string;
  /** Parent node: the user/director node the answer answers. */
  questionNodeId: string;
  /** The assembled assistant text (may be empty on refusal). */
  content: string;
  /** Assembled thinking text, if any. */
  thinking?: string;
  /** Model/provider that wrote the answer (for provenance). */
  modelId?: string;
  providerId?: string;
  /** True when the stream produced nothing (refused / empty). */
  empty: boolean;
}

/**
 * Resolve the CHAPTER node an illustration should attach to (mirrors the
 * legacy rule): for an assistant node it is the node itself; for a direction
 * it is its current assistant child.
 */
export function resolveChapterNode(cx: UsecaseContext, getChildren: (parentId: string | null) => ChatNode[]): ChatNode | null {
  if (cx.node.role === 'assistant') return cx.node;
  const answers = getChildren(cx.node.id).filter(c => c.role === 'assistant' && c.isCurrent);
  return answers[0] ?? null;
}

/** Convert scene records (+ fallback prompt) into persisted attachments. */
function buildIllustrationAttachments(result: ImageScene[], fallbackPrompt: string): NodeAttachment[] {
  const out: NodeAttachment[] = [];
  let imageIndex = 0;
  for (const scene of result) {
    const prompt = (scene.prompt || '').trim() || fallbackPrompt;
    for (const img of scene.images ?? []) {
      out.push(imagePartToAttachment(img, imageIndex));
      imageIndex += 1;
    }
    if (!prompt) continue;
    if (scene.refused) {
      const reply = (scene.content || '').trim();
      out.push(textPromptAttachment(
        `refused-prompt-${scene.scene}.txt`,
        [
          'Prompt used:',
          prompt,
          '',
          reply ? `Model reply:\n${reply}` : 'Model reply: (none — image was not created)'
        ].join('\n')
      ));
    } else {
      out.push(textPromptAttachment(`prompt-${scene.scene}.txt`, prompt));
    }
  }
  return out;
}

/** `add an id to each attachment` (prototype: id-less attachments are fine; callers assign). */
function withIds(attachments: NodeAttachment[]): NodeAttachment[] {
  return attachments.map(a => ({ ...a, id: a.id || newId() }));
}

/**
 * Postprocessor — decides WHAT to persist from the final slots. Pure core
 * (`plan`) plus a thin apply site. It is the ONLY consumer-facing place that
 * computes chat changes; the use cases only fill slots.
 */
@Injectable({ providedIn: 'root' })
export class LlmPostprocessorService {
  private readonly chatService = inject(ChatService);

  /** Pure: compute the placement plan from final slots. */
  plan(slots: EvalSlots, cx: UsecaseContext): PlacementPlan | null {
    const chapter = resolveChapterNode(cx, pid => this.chatService.getChildren(pid));
    if (!chapter) return null;
    const scenes = slots.storyboard?.value ?? [];
    const fallback = slots.text?.value ?? '';
    const imagesTotal = scenes.reduce((n, s) => n + s.images.length, 0);
    const imagesRefused = scenes.filter(s => s.refused).length;
    return {
      targetNodeId: chapter.id,
      attachments: withIds(buildIllustrationAttachments(scenes, fallback)),
      summary: {
        imagesTotal,
        imagesRefused,
        allRefused: scenes.length > 0 && imagesRefused === scenes.length,
        partial: scenes.length > 1 && imagesTotal > 0 && imagesRefused > 0
      }
    };
  }

  /**
   * Apply a placement: persist the attachments onto the target chapter.
   * `addNote`/`editAssistant` are called through ChatService so versioning +
   * active-child bookkeeping is consistent with the rest of the app.
   */
  async apply(plan: PlacementPlan, cx: UsecaseContext): Promise<ChatNode> {
    const chapter = this.chatService.nodes().find(n => n.id === plan.targetNodeId);
    if (!chapter) throw new Error('Chapter node not found for placement');
    const merged = [...(chapter.attachments ?? []), ...plan.attachments];
    const saved = await this.chatService.editAssistant(
      cx.chat.id,
      chapter.id,
      chapter.content || '',
      merged,
      chapter.thinking ?? undefined
    );
    return saved;
  }

  /**
   * Pure: compute the `append` placement from final slots. The answer is a
   * NEW assistant node under the current (user/director) node. Empty content
   * (refused/error) is preserved so the caller can surface it — we still
   * return a plan with `empty: true`.
   */
  planAppend(
    slots: EvalSlots,
    cx: UsecaseContext,
    write: { modelId?: string; providerId?: string } | null = null
  ): AppendPlacement {
    return {
      chatId: cx.chat.id,
      questionNodeId: cx.node.id,
      content: slots.text?.value ?? '',
      thinking: slots.thinking?.value ?? undefined,
      modelId: write?.modelId,
      providerId: write?.providerId,
      empty: !(slots.text?.status === 'ok')
    };
  }

  /**
   * Apply an append placement: persist the user/direction node if its content
   * changed (via `persistQuestion`), then add the assistant answer node and
   * mark it active. Returns the saved assistant node.
   */
  async applyAppend(plan: AppendPlacement, cx: UsecaseContext, questionContent?: string): Promise<ChatNode> {
    const chatId = plan.chatId;
    const questionId = plan.questionNodeId;
    const question = this.chatService.nodes().find(n => n.id === questionId);
    if (!question) throw new Error('Question node not found for append placement');

    // Persist the user/director node if a composer draft was supplied.
    if (questionContent != null && questionContent !== (question.content ?? '')) {
      await this.chatService.persistQuestion(chatId, questionId, questionContent);
    }

    // Mirror legacy streamAnswer: an assistant answer under the question.
    const answer = await this.chatService.addNode(chatId, {
      parentId: questionId,
      role: 'assistant',
      content: plan.content,
      thinking: plan.thinking ?? '',
      ...(plan.modelId ? { modelId: plan.modelId } : {}),
      ...(plan.providerId ? { providerId: plan.providerId } : {})
    });
    this.chatService.setActiveChild(questionId, answer.id);
    return answer;
  }
}

export { buildIllustrationAttachments };