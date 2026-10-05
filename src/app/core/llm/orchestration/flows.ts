import { inject, Injectable } from '@angular/core';
import { ChatMessage, ChatNode, NodeAttachment } from '../../../models/chat';
import { ChatService } from '../../chat.service';
import { UsecaseContextFactory, type BuildContext, type ModelRef } from './context';
import { LlmOrchestratorService, type PrimitiveOptions } from './orchestrator';
import type { EvalSlots, FlowResult, UsecaseContext, UsecaseKind, UsecaseVars } from './types';
import { makeSlot, okSlot } from './slots';
import { imagePartToAttachment, type LlmImagePart } from '../llm-message';
import { newId } from '../../common/helpers';

/**
 * Structural text-send flows.
 *
 * These are use cases that change the shape of the chat (create/delete/move
 * nodes) AROUND a plain text send. They reuse the append machinery:
 *   - the shared `prepareTextSend` (interprets attached images ONLY when
 *     their description is not already stored in the node's text, then builds
 *     a text-only history),
 *   - `streamAnswerNode` (creates a placeholder assistant node, streams into
 *     it via the orchestrator with live painting, versions it).
 *
 * Structural chat changes go through ChatService, consistent with the rest of
 * the app (postprocessor is the only other chat writer; these flows are the
 * "before/after" of a send and therefore need to move nodes around).
 *
 * Controllers are plain async functions over the shared primitives — no
 * table, no transport, no evaluator logic.
 */

/** Runtime environment for structural flows. */
export interface FlowEnv {
  readonly cx: UsecaseContext;
  readonly factory: UsecaseContextFactory;
  readonly orch: LlmOrchestratorService;
  readonly write: ModelRef;
  readonly textExtras: Record<string, unknown>;
  readonly chatService: ChatService;
  readonly signal?: AbortSignal;
  readonly onChunk?: PrimitiveOptions['onChunk'];
}

export type FlowController = (env: FlowEnv) => Promise<EvalSlots>;

// ---------------------------------------------------------------------------
// Shared machinery
// ---------------------------------------------------------------------------

/** Result of preparing a text send (interpretation + message building). */
interface PreparedSend {
  messages: ChatMessage[];
  /** Set when images were freshly interpreted and merged into the content. */
  mergedContent?: string;
  /** The record attachment to persist (marks "description stored"). */
  record?: import('./context').NodeAttachmentLike;
}

/** Minimal env fields `prepareTextSend` needs (UsecaseEnv + FlowEnv satisfy it). */
interface PrepareEnv {
  readonly cx: UsecaseContext;
  readonly factory: UsecaseContextFactory;
  readonly orch: LlmOrchestratorService;
  readonly signal?: AbortSignal;
}

/**
 * Build the messages for a text send for a QUESTION node, using THE
 * interpretation rule: images are interpreted ONLY when their description is
 * not already stored in the node's text (i.e. no matching
 * `image-description.txt` record). When freshly interpreted, the merged
 * content + record are returned so the caller persists them.
 */
export async function prepareTextSend(
  env: PrepareEnv,
  chatId: string,
  question: ChatNode,
  opts: { content?: string; attachments?: import('./context').NodeAttachmentLike[] } = {}
): Promise<PreparedSend> {
  const content = (opts.content ?? question.content ?? '').trim();
  const atts = opts.attachments !== undefined ? opts.attachments : (question.attachments ?? []);

  const need = env.factory.needsImageInterpretation(question, atts);
  if (need) {
    const interpret = env.factory.resolveInterpretModel();
    const images = env.factory.imageAttachments(atts);
    if (interpret && images.length > 0) {
      const islots = await env.orch.completion(env.cx, {
        model: interpret.model,
        provider: interpret.provider,
        messages: env.factory.buildInterpretMessage(images),
        extras: await env.factory.resolveTextExtras(interpret.model, env.cx.chat),
        stream: false
      }, { expect: 'text', signal: env.signal });
      const description = islots.text?.value?.trim() ?? '';
      if (description) {
        const merged = env.factory.mergeDirectionWithDescription(content, description);
        const messages = env.factory.buildSendMessagesEx({ chatId, nodeId: question.id, contentOverride: merged });
        const record = env.factory.buildImageDescriptionRecord(images, description);
        return { messages, mergedContent: merged, record };
      }
    }
  }
  const messages = env.factory.buildSendMessagesEx({ chatId, nodeId: question.id, contentOverride: content });
  return { messages };
}

/** Merge + persist the freshly-interpreted content + record onto the node. */
async function persistInterpretation(
  env: FlowEnv,
  chatId: string,
  node: ChatNode,
  prep: PreparedSend
): Promise<void> {
  if (!prep.mergedContent || !prep.record) return;
  const attachments = [
    ...env.factory.withoutImageDescriptionRecord(node.attachments),
    prep.record
  ];
  await env.chatService.patchNode(chatId, node.id, {
    content: prep.mergedContent,
    attachments: attachments as ChatNode['attachments']
  });
}

/** True when a flow's answer produced nothing (refused/empty). */
function flowEmpty(slots: EvalSlots): boolean {
  const text = (slots.text?.value ?? '').trim();
  // Images count as content — an image-capable model returning ONLY pictures
  // is a successful (non-empty) answer, not a refused/empty one.
  if (!text && slots.text?.status !== 'ok') {
    return (slots.images?.value ?? []).length === 0;
  }
  return false;
}

/**
 * Convert generated image parts into persisted node attachments (ids assigned,
 * deduped by URL — a stream may resend the same part in delta + final message).
 */
export function generatedImageAttachments(images: LlmImagePart[]): NodeAttachment[] {
  const seen = new Set<string>();
  const out: NodeAttachment[] = [];
  let idx = 0;
  for (const img of images ?? []) {
    if (!img?.url || seen.has(img.url)) continue;
    seen.add(img.url);
    out.push({ ...imagePartToAttachment(img, idx), id: newId() });
    idx++;
  }
  return out;
}

/**
 * Stream one answer into a NEW assistant node under `questionNodeId` (the
 * normal send path: placeholder + startGeneration + live paint via
 * ChatService.updateNodes + versioned editAssistant), optionally re-parenting
 * `adoptNodeIds` under the fresh answer.
 */
async function streamAnswerNode(
  env: FlowEnv,
  chatId: string,
  questionNodeId: string,
  messages: ChatMessage[],
  opts: { adoptNodeIds?: string[] } = {}
): Promise<{ answerNodeId: string; slots: EvalSlots }> {
  const chatService = env.chatService;
  const write = env.write;
  const answerNode = await chatService.addNode(chatId, {
    parentId: questionNodeId,
    role: 'assistant',
    content: '',
    thinking: '',
    modelId: write.model.modelId,
    providerId: write.model.providerId
  });
  chatService.setActiveChild(questionNodeId, answerNode.id);
  const signal = chatService.startGeneration(answerNode.id);

  let accContent = '';
  let accThinking = '';
  let accImages: LlmImagePart[] = [];
  try {
    const slots = await env.orch.completion(env.cx, {
      model: write.model,
      provider: write.provider,
      messages,
      extras: env.textExtras,
      stream: true
    }, {
      expect: 'text',
      onChunk: chunk => {
        if (chunk.content) accContent += chunk.content;
        if (chunk.thinking) accThinking += chunk.thinking;
        if (chunk.images?.length) accImages.push(...chunk.images);
        chatService.updateNodes(list =>
          list.map(n => (n.id === answerNode.id ? { ...n, content: accContent, thinking: accThinking } : n))
        );
      },
      signal
    });

    const finalContent = slots.text?.value ?? accContent;
    const finalThinking = slots.thinking?.value ?? accThinking;
    const finalImages = slots.images?.value ?? accImages;
    chatService.updateNodes(list =>
      list.map(n => (n.id === answerNode.id ? { ...n, content: finalContent, thinking: finalThinking } : n))
    );

    let answerId = answerNode.id;
    // An image-only answer (image-capable model streamed pictures, no text)
    // must STILL be finalized — otherwise it stays an empty placeholder that
    // renders as "Generation stopped" and the images are never attached.
    if (finalContent.trim() || finalThinking.trim() || finalImages.length > 0) {
      const attachments = finalImages.length ? generatedImageAttachments(finalImages) : undefined;
      const versioned = await chatService.editAssistant(
        chatId, answerNode.id, finalContent, attachments, finalThinking
      );
      answerId = versioned.id;
      chatService.setActiveChild(questionNodeId, answerId);
      if (opts.adoptNodeIds?.length) {
        await chatService.reparentNodes(chatId, opts.adoptNodeIds, answerId);
      }
    }
    return { answerNodeId: answerId, slots };
  } finally {
    chatService.clearGeneration();
  }
}

/** The user node a regenerate/rewrite re-answers (the parent of the answer). */
function parentQuestion(env: FlowEnv, node: ChatNode): ChatNode | null {
  return node.parentId
    ? env.chatService.nodes().find(n => n.id === node.parentId) ?? null
    : null;
}

// ---------------------------------------------------------------------------
// send-branch — new sibling question + streamed answer
// ---------------------------------------------------------------------------
const sendBranch: FlowController = async env => {
  const node = env.cx.node;
  const chatId = env.cx.chat.id;
  const content = env.cx.vars.content ?? node.content ?? '';
  const carried = carryAttachments(node.attachments ?? [], env.cx.vars.attachments);

  // Legacy rule: branching a QUESTION creates a sibling under its parent;
  // branching an ANSWER creates a child question under the answer.
  const newQuestion = node.role === 'user'
    ? await env.chatService.branchQuestion(
        chatId, node.id, content, env.write.model.modelId, env.write.model.providerId, carried
      )
    : await env.chatService.addNode(chatId, {
        parentId: node.id,
        role: 'user',
        content,
        modelId: env.write.model.modelId,
        providerId: env.write.model.providerId,
        attachments: carried as ChatNode['attachments']
      });
  env.chatService.setActiveChild(newQuestion.parentId, newQuestion.id);

  const prep = await prepareTextSend(env, chatId, newQuestion, { content, attachments: carried });
  await persistInterpretation(env, chatId, newQuestion, prep);
  const { answerNodeId, slots } = await streamAnswerNode(env, chatId, newQuestion.id, prep.messages);
  return flowResult(slots, {
    questionNodeId: newQuestion.id,
    answerNodeId,
    activateId: newQuestion.id,
    branchNodeId: newQuestion.id
  }, flowEmpty(slots));
};

// ---------------------------------------------------------------------------
// send-insert — new sibling question + answer that adopts the old siblings
// ---------------------------------------------------------------------------
const sendInsert: FlowController = async env => {
  const node = env.cx.node;
  const chatId = env.cx.chat.id;
  const parentId = node.parentId ?? null;
  const content = env.cx.vars.content ?? node.content ?? '';
  const carried = carryAttachments(node.attachments ?? [], env.cx.vars.attachments);

  const newQuestion = await env.chatService.branchQuestion(
    chatId, node.id, content, env.write.model.modelId, env.write.model.providerId, carried
  );
  const adoptNodeIds = env.chatService.nodes()
    .filter(n => n.chatId === chatId && (n.parentId ?? null) === parentId && n.id !== newQuestion.id)
    .map(n => n.id);

  const prep = await prepareTextSend(env, chatId, newQuestion, { content, attachments: carried });
  await persistInterpretation(env, chatId, newQuestion, prep);
  const { answerNodeId, slots } = await streamAnswerNode(env, chatId, newQuestion.id, prep.messages, { adoptNodeIds });

  env.chatService.setActiveChild(parentId, newQuestion.id);
  env.chatService.setActiveChild(newQuestion.id, answerNodeId);
  const firstAdopt = adoptNodeIds.includes(node.id) ? node.id : adoptNodeIds[0];
  if (firstAdopt) env.chatService.setActiveChild(answerNodeId, firstAdopt);

  return flowResult(slots, {
    questionNodeId: newQuestion.id,
    answerNodeId,
    activateId: newQuestion.id,
    branchNodeId: newQuestion.id
  }, flowEmpty(slots));
};

// ---------------------------------------------------------------------------
// send-regenerate — delete the answer (+ subtree), re-stream under the question
// ---------------------------------------------------------------------------
const sendRegenerate: FlowController = async env => {
  const node = env.cx.node;
  const chatId = env.cx.chat.id;
  const question = parentQuestion(env, node);
  if (!question) {
    return { error: makeSlot('error', 'http', 'No question node to regenerate.', {}) };
  }

  await env.chatService.deleteNode(chatId, node.id);

  const prep = await prepareTextSend(env, chatId, question, {
    content: question.content,
    attachments: question.attachments
  });
  await persistInterpretation(env, chatId, question, prep);
  const { answerNodeId, slots } = await streamAnswerNode(env, chatId, question.id, prep.messages);
  return flowResult(slots, {
    questionNodeId: question.id,
    answerNodeId,
    activateId: question.id
  }, flowEmpty(slots));
};

// ---------------------------------------------------------------------------
// send-rewrite — delete ONLY the answer (keep following text), re-stream
// ---------------------------------------------------------------------------
const sendRewrite: FlowController = async env => {
  const node = env.cx.node;
  const chatId = env.cx.chat.id;
  const question = parentQuestion(env, node);
  if (!question) {
    return { error: makeSlot('error', 'http', 'No question node to rewrite.', {}) };
  }

  const adoptNodeIds = env.chatService.getChildren(node.id).map(c => c.id);
  await env.chatService.deleteNode(chatId, node.id, { keepChildren: true });

  const prep = await prepareTextSend(env, chatId, question, {
    content: question.content,
    attachments: question.attachments
  });
  await persistInterpretation(env, chatId, question, prep);
  const { answerNodeId, slots } = await streamAnswerNode(env, chatId, question.id, prep.messages, { adoptNodeIds });
  if (adoptNodeIds.length) env.chatService.setActiveChild(answerNodeId, adoptNodeIds[0]);
  return flowResult(slots, {
    questionNodeId: question.id,
    answerNodeId,
    activateId: question.id
  }, flowEmpty(slots));
};

// ---------------------------------------------------------------------------
// send-prepend — director node + streamed result, adopting the current node
// ---------------------------------------------------------------------------
const sendPrepend: FlowController = async env => {
  const node = env.cx.node;
  const chatId = env.cx.chat.id;
  const parentId = node.parentId ?? null;
  const directorText = (env.cx.vars.directorText ?? '').trim();
  const following = (env.cx.vars.followingText ?? '').trim();
  const prompt = [directorText, following].filter(Boolean).join('\n\n');
  if (!prompt.trim()) {
    return { error: makeSlot('error', 'http', 'No director text to prepend.', {}) };
  }

  const directorNode = await env.chatService.addNode(chatId, {
    parentId,
    role: 'user',
    content: directorText,
    modelId: env.write.model.modelId,
    providerId: env.write.model.providerId
  });
  env.chatService.setActiveChild(parentId, directorNode.id);

  // The final user message is the director + following chapters; history is
  // the text-only path up to the current node (images never re-sent).
  const messages = env.factory.buildSendMessagesEx({
    chatId,
    nodeId: directorNode.id,
    contentOverride: prompt
  });

  const { answerNodeId, slots } = await streamAnswerNode(
    env, chatId, directorNode.id, messages, { adoptNodeIds: [node.id] }
  );
  env.chatService.setActiveChild(parentId, directorNode.id);
  return flowResult(slots, {
    questionNodeId: directorNode.id,
    answerNodeId,
    directorNodeId: directorNode.id,
    activateId: answerNodeId
  }, flowEmpty(slots));
};

// ---------------------------------------------------------------------------
// send-elaborate — one chapter elaboration appended under the anchor
// ---------------------------------------------------------------------------
const sendElaborate: FlowController = async env => {
  const anchor = env.cx.node;
  const chatId = env.cx.chat.id;
  const content = (env.cx.vars.content ?? '').trim();
  if (!content) {
    return { error: makeSlot('error', 'http', 'No elaborate prompt.', {}) };
  }
  const parentId = anchor?.id ?? null;

  // Reuse an empty user leaf draft under the anchor if one exists, else
  // create a fresh question (mirrors the legacy elaborate dialog).
  const question = await getOrCreateElaborateQuestion(env, chatId, parentId, content);

  // History = text-only path up to the question + topic system prompt; the
  // final user message is the rendered elaborate prompt.
  const messages = env.factory.buildSendMessagesEx({
    chatId,
    nodeId: question.id,
    contentOverride: content
  });

  const { answerNodeId, slots } = await streamAnswerNode(env, chatId, question.id, messages);
  return flowResult(slots, {
    questionNodeId: question.id,
    answerNodeId,
    activateId: answerNodeId
  }, flowEmpty(slots));
};

/** Reuse an empty user leaf under `parentId` if one exists, else create one. */
async function getOrCreateElaborateQuestion(
  env: FlowEnv,
  chatId: string,
  parentId: string | null,
  content: string
): Promise<ChatNode> {
  const chatService = env.chatService;
  const children = chatService.getChildren(parentId);
  const draft = children.find(n =>
    n.role === 'user' &&
    !(n.content ?? '').trim() &&
    !(n.attachments?.length)
  );
  if (draft) {
    const saved = await chatService.persistQuestion(
      chatId, draft.id, content, undefined,
      env.write.model.modelId, env.write.model.providerId
    );
    chatService.setActiveChild(parentId, saved.id);
    return saved;
  }
  const created = await chatService.addNode(chatId, {
    parentId,
    role: 'user',
    content,
    modelId: env.write.model.modelId,
    providerId: env.write.model.providerId
  });
  chatService.setActiveChild(parentId, created.id);
  return created;
}

// ---------------------------------------------------------------------------
// Structure generation — non-streaming text completions that CREATE or PATCH
// structural nodes around a plain text result (story title, introduction,
// per-chapter headings) plus the language check. They reuse the shared
// write-model + text-extras resolution from the flow runner; the editorial
// placement goes through ChatService (create structural node + reparent).
// ---------------------------------------------------------------------------

/** One non-streaming text completion (title/overview/heading/language check). */
async function textCompletion(env: FlowEnv, userContent: string): Promise<EvalSlots> {
  return env.orch.completion(env.cx, {
    model: env.write.model,
    provider: env.write.provider,
    messages: [{ role: 'user', content: userContent }],
    extras: env.textExtras,
    stream: false
  }, { expect: 'text', signal: env.signal });
}

/** Create a structural node (title/overview/heading) under `parentId`. */
async function addStructureNode(env: FlowEnv, chatId: string, parentId: string | null, content: string): Promise<ChatNode> {
  const model = env.write.model;
  return env.chatService.addNode(chatId, {
    parentId,
    role: 'structural',
    content,
    modelId: model.modelId,
    providerId: model.providerId,
    chatParametersId: env.chatService.chats().find(c => c.id === chatId)?.chatParametersId
      || model.chatParametersId
      || undefined
  });
}

/** Wrap result slots in a structure placement (node(s) created/patched). */
function structureResult(slots: EvalSlots, nodeId: string, ids?: string[]): EvalSlots {
  const flow: FlowResult = {
    questionNodeId: '',
    answerNodeId: nodeId,
    activateId: nodeId,
    structureNodeId: nodeId,
    ...(ids ? { structureNodeIds: ids } : {}),
    empty: false
  };
  return { ...slots, flow: okSlot(flow, {}) };
}

/** All current assistant chapters (the whole-story context). */
function wholeStoryContext(env: FlowEnv): string {
  return env.chatService.currentNodes()
    .filter(n => n.isCurrent && n.role === 'assistant' && n.content?.trim())
    .map(n => n.content)
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// structure-title — a story title from ALL current chapters, wrapped at root;
// the generated title also becomes the chat title.
// ---------------------------------------------------------------------------
const structureTitle: FlowController = async env => {
  const chatId = env.cx.chat.id;
  const chatService = env.chatService;
  const instruction = env.factory.structureInstruction('title');
  const context = wholeStoryContext(env);
  const slots = await textCompletion(env,
    `${instruction}\n\nCurrent chat context:\n${context || '(empty chat)'}\n\nReturn only the resulting text.`);
  const content = (slots.text?.value ?? '').trim();
  if (!content) return { ...slots, error: makeSlot('error', 'http', 'No title generated.', {}) };

  const first = chatService.getActiveChild(null);
  const created = await addStructureNode(env, chatId, null, content);
  if (first) {
    await chatService.reparentNodes(chatId, [first.id], created.id);
    chatService.setActiveChild(null, created.id);
    chatService.setActiveChild(created.id, first.id);
  } else {
    chatService.setActiveChild(null, created.id);
  }
  await chatService.updateChatTitle(chatId, content);
  return structureResult(slots, created.id);
};

// ---------------------------------------------------------------------------
// structure-overview — an introduction from ALL current chapters; sits right
// after an existing structure node (e.g. a title), else becomes the first.
// ---------------------------------------------------------------------------
const structureOverview: FlowController = async env => {
  const chatId = env.cx.chat.id;
  const chatService = env.chatService;
  const instruction = env.factory.structureInstruction('overview');
  const context = wholeStoryContext(env);
  const slots = await textCompletion(env,
    `${instruction}\n\nCurrent chat context:\n${context || '(empty chat)'}\n\nReturn only the resulting text.`);
  const content = (slots.text?.value ?? '').trim();
  if (!content) return { ...slots, error: makeSlot('error', 'http', 'No introduction generated.', {}) };

  const rootChildren = chatService.getChildren(null);
  const existingStructure = rootChildren.find(n => n.role === 'structural');
  const parentId = existingStructure?.id ?? null;
  const first = chatService.getActiveChild(parentId);
  const created = await addStructureNode(env, chatId, parentId, content);
  if (first) {
    await chatService.reparentNodes(chatId, [first.id], created.id);
    chatService.setActiveChild(parentId, created.id);
    chatService.setActiveChild(created.id, first.id);
  } else {
    chatService.setActiveChild(parentId, created.id);
  }
  return structureResult(slots, created.id);
};

// ---------------------------------------------------------------------------
// structure-heading — a heading for ONE chapter (the current node). Patches
// the chapter's structural parent when one exists, else wraps the chapter.
// ---------------------------------------------------------------------------
const structureHeading: FlowController = async env => {
  const node = env.cx.node;
  const chatId = env.cx.chat.id;
  const chatService = env.chatService;
  if (!node || node.role !== 'assistant') {
    return { error: makeSlot('error', 'http', 'No assistant chapter to head.', {}) };
  }
  const instruction = env.factory.structureInstruction('headings');
  const context = (node.content ?? '').trim();
  const slots = await textCompletion(env,
    `${instruction}\n\nCurrent chat context:\n${context || '(empty chat)'}\n\nReturn only the resulting text.`);
  const content = (slots.text?.value ?? '').trim();
  if (!content) return { ...slots, error: makeSlot('error', 'http', 'No heading generated.', {}) };

  const existingHeading = node.parentId
    ? chatService.nodes().find(n => n.id === node.parentId && n.role === 'structural')
    : undefined;
  if (existingHeading) {
    await chatService.patchNode(chatId, existingHeading.id, {
      content,
      modelId: env.write.model.modelId,
      providerId: env.write.model.providerId
    });
    return structureResult(slots, existingHeading.id);
  }

  const created = await addStructureNode(env, chatId, node.parentId, content);
  await chatService.reparentNodes(chatId, [node.id], created.id);
  chatService.setActiveChild(node.parentId, created.id);
  chatService.setActiveChild(created.id, node.id);
  return structureResult(slots, created.id);
};

// ---------------------------------------------------------------------------
// structure-headings — a heading for EVERY chapter on the active path that
// has none yet. Already-headed chapters stay in the context (as previous
// chapters with their headings) but are never regenerated. Aborts between
// chapters on the caller signal (one Stop cancels the whole run).
// ---------------------------------------------------------------------------
const structureHeadings: FlowController = async env => {
  const chatId = env.cx.chat.id;
  const chatService = env.chatService;
  const instruction = env.factory.structureInstruction('headings');
  const assistants = chatService.getActivePath()
    .filter(n => n.role === 'assistant' && n.content?.trim());
  const nodeById = new Map(chatService.currentNodes().map(n => [n.id, n]));
  const previous: { node: ChatNode; heading: ChatNode }[] = [];
  const createdIds: string[] = [];

  for (const assistant of assistants) {
    if (env.signal?.aborted) break;
    const parent = assistant.parentId ? nodeById.get(assistant.parentId) : undefined;
    if (parent?.role === 'structural') {
      previous.push({ node: assistant, heading: parent });
      continue;
    }

    // Context = earlier chapters (incl. their generated headings) + the current one.
    const blocks: string[] = previous.map(({ node, heading }) =>
      `Chapter — heading: "${heading.content}"\n\nContent:\n${node.content}`);
    blocks.push(`Chapter — heading: (to be created)\n\nContent:\n${assistant.content}`);

    const slots = await textCompletion(env,
      `${instruction}\n\nThe following chapters are listed in story order. Every chapter already has a heading EXCEPT the LAST one.\nGenerate the heading for the LAST chapter only; use the earlier chapters to match the style.\n\n${blocks.join('\n\n')}\n\nReturn only the heading text.`);
    if (env.signal?.aborted) break;
    const headingContent = (slots.text?.value ?? '').trim();
    if (!headingContent) return { ...slots, error: makeSlot('error', 'http', 'No heading generated.', {}) };

    const heading = await addStructureNode(env, chatId, assistant.parentId, headingContent);
    await chatService.reparentNodes(chatId, [assistant.id], heading.id);
    chatService.setActiveChild(assistant.parentId, heading.id);
    chatService.setActiveChild(heading.id, assistant.id);
    previous.push({ node: assistant, heading });
    createdIds.push(heading.id);
  }

  const lastId = createdIds[createdIds.length - 1] ?? '';
  return structureResult({}, lastId, createdIds);
};

// ---------------------------------------------------------------------------
// language-check — copy-edit a writing direction; returns the RAW model text
// (the caller parses the three variants). No chat mutation.
// ---------------------------------------------------------------------------
const languageCheck: FlowController = async env => {
  const text = (env.cx.vars.content ?? '').trim();
  if (!text) {
    return { error: makeSlot('error', 'http', 'No direction to check.', {}) };
  }
  const instruction = env.factory.englishCheckInstruction();
  return textCompletion(env, `${instruction}\n\nOriginal direction:\n${text}`);
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flowResult(slots: EvalSlots, r: Omit<FlowResult, 'empty'>, empty: boolean): EvalSlots {
  return { ...slots, flow: okSlot({ ...r, empty }, {}) };
}

/** Merge original attachments (with records) + draft images, deduped by dataUrl. */
function carryAttachments(
  original: Array<import('./context').NodeAttachmentLike>,
  draft?: Array<import('./context').NodeAttachmentLike> | null
): Array<import('./context').NodeAttachmentLike> {
  const seen = new Set<string>();
  const out: Array<import('./context').NodeAttachmentLike> = [];
  for (const a of [...(original ?? []), ...(draft ?? [])]) {
    const key = a?.dataUrl || a?.id || a?.name || '';
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Runner facade
// ---------------------------------------------------------------------------

const FLOW_CONTROLLERS: Partial<Record<UsecaseKind, FlowController>> = {
  'send-branch': sendBranch,
  'send-insert': sendInsert,
  'send-regenerate': sendRegenerate,
  'send-rewrite': sendRewrite,
  'send-prepend': sendPrepend,
  'send-elaborate': sendElaborate,
  'structure-title': structureTitle,
  'structure-overview': structureOverview,
  'structure-heading': structureHeading,
  'structure-headings': structureHeadings,
  'language-check': languageCheck
};

export function isFlowUsecase(usecase: UsecaseKind): boolean {
  return !!FLOW_CONTROLLERS[usecase];
}

export function flowControllerFor(usecase: UsecaseKind): FlowController {
  const c = FLOW_CONTROLLERS[usecase];
  if (!c) throw new Error(`No flow controller for ${usecase}`);
  return c;
}

/** Top-level entry for structural text-send flows. */
@Injectable({ providedIn: 'root' })
export class LlmFlowRunner {
  private readonly factory = inject(UsecaseContextFactory);
  private readonly orch = inject(LlmOrchestratorService);
  private readonly chatService = inject(ChatService);

  async run(build: BuildContext, opts: { signal?: AbortSignal; onChunk?: PrimitiveOptions['onChunk'] } = {}): Promise<EvalSlots> {
    const cx = this.factory.buildContext(build);
    // An explicit model override (e.g. a model chosen in a dialog) wins over
    // the node's own model — see `send-elaborate`.
    const write = this.factory.resolveWriteModel(cx.node, build.vars.modelId, build.vars.providerId);
    if (!write || !this.factory.providerFor(write.model)) {
      return { error: makeSlot('error', 'http', 'No writing model is enabled.', {}) };
    }
    const textExtras = await this.factory.resolveTextExtras(write.model, cx.chat);
    const env: FlowEnv = {
      cx,
      factory: this.factory,
      orch: this.orch,
      write,
      textExtras,
      signal: opts.signal,
      onChunk: opts.onChunk,
      chatService: this.chatService
    };
    return flowControllerFor(cx.usecase)(env);
  }
}