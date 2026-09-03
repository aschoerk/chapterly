import {
  ChatMessage,
  ChatNode,
  NodeAttachment,
  Persona,
  Project,
  Topic
} from '../models/chat';
import { nodeToMessageContent } from './llm-message';

export interface SeedNodeDraft {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface SeedEnvironmentInput {
  project: Pick<Project, 'id' | 'systemPrompt' | 'greeting' | 'personaIds'>;
  topics: Array<Pick<Topic, 'id' | 'defaultSystemPrompt' | 'description' | 'projectIds'>>;
  getPersona: (id: string) => Persona | undefined;
  currentUserPersona: Persona | null | undefined;
}

/**
 * Nodes created when a story is opened under an environment (project).
 * Linear chain: optional system → optional user → optional greeting assistant.
 *
 * Topics contribute only `defaultSystemPrompt` (description is not sent).
 * The environment contributes `systemPrompt` as the first user beat and
 * `greeting` as the first assistant beat.
 */
export function buildSeedNodeDrafts(input: SeedEnvironmentInput): SeedNodeDraft[] {
  const { project, topics, getPersona, currentUserPersona } = input;
  const drafts: SeedNodeDraft[] = [];

  const systemParts: string[] = [];
  for (const topic of topics) {
    if (!topic.defaultSystemPrompt?.trim()) continue;
    if (!topic.projectIds?.some(id => id === project.id)) continue;
    systemParts.push(topic.defaultSystemPrompt.trim());
  }
  if (systemParts.length > 0) {
    drafts.push({ role: 'system', content: systemParts.join('\n\n').trim() });
  }

  const userParts: string[] = [];
  if (project.systemPrompt?.trim()) {
    userParts.push(project.systemPrompt.trim());
  }

  for (const personaId of project.personaIds ?? []) {
    const persona = getPersona(personaId);
    if (!persona) continue;
    userParts.push(`\n\nnpc is ${persona.name}`);
    if (persona.description?.trim()) {
      userParts.push(persona.description.trim());
    }
  }

  const userPersona = currentUserPersona ?? null;
  if (userPersona) {
    userParts.push(`\n\n{{user}} is ${userPersona.name}`);
    if (userPersona.description?.trim()) {
      userParts.push(userPersona.description.trim());
    }
  }

  const userContent = userParts.join('\n\n').trim();
  if (userContent) {
    drafts.push({ role: 'user', content: userContent });
  }

  if (project.greeting?.trim()) {
    const greeting = userPersona?.name
      ? project.greeting.replace('{{user}}', userPersona.name)
      : `${project.greeting}`.trim();
    drafts.push({ role: 'assistant', content: greeting });
  }

  return drafts;
}

/** Root → nodeId following parentId links. Includes retired versions if they sit on the chain. */
export function pathToNode(nodes: ChatNode[], nodeId: string | null | undefined): ChatNode[] {
  if (!nodeId) return [];
  const map = new Map(nodes.map(n => [n.id, n]));
  const path: ChatNode[] = [];
  let cur: ChatNode | undefined = map.get(nodeId);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    path.unshift(cur);
    cur = cur.parentId ? map.get(cur.parentId) : undefined;
  }
  return path;
}

export interface BuildLlmMessagesInput {
  nodes: ChatNode[];
  /** Last ancestor included in history (the question's parent, or an answer when branching from it). */
  contextParentId: string | null;
  question: Pick<ChatNode, 'content' | 'attachments' | 'role'>;
  extra?: { content?: string; attachments?: NodeAttachment[] };
}

/**
 * Messages handed to the LLM for Send / Branch / Regenerate / Continue.
 * History is the parent chain up to `contextParentId`. Descendants below
 * that point — including a regenerated answer — are omitted. The question
 * is always appended as a user message (attachments via nodeToMessageContent).
 */
export function buildLlmMessages(input: BuildLlmMessagesInput): ChatMessage[] {
  const history = pathToNode(input.nodes, input.contextParentId).map(n => ({
    role: n.role,
    content: nodeToMessageContent(n)
  }));

  const question: Pick<ChatNode, 'content' | 'attachments'> = input.extra
    ? {
        content: input.extra.content ?? input.question.content,
        attachments: input.extra.attachments ?? input.question.attachments
      }
    : input.question;

  history.push({
    role: 'user',
    content: nodeToMessageContent(question)
  });
  return history;
}

/** Simulate regenerate: drop the answer and its descendants, then rebuild. */
export function nodesAfterDeletingSubtree(nodes: ChatNode[], rootId: string): ChatNode[] {
  const drop = new Set<string>();
  const walk = (id: string) => {
    drop.add(id);
    for (const child of nodes.filter(n => n.parentId === id)) walk(child.id);
  };
  walk(rootId);
  return nodes.filter(n => !drop.has(n.id));
}

/** Simulate edit+adopt: retire oldId, insert saved, reparent direct children. */
export function nodesAfterEditAdopt(
  nodes: ChatNode[],
  oldId: string,
  saved: ChatNode
): ChatNode[] {
  return nodes
    .map(n => {
      if (n.id === oldId && saved.id !== oldId) return { ...n, isCurrent: false };
      if (n.parentId === oldId) return { ...n, parentId: saved.id };
      return n;
    })
    .filter(n => n.id !== saved.id)
    .concat(saved);
}
