import { describe, expect, it } from 'vitest';
import {
  buildLlmMessages,
  buildSeedNodeDrafts,
  nodesAfterDeletingSubtree,
  nodesAfterEditAdopt,
  pathToNode,
  type SeedEnvironmentInput
} from './llm-context';
import { normalizeChatMessages } from './llm-message';
import {
  ChatNode,
  Persona,
  Project,
  Topic
} from '../models/chat';

const NOW = '2026-09-03T00:00:00.000Z';

function topic(partial: Partial<Topic> & Pick<Topic, 'id' | 'name'>): Topic {
  return {
    description: '',
    defaultModelId: null,
    defaultSystemPrompt: '',
    icon: '',
    projectIds: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...partial
  };
}

function project(partial: Partial<Project> & Pick<Project, 'id' | 'name'>): Project {
  return {
    greeting: '',
    systemPrompt: '',
    defaultModelId: null,
    avatar: '',
    personaIds: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...partial
  };
}

function persona(partial: Partial<Persona> & Pick<Persona, 'id' | 'name'>): Persona {
  return {
    shortName: partial.name.slice(0, 2),
    description: '',
    avatar: '',
    createdAt: NOW,
    updatedAt: NOW,
    ...partial
  };
}

function node(partial: Partial<ChatNode> & Pick<ChatNode, 'id' | 'role'>): ChatNode {
  return {
    chatId: 'chat-1',
    parentId: null,
    content: '',
    version: 1,
    isCurrent: true,
    createdAt: NOW,
    ...partial
  };
}

function seed(input: Partial<SeedEnvironmentInput> & Pick<SeedEnvironmentInput, 'project'>): ReturnType<typeof buildSeedNodeDrafts> {
  return buildSeedNodeDrafts({
    topics: [],
    getPersona: () => undefined,
    currentUserPersona: null,
    ...input
  });
}

function roles(drafts: { role: string }[]): string[] {
  return drafts.map(d => d.role);
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((p: { type?: string }) => p.type === 'text')
    .map((p: { text?: string }) => p.text ?? '')
    .join('\n');
}

describe('buildSeedNodeDrafts — topics', () => {
  const env = project({ id: 'env-1', name: 'Castle' });

  it('creates no system node when there are no topics', () => {
    expect(seed({ project: env, topics: [] })).toEqual([]);
  });

  it('ignores a topic that does not list this environment', () => {
    expect(seed({
      project: env,
      topics: [topic({
        id: 't-other',
        name: 'Other',
        defaultSystemPrompt: 'Do not include me',
        projectIds: ['env-other']
      })]
    })).toEqual([]);
  });

  it('ignores a matching topic with an empty system prompt', () => {
    expect(seed({
      project: env,
      topics: [topic({
        id: 't-empty',
        name: 'Empty',
        defaultSystemPrompt: '   ',
        description: 'A topic blurb that must not be sent',
        projectIds: ['env-1']
      })]
    })).toEqual([]);
  });

  it('does not send topic.description even when a system prompt is set', () => {
    const drafts = seed({
      project: env,
      topics: [topic({
        id: 't1',
        name: 'Gothic',
        description: 'TOPIC DESCRIPTION MUST NOT APPEAR',
        defaultSystemPrompt: 'Write gothic prose.',
        projectIds: ['env-1']
      })]
    });
    expect(roles(drafts)).toEqual(['system']);
    expect(drafts[0].content).toBe('Write gothic prose.');
    expect(drafts[0].content).not.toContain('TOPIC DESCRIPTION');
  });

  it('joins several matching topic prompts in topic-list order', () => {
    const drafts = seed({
      project: env,
      topics: [
        topic({ id: 'a', name: 'A', defaultSystemPrompt: 'Prompt A', projectIds: ['env-1'] }),
        topic({ id: 'skip', name: 'Skip', defaultSystemPrompt: 'Nope', projectIds: [] }),
        topic({ id: 'b', name: 'B', defaultSystemPrompt: 'Prompt B', projectIds: ['env-1', 'env-x'] })
      ]
    });
    expect(drafts).toEqual([{ role: 'system', content: 'Prompt A\n\nPrompt B' }]);
  });
});

describe('buildSeedNodeDrafts — environment prompt and greeting', () => {
  it('uses environment systemPrompt as the first user beat, not as system', () => {
    const drafts = seed({
      project: project({ id: 'e', name: 'E', systemPrompt: 'The keep is cold.' })
    });
    expect(drafts).toEqual([{ role: 'user', content: 'The keep is cold.' }]);
  });

  it('uses environment greeting as the first assistant beat', () => {
    const drafts = seed({
      project: project({ id: 'e', name: 'E', greeting: 'Welcome, traveller.' })
    });
    expect(drafts).toEqual([{ role: 'assistant', content: 'Welcome, traveller.' }]);
  });

  it('replaces {{user}} in the greeting with the current persona name', () => {
    const drafts = seed({
      project: project({ id: 'e', name: 'E', greeting: 'Hello {{user}}.' }),
      currentUserPersona: persona({ id: 'u', name: 'Mara' })
    });
    expect(drafts.some(d => d.role === 'assistant' && d.content === 'Hello Mara.')).toBe(true);
    expect(drafts.find(d => d.role === 'user')!.content).toContain('{{user}} is Mara');
  });

  it('leaves {{user}} untouched when no current persona is selected', () => {
    const drafts = seed({
      project: project({ id: 'e', name: 'E', greeting: 'Hello {{user}}.' })
    });
    expect(drafts[0]).toEqual({ role: 'assistant', content: 'Hello {{user}}.' });
  });

  it('chains system + user + greeting when all three are present', () => {
    const drafts = seed({
      project: project({
        id: 'e',
        name: 'E',
        systemPrompt: 'World bible.',
        greeting: 'The door opens.'
      }),
      topics: [topic({
        id: 't',
        name: 'T',
        defaultSystemPrompt: 'Stay in second person.',
        projectIds: ['e']
      })]
    });
    expect(roles(drafts)).toEqual(['system', 'user', 'assistant']);
    expect(drafts[0].content).toBe('Stay in second person.');
    expect(drafts[1].content).toBe('World bible.');
    expect(drafts[2].content).toBe('The door opens.');
  });

  it('appends NPC personas from the environment after the world prompt', () => {
    const npc = persona({ id: 'npc-1', name: 'Ivor', description: 'A mute gatekeeper.' });
    const drafts = seed({
      project: project({
        id: 'e',
        name: 'E',
        systemPrompt: 'World.',
        personaIds: ['npc-1', 'missing']
      }),
      getPersona: id => id === 'npc-1' ? npc : undefined
    });
    expect(drafts[0].role).toBe('user');
    expect(drafts[0].content).toContain('World.');
    expect(drafts[0].content).toContain('npc is Ivor');
    expect(drafts[0].content).toContain('A mute gatekeeper.');
    expect(drafts[0].content).not.toContain('missing');
  });
});

describe('pathToNode / buildLlmMessages — conversation shapes', () => {
  const system = node({ id: 'sys', role: 'system', content: 'Stay gothic.' });
  const setup = node({ id: 'u0', role: 'user', parentId: 'sys', content: 'World bible.' });
  const greet = node({ id: 'a0', role: 'assistant', parentId: 'u0', content: 'The door opens.' });
  const q1 = node({ id: 'u1', role: 'user', parentId: 'a0', content: 'I knock.' });
  const a1 = node({ id: 'a1', role: 'assistant', parentId: 'u1', content: 'A bolt slides.' });
  const q2 = node({ id: 'u2', role: 'user', parentId: 'a1', content: 'I wait.' });
  const a2 = node({ id: 'a2', role: 'assistant', parentId: 'u2', content: 'Rain starts.' });
  const linear = [system, setup, greet, q1, a1, q2, a2];

  it('walks root → target including the system node', () => {
    expect(pathToNode(linear, 'a1').map(n => n.id)).toEqual(['sys', 'u0', 'a0', 'u1', 'a1']);
  });

  it('returns [] when the id is missing', () => {
    expect(pathToNode(linear, 'nope')).toEqual([]);
    expect(pathToNode(linear, null)).toEqual([]);
  });

  it('Send at the leaf: history up to the question parent, then the question', () => {
    const msgs = buildLlmMessages({
      nodes: linear,
      contextParentId: q2.parentId,
      question: q2
    });
    expect(msgs.map(m => [m.role, m.content])).toEqual([
      ['system', 'Stay gothic.'],
      ['user', 'World bible.'],
      ['assistant', 'The door opens.'],
      ['user', 'I knock.'],
      ['assistant', 'A bolt slides.'],
      ['user', 'I wait.']
    ]);
    expect(msgs.at(-1)?.content).not.toBe('Rain starts.');
  });

  it('Regenerate in the middle: drop the answer subtree, resend that question only', () => {
    const after = nodesAfterDeletingSubtree(linear, a1.id);
    expect(after.map(n => n.id)).toEqual(['sys', 'u0', 'a0', 'u1']);

    const msgs = buildLlmMessages({
      nodes: after,
      contextParentId: q1.parentId,
      question: q1
    });
    expect(msgs.map(m => m.content)).toEqual([
      'Stay gothic.',
      'World bible.',
      'The door opens.',
      'I knock.'
    ]);
    expect(msgs.some(m => m.content === 'A bolt slides.')).toBe(false);
    expect(msgs.some(m => m.content === 'I wait.')).toBe(false);
  });

  it('Branch from a mid-thread answer: history includes that answer, not later siblings', () => {
    const branchQ = node({ id: 'u1b', role: 'user', parentId: 'a1', content: 'I shove the door.' });
    const msgs = buildLlmMessages({
      nodes: [...linear, branchQ],
      contextParentId: a1.id,
      question: branchQ
    });
    expect(msgs.map(m => m.content)).toEqual([
      'Stay gothic.',
      'World bible.',
      'The door opens.',
      'I knock.',
      'A bolt slides.',
      'I shove the door.'
    ]);
    expect(msgs.some(m => m.content === 'I wait.')).toBe(false);
  });

  it('Branch from a mid-thread question: sibling under the same parent, original question omitted', () => {
    const sibling = node({ id: 'u1s', role: 'user', parentId: q1.parentId, content: 'I listen instead.' });
    const msgs = buildLlmMessages({
      nodes: [...linear, sibling],
      contextParentId: q1.parentId,
      question: sibling
    });
    expect(msgs.map(m => m.content)).toEqual([
      'Stay gothic.',
      'World bible.',
      'The door opens.',
      'I listen instead.'
    ]);
    expect(msgs.some(m => m.content === 'I knock.')).toBe(false);
  });

  it('skips a retired sibling that is not on the parent chain', () => {
    const oldAnswer = node({
      id: 'a1-old',
      role: 'assistant',
      parentId: 'u1',
      content: 'OLD wording',
      isCurrent: false,
      version: 1
    });
    const msgs = buildLlmMessages({
      nodes: [...linear, oldAnswer],
      contextParentId: q2.parentId,
      question: q2
    });
    expect(msgs.some(m => m.content === 'OLD wording')).toBe(false);
  });

  it('follows an edited node after adoptSubtree reparents children', () => {
    const edited = node({
      id: 'a1-v2',
      role: 'assistant',
      parentId: 'u1',
      content: 'A bolt slides — rewritten.',
      version: 2,
      previousVersionId: 'a1',
      isCurrent: true
    });
    const adopted = nodesAfterEditAdopt(linear, 'a1', edited);
    expect(adopted.find(n => n.id === 'a1')?.isCurrent).toBe(false);
    expect(adopted.find(n => n.id === 'u2')?.parentId).toBe('a1-v2');

    const msgs = buildLlmMessages({
      nodes: adopted,
      contextParentId: 'a1-v2',
      question: q2
    });
    expect(msgs.map(m => m.content)).toContain('A bolt slides — rewritten.');
    expect(msgs.map(m => m.content)).not.toContain('A bolt slides.');
  });

  it('uses a previous version when that version is still the parent', () => {
    const oldAnswer = node({
      id: 'a1-old',
      role: 'assistant',
      parentId: 'u1',
      content: 'Version 1 answer',
      version: 1,
      isCurrent: false
    });
    const branchedFromOld = node({
      id: 'u-from-old',
      role: 'user',
      parentId: 'a1-old',
      content: 'Continue from v1'
    });
    const msgs = buildLlmMessages({
      nodes: [...linear, oldAnswer, branchedFromOld],
      contextParentId: 'a1-old',
      question: branchedFromOld
    });
    expect(msgs.map(m => m.content)).toEqual([
      'Stay gothic.',
      'World bible.',
      'The door opens.',
      'I knock.',
      'Version 1 answer',
      'Continue from v1'
    ]);
  });

  it('passes draft extras over the stored question content (Continue / unsent send)', () => {
    const draft = node({ id: 'draft', role: 'user', parentId: 'a2', content: '' });
    const msgs = buildLlmMessages({
      nodes: [...linear, draft],
      contextParentId: 'a2',
      question: draft,
      extra: { content: 'continue', attachments: [] }
    });
    expect(msgs.at(-1)).toEqual({ role: 'user', content: 'continue' });
    expect(msgs.at(-2)?.content).toBe('Rain starts.');
  });
});

describe('buildLlmMessages — attachments on the path and on the question', () => {
  const png = 'data:image/png;base64,QQ==';

  it('keeps image parts on a historical user node', () => {
    const pictured = node({
      id: 'u-pic',
      role: 'user',
      content: 'See this',
      attachments: [{
        id: 'att-1',
        name: 'door.png',
        mimeType: 'image/png',
        size: 4,
        dataUrl: png
      }]
    });
    const answer = node({ id: 'a-pic', role: 'assistant', parentId: 'u-pic', content: 'Noted.' });
    const next = node({ id: 'u-next', role: 'user', parentId: 'a-pic', content: 'And then?' });

    const raw = buildLlmMessages({
      nodes: [pictured, answer, next],
      contextParentId: 'a-pic',
      question: next
    });
    const msgs = normalizeChatMessages(raw);

    expect(Array.isArray(msgs[0].content)).toBe(true);
    const parts = msgs[0].content as Array<{ type: string }>;
    expect(parts.map(p => p.type)).toEqual(['text', 'image_url']);
    expect(msgs[1].content).toBe('Noted.');
    expect(msgs[2].content).toBe('And then?');
  });

  it('attaches files on the question being sent, not on later descendants', () => {
    const q = node({
      id: 'q',
      role: 'user',
      content: 'Read this',
      attachments: [{
        id: 'att-2',
        name: 'lore.txt',
        mimeType: 'text/plain',
        size: 5,
        dataUrl: 'data:text/plain;base64,' + btoa('hidden lore')
      }]
    });
    const later = node({
      id: 'later',
      role: 'assistant',
      parentId: 'q',
      content: 'should not be sent when regenerating q'
    });
    const after = nodesAfterDeletingSubtree([q, later], later.id);
    const msgs = buildLlmMessages({
      nodes: after,
      contextParentId: q.parentId,
      question: q
    });
    expect(msgs).toHaveLength(1);
    expect(textOf(msgs[0].content)).toContain('hidden lore');
    expect(msgs.some(m => m.content === 'should not be sent when regenerating q')).toBe(false);
  });
});

describe('end-to-end: seed then send / regenerate / branch', () => {
  it('a new environment story with topics + greeting, then a first user question', () => {
    const drafts = buildSeedNodeDrafts({
      project: project({
        id: 'keep',
        name: 'Keep',
        systemPrompt: 'Stone halls.',
        greeting: '{{user}} steps inside.'
      }),
      topics: [
        topic({ id: 'goth', name: 'Goth', defaultSystemPrompt: 'Gothic voice.', projectIds: ['keep'] }),
        topic({ id: 'quiet', name: 'Quiet', description: 'unused', projectIds: ['keep'] })
      ],
      getPersona: () => undefined,
      currentUserPersona: persona({ id: 'u', name: 'Len' })
    });

    const seeded: ChatNode[] = [];
    let parent: string | null = null;
    drafts.forEach((d, i) => {
      const n = node({ id: `s${i}`, role: d.role, parentId: parent, content: d.content });
      seeded.push(n);
      parent = n.id;
    });

    const question = node({ id: 'q', role: 'user', parentId: parent, content: 'I look up.' });
    const msgs = buildLlmMessages({
      nodes: [...seeded, question],
      contextParentId: question.parentId,
      question
    });

    expect(msgs[0]).toEqual({ role: 'system', content: 'Gothic voice.' });
    expect(msgs[1].role).toBe('user');
    expect(msgs[1].content).toContain('Stone halls.');
    expect(msgs[1].content).toContain('{{user}} is Len');
    expect(msgs[2]).toEqual({ role: 'assistant', content: 'Len steps inside.' });
    expect(msgs[3]).toEqual({ role: 'user', content: 'I look up.' });
  });
});
