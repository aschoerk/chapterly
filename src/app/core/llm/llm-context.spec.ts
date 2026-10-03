import { describe, expect, it } from 'vitest';
import {
  buildSeedNodeDrafts,
  type SeedEnvironmentInput
} from './llm-context';
import {
  Persona,
  Project,
  Topic
} from '../../models/chat';
import {
  makePersona,
  makeProject,
  makeTopic
} from '../../../../test-helpers/factories';

const NOW = '2026-09-03T00:00:00.000Z';

// Deterministic wrappers over the shared test-helpers factories: llm-context
// freezes timestamps at NOW so its serialization assertions are stable.
function topic(partial: Partial<Topic> = {}): Topic {
  return makeTopic({ createdAt: NOW, updatedAt: NOW, ...partial });
}

function project(partial: Partial<Project> = {}): Project {
  return makeProject({ createdAt: NOW, updatedAt: NOW, ...partial });
}

function persona(partial: Partial<Persona> = {}): Persona {
  return makePersona({
    createdAt: NOW,
    updatedAt: NOW,
    shortName: partial.name?.slice(0, 2),
    ...partial
  });
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

