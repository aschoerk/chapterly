import {
  Persona,
  Project,
  Topic
} from '../../models/chat';

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



