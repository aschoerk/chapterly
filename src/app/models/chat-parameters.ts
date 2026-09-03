export type ThinkingLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type ParametersOwnerType = 'model' | 'topic' | 'project' | 'chat' | 'chat_node';

export interface ChatParameters {
  id: string;
  name: string;
  temperature: number | null;
  topK: number | null;
  topM: number | null;
  topP?: number | null;
  stream: boolean | null;
  thinking: boolean | null;
  thinkingLevel: ThinkingLevel | null;
  reasoningEffort?: ThinkingLevel | null;
  createdAt?: string;
  updatedAt?: string;
}

/** Form draft before it has been persisted. */
export interface ChatParametersDraft {
  name?: string;
  temperature: number | null;
  topK: number | null;
  topM: number | null;
  stream: boolean | null;
  thinking: boolean | null;
  thinkingLevel: ThinkingLevel | null;
}

export interface ResolvedChatParameters extends ChatParametersDraft {
  source: ParametersOwnerType | 'default';
  sourceId?: string | null;
  layers: Array<{ type: ParametersOwnerType; id: string; params: ChatParameters }>;
}

export const THINKING_LEVELS: ThinkingLevel[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export function emptyParametersDraft(): ChatParametersDraft {
  return {
    name: '',
    temperature: null,
    topK: null,
    topM: null,
    stream: null,
    thinking: null,
    thinkingLevel: null
  };
}

export function draftFromParameters(row: ChatParameters | null | undefined): ChatParametersDraft {
  if (!row) return emptyParametersDraft();
  return {
    name: row.name || '',
    temperature: row.temperature ?? null,
    topK: row.topK ?? null,
    topM: row.topM ?? row.topP ?? null,
    stream: row.stream ?? null,
    thinking: row.thinking ?? null,
    thinkingLevel: row.thinkingLevel ?? row.reasoningEffort ?? null
  };
}

export function isDraftEmpty(draft: ChatParametersDraft | null | undefined): boolean {
  if (!draft) return true;
  return draft.temperature == null
    && draft.topK == null
    && draft.topM == null
    && draft.stream == null
    && draft.thinking == null
    && !draft.thinkingLevel;
}

export function mergeParameters(
  layers: Array<{ type: ParametersOwnerType; id: string; params: ChatParameters }>
): ResolvedChatParameters {
  const acc: ChatParametersDraft = emptyParametersDraft();
  let source: ParametersOwnerType | 'default' = 'default';
  let sourceId: string | null = null;

  for (const layer of layers) {
    const p = layer.params;
    let used = false;
    if (p.temperature != null) { acc.temperature = p.temperature; used = true; }
    if (p.topK != null) { acc.topK = p.topK; used = true; }
    if (p.topM != null || p.topP != null) { acc.topM = p.topM ?? p.topP ?? null; used = true; }
    if (p.stream != null) { acc.stream = p.stream; used = true; }
    if (p.thinking != null) { acc.thinking = p.thinking; used = true; }
    if (p.thinkingLevel || p.reasoningEffort) {
      acc.thinkingLevel = p.thinkingLevel ?? p.reasoningEffort ?? null;
      used = true;
    }
    if (used) {
      source = layer.type;
      sourceId = layer.id;
    }
  }

  return { ...acc, source, sourceId, layers };
}

export function formatParametersSummary(p: ChatParametersDraft | ResolvedChatParameters | null | undefined): string {
  if (!p) return 'defaults';
  const parts: string[] = [];
  if (p.temperature != null) parts.push(`temp ${p.temperature}`);
  if (p.topK != null) parts.push(`top_k ${p.topK}`);
  if (p.topM != null) parts.push(`top_m ${p.topM}`);
  if (p.stream != null) parts.push(p.stream ? 'stream' : 'no stream');
  if (p.thinking != null) parts.push(p.thinking ? 'think' : 'no think');
  if (p.thinkingLevel) parts.push(p.thinkingLevel);
  return parts.length ? parts.join(' · ') : 'defaults';
}
