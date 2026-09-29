/**
 * Shared "story document" enumeration for chapterly.
 *
 * Single source of truth for turning a chat's flat node list into root→leaf
 * documents. Used by BOTH the chat-reader (book pagination) and the DOCX /
 * Markdown exporters so they always agree.
 *
 * Semantics:
 *  - Only the YOUNGEST member of each version family (chains linked by
 *    `previousVersionId`) is used; older versions are ignored and their
 *    children are re-homed onto the youngest.
 *  - Documents are built by a plain depth-first walk that CLONES the path
 *    from the root at every fork, so each sibling branch becomes its own
 *    complete document (nothing is shared or interleaved).
 *  - Empty nodes are transparent connectors (kept for structure, not
 *    rendered); empty childless leaves (drafts) are dropped.
 *  - Nodes whose parent is missing/ignored are treated as roots so no
 *    content silently vanishes.
 */
import { ChatNode } from '../models/chat';
import { isPromptRecordAttachment } from './llm/llm-message';

export function isUsableNode(n: ChatNode): boolean {
  // Recorded image prompts (prompt-N.txt / refused-prompt-N.txt) are internal
  // illustration metadata — a node that only carries those has no story payload.
  if (n.content?.trim()) return true;
  return (n.attachments || []).some(a => !isPromptRecordAttachment(a));
}

export function storyNodeTimestamp(n: ChatNode): number {
  const t = Date.parse(n.createdAt || n.updatedAt || '');
  return Number.isFinite(t) ? t : 0;
}

function childIdsByParent(nodes: ChatNode[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const n of nodes) {
    if (!n.parentId) continue;
    const list = map.get(n.parentId) ?? [];
    list.push(n.id);
    map.set(n.parentId, list);
  }
  return map;
}

/** Empty node with no children: a draft leaf, not a document version. */
function isEmptyLeaf(n: ChatNode, childIds: Map<string, string[]>): boolean {
  return !isUsableNode(n) && !(childIds.get(n.id)?.length);
}

/** True when `a` is a newer version than `b` (higher version, else newer ts). */
function isYounger(a: ChatNode, b: ChatNode): boolean {
  const va = a.version ?? 1;
  const vb = b.version ?? 1;
  if (va !== vb) return va > vb;
  return storyNodeTimestamp(a) > storyNodeTimestamp(b);
}

/**
 * Group nodes into version families, then map EVERY node id to its family's
 * youngest member. Older versions are ignored: only the youngest can appear in
 * a document, and children pointing at an older version are re-homed onto the
 * youngest.
 */
function versionRepresentatives(nodes: ChatNode[]): Map<string, ChatNode> {
  const byId = new Map<string, ChatNode>(
    nodes.map(n => [n.id, n] as [string, ChatNode])
  );
  const rep = new Map<string, ChatNode>();

  // family root = oldest ancestor reachable through previousVersionId
  const familyOf = new Map<string, ChatNode[]>();
  for (const n of nodes) {
    let cur: ChatNode | undefined = n;
    const seen = new Set<string>();
    while (cur?.previousVersionId && !seen.has(cur.id)) {
      seen.add(cur.id);
      const ancestor: ChatNode | undefined = byId.get(cur.previousVersionId);
      if (!ancestor) break; // corrupted / missing link
      cur = ancestor;
    }
    const key = cur?.id ?? n.id;
    const fam = familyOf.get(key) ?? [];
    fam.push(n);
    familyOf.set(key, fam);
  }

  for (const fam of familyOf.values()) {
    let youngest = fam[0];
    for (const m of fam) {
      if (isYounger(m, youngest)) youngest = m;
    }
    for (const m of fam) rep.set(m.id, youngest);
  }
  return rep;
}

/**
 * All story documents as root→leaf paths (youngest-version DFS with path
 * cloning). See module doc for full semantics.
 */
export function enumerateStoryDocuments(allNodes: ChatNode[]): ChatNode[][] {
  const childIds = childIdsByParent(allNodes);

  // Keep empty nodes that still have children so the chain stays connected.
  // Drop empty childless nodes — drafts must never become documents.
  const kept = allNodes.filter(n => !isEmptyLeaf(n, childIds));

  // Collapse each version family to its youngest representative.
  const rep = versionRepresentatives(kept);
  const nodes = kept.filter(n => (rep.get(n.id) ?? n).id === n.id);
  const byId = new Map<string, ChatNode>(
    nodes.map(n => [n.id, n] as [string, ChatNode])
  );

  // Children keyed by the *youngest* parent version id. Children that point
  // at an older version are re-homed onto the youngest automatically.
  const kids = new Map<string, ChatNode[]>();
  const addKid = (parentId: string, child: ChatNode) => {
    const list = kids.get(parentId) ?? [];
    if (!list.some(n => n.id === child.id)) list.push(child);
    kids.set(parentId, list);
  };

  for (const n of kept) {
    if (!n.parentId) continue;
    const parentRep = rep.get(n.parentId);
    if (!parentRep || !byId.has(parentRep.id)) continue; // dangling → root below
    const childRep = rep.get(n.id) ?? n;
    if (!byId.has(childRep.id)) continue;
    addKid(parentRep.id, childRep);
  }

  // Deterministic reading order: oldest sibling first.
  for (const list of kids.values()) {
    list.sort((a, b) => storyNodeTimestamp(a) - storyNodeTimestamp(b));
  }

  // Roots = real roots plus orphans whose parent is missing/ignored.
  const roots = nodes
    .filter(n => {
      if (!n.parentId) return true;
      const parentRep = rep.get(n.parentId);
      return !parentRep || !byId.has(parentRep.id);
    })
    .sort((a, b) => storyNodeTimestamp(a) - storyNodeTimestamp(b));

  const paths: ChatNode[][] = [];

  // Straightforward depth-first walk. `next` is a fresh clone of the path so
  // each child branch starts from the full root prefix — backtracking can
  // never mix branches.
  const walk = (node: ChatNode, acc: ChatNode[]) => {
    const structuralOnly = !isUsableNode(node);
    const next = structuralOnly ? acc : [...acc, node];
    const children = kids.get(node.id) ?? [];
    if (children.length === 0) {
      if (!structuralOnly) paths.push(next);
      return;
    }
    for (const child of children) {
      walk(child, next);
    }
  };

  for (const root of roots) walk(root, []);

  return paths;
}

/**
 * Pick the document whose nodes include the globally MOST RECENT node
 * (highest updatedAt/createdAt). Ties are broken by longer path, then the
 * path containing the newest tip. Falls back to the first path when empty.
 */
export function pickMostRecentDocument(paths: ChatNode[][]): ChatNode[] {
  let best: ChatNode[] = [];
  let bestMaxTs = -1;
  let bestLen = 0;
  for (const p of paths) {
    let maxTs = -1;
    for (const n of p) maxTs = Math.max(maxTs, storyNodeTimestamp(n));
    const len = p.length;
    const newestTip = p.length ? storyNodeTimestamp(p[p.length - 1]) : -1;
    const bestNewestTip = best.length ? storyNodeTimestamp(best[best.length - 1]) : -1;
    if (
      !best.length ||
      maxTs > bestMaxTs ||
      (maxTs === bestMaxTs && len > bestLen) ||
      (maxTs === bestMaxTs && len === bestLen && newestTip > bestNewestTip)
    ) {
      best = p;
      bestMaxTs = maxTs;
      bestLen = len;
    }
  }
  return best;
}