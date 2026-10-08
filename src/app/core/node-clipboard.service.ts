import { Injectable, computed, inject, signal } from '@angular/core';
import { ChatNode, NodeAttachment, NodeRole } from '../models/chat';
import { ChatService } from './chat.service';

/**
 * Client-side clipboard for ChatNodes.
 *
 * Lets the user copy / cut a section (or a section with its whole following
 * text) and paste it into another place of the same chat or into a different
 * chat on the same client. The payload survives reloads/chat switches via
 * localStorage — it never leaves the browser.
 *
 * Paste semantics: the copied subtree is re-created node by node under the
 * chosen target parent, remapping parent pointers (same replay logic as the
 * bundle importer). Only the current content is copied; version history
 * (previousVersionId) is intentionally not carried over.
 */
export type ClipboardAction = 'copy' | 'cut';

const LS_KEY = 'chat.nodeClipboard.v1';
const FORMAT = 'chapterly.nodeClipboard';
const VERSION = 1;

/** Serializable node held on the clipboard. `id` is the source id and is only
 *  used to remap `parentId` when pasting. */
export interface ClipboardNode {
  id: string;
  parentId: string | null;
  role: NodeRole;
  content: string;
  thinking?: string | null;
  modelId?: string | null;
  providerId?: string | null;
  attachments?: NodeAttachment[];
  chatParametersId?: string | null;
}

export interface ClipboardEntry {
  format: typeof FORMAT;
  version: typeof VERSION;
  action: ClipboardAction;
  sourceChatId: string | null;
  nodes: ClipboardNode[];
}

function toClipboardNode(n: ChatNode): ClipboardNode {
  return {
    id: n.id,
    parentId: n.parentId,
    role: n.role,
    content: n.content ?? '',
    thinking: n.thinking ?? null,
    modelId: n.modelId ?? null,
    providerId: n.providerId ?? null,
    attachments: n.attachments ?? [],
    chatParametersId: n.chatParametersId ?? null,
  };
}

function isClipboardEntry(v: unknown): v is ClipboardEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Partial<ClipboardEntry>;
  return (
    e.format === FORMAT &&
    e.version === VERSION &&
    (e.action === 'copy' || e.action === 'cut') &&
    Array.isArray(e.nodes)
  );
}

@Injectable({ providedIn: 'root' })
export class NodeClipboardService {
  private readonly chatService = inject(ChatService);

  /** The current clipboard payload (null = empty). */
  readonly clipboard = signal<ClipboardEntry | null>(this.readFromStorage());

  readonly hasContent = computed(() => this.clipboard() !== null);
  readonly count = computed(() => this.clipboard()?.nodes.length ?? 0);
  readonly rootRole = computed(() => this.clipboard()?.nodes[0]?.role ?? null);
  readonly action = computed(() => this.clipboard()?.action ?? null);

  private readFromStorage(): ClipboardEntry | null {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as unknown;
      return isClipboardEntry(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private save(entry: ClipboardEntry | null): void {
    if (entry) {
      this.clipboard.set(entry);
      localStorage.setItem(LS_KEY, JSON.stringify(entry));
    } else {
      this.clipboard.set(null);
      localStorage.removeItem(LS_KEY);
    }
  }

  private collectSubtree(rootId: string): ChatNode[] {
    const all = this.chatService.nodes();
    const out: ChatNode[] = [];
    const walk = (id: string) => {
      const n = all.find((x) => x.id === id);
      if (!n) return;
      out.push(n);
      all.filter((x) => x.parentId === id).forEach((child) => walk(child.id));
    };
    walk(rootId);
    return out;
  }

  /** Copy a single node (without its following text/branch). */
  copy(node: ChatNode): void {
    this.save({
      format: FORMAT,
      version: VERSION,
      action: 'copy',
      sourceChatId: node.chatId,
      nodes: [toClipboardNode(node)],
    });
  }

  /** Copy a node plus its whole descendant subtree (the continuation). */
  copySubtree(node: ChatNode): void {
    this.save({
      format: FORMAT,
      version: VERSION,
      action: 'copy',
      sourceChatId: node.chatId,
      nodes: this.collectSubtree(node.id).map(toClipboardNode),
    });
  }

  /** Copy an ordered list of nodes WITHOUT their subtrees (navbar multi-selection). */
  copySequence(nodes: ChatNode[]): void {
    if (!nodes.length) return;
    this.save({
      format: FORMAT,
      version: VERSION,
      action: 'copy',
      sourceChatId: nodes[0].chatId,
      nodes: nodes.map(toClipboardNode),
    });
  }

  /** Cut a single node: copy it, then remove it (children stay in the thread). */
  async cut(node: ChatNode): Promise<void> {
    this.copy(node);
    await this.chatService.deleteNode(node.chatId, node.id, { keepChildren: true });
  }

  /** Cut a node + subtree: copy the continuation, then delete it entirely. */
  async cutSubtree(node: ChatNode): Promise<void> {
    this.copySubtree(node);
    await this.chatService.deleteNode(node.chatId, node.id);
  }

  /** Cut an ordered list of nodes (no subtrees): copy them, then remove each. */
  async cutSequence(nodes: ChatNode[]): Promise<void> {
    if (!nodes.length) return;
    this.copySequence(nodes);
    // Topmost-first (path order): children of a removed node attach to its parent.
    for (const node of nodes) {
      await this.chatService.deleteNode(node.chatId, node.id, { keepChildren: true });
    }
  }

  clear(): void {
    this.save(null);
  }

  /** Create the copied nodes as new nodes under `parentId`, remapping parent
   *  pointers so the copied chain/tree links are preserved. Returns the root,
   *  the last (deepest) created node and every created root id. */
  private async createNodes(
    chatId: string,
    entry: ClipboardEntry,
    parentId: string | null,
  ): Promise<{ root: ChatNode; last: ChatNode; rootIds: string[] } | null> {
    const idMap = new Map<string, string>();
    let root: ChatNode | null = null;
    let last: ChatNode | null = null;
    const rootIds: string[] = [];
    const pending = entry.nodes.slice();

    while (pending.length) {
      const idx = pending.findIndex((n) => !n.parentId || idMap.has(n.parentId));
      const node = pending.splice(idx < 0 ? 0 : idx, 1)[0];
      const parentKey = node.parentId ?? null;
      const isRoot = parentKey === null || !idMap.has(parentKey);
      const nodeParentId =
        parentKey !== null && idMap.has(parentKey) ? idMap.get(parentKey)! : parentId;

      const created = await this.chatService.addNode(chatId, {
        parentId: nodeParentId,
        role: node.role,
        content: node.content,
        thinking: node.thinking ?? undefined,
        modelId: node.modelId ?? undefined,
        providerId: node.providerId ?? undefined,
        attachments: node.attachments,
        chatParametersId: node.chatParametersId ?? null,
      });
      idMap.set(node.id, created.id);
      if (!root) root = created;
      last = created;
      if (isRoot) rootIds.push(created.id);
    }
    return root && last ? { root, last, rootIds } : null;
  }

  /**
   * Paste the clipboard in the currently selected chat.
   *
   * When `afterNodeId` is given, the pasted sequence is inserted right after
   * that sibling (its parent is the target parent). Otherwise the sequence is
   * appended under `targetParentId` (null = top of the story). Precise ordering
   * is persisted via a sibling reorder.
   */
  async paste(targetParentId: string | null, afterNodeId?: string | null): Promise<ChatNode | null> {
    const entry = this.clipboard();
    const chatId = this.chatService.currentChatId();
    if (!entry || !chatId) return null;

    const parentId = afterNodeId
      ? this.chatService.currentNodes().find(n => n.id === afterNodeId)?.parentId ?? null
      : targetParentId;

    const created = await this.createNodes(chatId, entry, parentId);
    if (!created) return null;
    const { root, rootIds } = created;

    // Insert the sequence after `afterNodeId` (or append at the end of the siblings).
    const siblings = this.chatService
      .getChildren(parentId)
      .filter((n) => !rootIds.includes(n.id))
      .map((n) => n.id);
    let insertAt = siblings.length;
    if (afterNodeId) {
      const i = siblings.findIndex((id) => id === afterNodeId);
      if (i >= 0) insertAt = i + 1;
    }
    const finalOrder = [
      ...siblings.slice(0, insertAt),
      ...rootIds,
      ...siblings.slice(insertAt),
    ];
    await this.chatService.reorderSiblings(chatId, parentId, finalOrder);
    this.chatService.setActiveChild(parentId, root.id);
    return root;
  }

  /**
   * Insert the clipboard chain into the ACTIVE PATH (linear reading order)
   * directly between the two visible nav-bar nodes around the paste button:
   *
   *     leftId → [chain] → rightId
   *
   * The chain's root hangs under `leftId` and `rightId` (the node that used to
   * follow `leftId`) is re-hung under the chain's LAST node, so the visible
   * navbar/tree keeps a continuous chain. When `rightId` is null the chain is
   * simply appended behind `leftId` (leftId → [chain]).
   */
  async insertIntoPath(leftId: string, rightId: string | null): Promise<ChatNode | null> {
    const entry = this.clipboard();
    const chatId = this.chatService.currentChatId();
    if (!entry || !chatId) return null;

    const created = await this.createNodes(chatId, entry, leftId);
    if (!created) return null;
    const { root } = created;

    // The right visible node continues under the chain's last node so the
    // active path stays continuous: leftId → chain → rightId.
    if (rightId && rightId !== leftId) {
      await this.chatService.reparentNodes(chatId, [rightId], created.last.id);
    }

    // Order the chain root first among leftId's children (persisted) and make
    // it the active continuation.
    const siblings = this.chatService.getChildren(leftId).map(n => n.id);
    const finalOrder = [root.id, ...siblings.filter(id => id !== root.id)];
    if (finalOrder.length > 1) {
      await this.chatService.reorderSiblings(chatId, leftId, finalOrder);
    }
    this.chatService.setActiveChild(leftId, root.id);
    return root;
  }
}