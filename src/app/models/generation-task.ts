/**
 * Per-task AI generation settings: which provider/model + prompt to use for
 * the automated authoring tasks (titles, headings, overviews, image creation
 * and image interpretation).
 *
 * These configs are used as the "which model did the user pick" preference for
 * each task. An empty providerId / modelId means "inherit" — the caller falls
 * back to the default model of the active environment/topic.
 */

export type GenerationTaskKind =
  | 'title'           // chat / story titles
  | 'headings'        // chapter / section headings
  | 'overview'        // summaries / overviews
  | 'image-create'    // text  -> image
  | 'image-interpret'; // image -> text (describing what the image shows)

export interface GenerationTaskConfig {
  kind: GenerationTaskKind;
  /** Provider id from SettingsService.providers(); '' = inherit / unset. */
  providerId: string;
  /** Provider model string (e.g. "anthropic/claude-3.5-sonnet"); '' = inherit / unset. */
  modelId: string;
  /** Prompt template sent for this task. Leave empty to use the built-in default. */
  prompt: string;
}

export const GENERATION_TASK_KINDS: GenerationTaskKind[] = [
  'title',
  'headings',
  'overview',
  'image-create',
  'image-interpret'
];

export function emptyGenerationTaskConfig(kind: GenerationTaskKind): GenerationTaskConfig {
  return { kind, providerId: '', modelId: '', prompt: '' };
}