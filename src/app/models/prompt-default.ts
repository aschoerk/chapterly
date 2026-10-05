/**
 * Catalog of the AUTOMATICALLY-GENERATED prompt templates the app sends to
 * LLMs (title/overview/headings/elaborate, image generation parts, language
 * check). The user can view and override each template in Settings → Prompt
 * defaults. A template may contain `{{placeholder}}` tokens, which the code
 * fills in at call time (e.g. `{{total}}` for the number of images, `{{index}}`
 * for the scene number, `{{chapter}}`/`{{name}}` for elaboration, and
 * `{{descriptions}}` for the numbered list of derived picture descriptions).
 *
 * Prompts are intentionally English-only (no i18n).
 */

export type PromptDefaultCategory = 'structure' | 'image' | 'language';

export interface PromptDefaultDef {
  /** Stable id used for lookup + localStorage key. */
  id: string;
  category: PromptDefaultCategory;
  /** English label shown in Settings. */
  label: string;
  /** Optional English explanation shown in Settings. */
  description?: string;
  /** Built-in default template (may contain {{placeholders}}). */
  default: string;
}

export const PROMPT_DEFAULT_CATEGORIES: PromptDefaultCategory[] = [
  'structure',
  'image',
  'language'
];

/**
 * ALL editable auto-prompt templates. Keep the DEFAULT text identical to the
 * legacy hard-coded prompts so the built-in behavior is unchanged.
 */
export const PROMPT_DEFAULTS: PromptDefaultDef[] = [
  // ---------------------------------------------------------------- structure
  {
    id: 'structure.title',
    category: 'structure',
    label: 'Story title',
    description: 'Used by the "Title" button. Model must output plain text.',
    default:
      'Generate a concise title for this story.'
  },
  {
    id: 'structure.overview',
    category: 'structure',
    label: 'Introduction / overview',
    description: 'Used by the "Introduction" button. Model must output plain text.',
    default:
      'Write an engaging introduction to this story.'
  },
  {
    id: 'structure.headings',
    category: 'structure',
    label: 'Chapter / section headings',
    description: 'Used by the "Heading" buttons. Model must output plain text.',
    default:
      'Generate a concise chapter or section heading for this point in the story.'
  },
  {
    id: 'structure.elaborate',
    category: 'structure',
    label: 'Elaborate chapter (no characters)',
    description: 'One generic elaboration prompt per chapter. `{{chapter}}` is the 1-based chapter number.',
    default:
      'elaborate on chapter {{chapter}}'
  },
  {
    id: 'structure.elaborate-view',
    category: 'structure',
    label: 'Elaborate chapter (from a character)',
    description: 'One elaboration prompt per named character, first person. `{{chapter}}` and `{{name}}` are replaced at call time.',
    default:
      'elaborate on chapter {{chapter}} out of the view of {{name}} in first person. Do never repeat text verbatim from previous views in the same chapter.'
  },
  {
    id: 'structure.prepend',
    category: 'structure',
    label: 'Director instruction (with Characters)',
    description: 'Prepended in front of the story context when the direction-node "Prepend" toggle is on. `{{characters}}` is the Elaborate Characters string.',
    default:
      `Assume the events described after **** are lying in the future.
Describe what happens up to that moment, in no way preclude any of those events, happening. 
Narrate in the first person (speak as "I"), 
from the point of view of someone who is outside and above the views of the named 
characters: {{characters}}.

****
`
  },
  {
    id: 'structure.prepend-basic',
    category: 'structure',
    label: 'Director instruction (no Characters)',
    description: 'Used when the Elaborate Characters string is empty.',
    default:
      `Assume the events described after **** are lying in the future. 
Describe what happens up to that moment, in no way preclude any of those events, happening.

****
`
  },

  // ------------------------------------------------------------------- image
  {
    id: 'image.create',
    category: 'image',
    label: 'Image creation (drawing instruction)',
    description: 'The default "how to draw" instruction that heads every generated picture. A custom prompt in Generation Tasks → Image creation overrides this.',
    default: `Illustrate this beat of the story as a single coherent picture.

The earlier chapters are the established context; the cue below is the scene to depict.

Rules:
- Stay faithful to the characters, setting, objects, mood and style already established in the earlier chapters.
- Keep character appearance, setting and style consistent with any previous illustrations.
- Prefer a painterly, atmospheric composition. No text, captions or speech bubbles inside the image unless the cue explicitly asks for a sign.
- Return the image only — no commentary.`
  },
  {
    id: 'image.interpret',
    category: 'image',
    label: 'Image interpretation',
    description: 'Sent to the image-interpret model to describe attached images before the writing model sees the direction.',
    default: `Describe every attached image in detail so a writing model that cannot see images can continue the story correctly. For each image state: what is shown, the setting, characters (appearance, expression, pose), objects, text or signs, mood, colors and composition, and any detail that matters for the next paragraph. Be factual, do not invent plot.
Use at least 1000 tokens for description of characters if there are some in the image.
If several images are attached, describe them one by one.`
  },
  {
    id: 'image.storyboard',
    category: 'image',
    label: 'Storyboard — per-scene instruction',
    description: 'Appended when a storyboard (more than one picture) is rendered scene by scene. `{{index}}` and `{{total}}` are filled in.',
    default:
      'Storyboard: render picture {{index}} of {{total}}. Choose a DISTINCT scene from the story above (do not repeat a scene you already rendered) and draw it. Keep characters, setting and style consistent across all {{total}} pictures.'
  },
  {
    id: 'image.one-shot',
    category: 'image',
    label: 'Storyboard — one-shot prompt',
    description: 'Requests ALL pictures in ONE completion so characters/style stay consistent. `{{total}}` is filled in.',
    default: `Storyboard one-shot: create EXACTLY {{total}} pictures in ONE single response — all {{total}} images together in this same completion.

Produce all {{total}} images in the same response so that characters, faces, figures, costumes, the environment/setting, lighting and art style are perfectly consistent across every image.

Rules:
- One DIFFERENT scene per image, covering the key moments of the story beat above, in story order.
- The SAME characters (identical face, build, costume), the SAME setting/environment and the SAME style in every image — never change appearance or environment between images.
- Stay consistent with characters, setting and style established earlier.
- Return all {{total}} images now.`
  },
  {
    id: 'image.one-shot-scenes',
    category: 'image',
    label: 'Storyboard — scene one-shot prompt',
    description: 'The render prompt for planned-scenes: requests ALL derived scene descriptions in ONE completion (like image.one-shot) but keeps the SCENE intent — each picture shows the action of the scene, not a frozen still. `{{total}}` is filled in.',
    default: `Scene one-shot: create EXACTLY {{total}} pictures in ONE single response — all {{total}} images together in this same completion.

The scenes below are concrete, action-bearing moments. Render each scene as ONE coherent, vivid picture that shows the action of that moment.

Rules:
- One DIFFERENT scene per image, covering the key moments of the story beat above, in story order.
- For each scene capture the concrete action or gesture — keep it alive, do not flatten it into a frozen, static photograph.
- The SAME characters (identical face, build, costume), the SAME setting/environment and the SAME style in every image — never change appearance or environment between images.
- Stay consistent with characters, setting and style established earlier.
- Return all {{total}} images now.`
  },
  {
    id: 'image.pure',
    category: 'image',
    label: 'Pure picture mode — en-block prompt',
    description: 'Request ALL derived, temporal-free picture descriptions in one response. `{{total}}` and `{{descriptions}}` are filled in.',
    default: `Below are EXACTLY {{total}} pure picture descriptions — isolated moments of a scene, free of story or temporal context. Render ALL {{total}} pictures in ONE single response.

The exact pictures to render (one picture per description, in this order):
{{descriptions}}
Rules for every picture:
- Render each picture EXACTLY as described; do not add plot, dialogue or time progression.
- Keep the SAME characters (identical face, build, costume), the SAME setting/environment and the SAME art style across ALL {{total}} pictures — never change appearance or environment between images.
- Use only what the description states; avoid any sensitive or explicit content.`
  },
  {
    id: 'image.planning',
    category: 'image',
    label: 'Picture-description planning',
    description: 'Turns the story into concrete still-image descriptions before rendering. `{{total}}` is filled in.',
    default: `You are a storyboard artist who converts narrative prose into STATIC still images.
    
In the history is the story so far and the illustration request.

Use at least ({{total}} * 200) tokens to produce EXACTLY {{total}} distinct still images of different non sexual situations in the complete story in story order.

EACH image is ONE single frozen instant — a photograph, not a film clip. Show only what is visible at exactly ONE point in time. Do NOT narrate a sequence of actions and do NOT compress several moments into one image:
- BAD: "Amanda walks into the office where Dr. Harvey waits; she sits down, crosses her legs, and he watches her."
- GOOD: "Medium shot from the doorway: Amanda stands just inside Dr. Harvey's half-open door, one stiletto heel lifted, hand resting on the polished door edge; warm lamplight falls across the black leather skirt; the doctor sits at his desk looking up, pen mid-air."

For EVERY image write ONE self-contained prose description of that single frozen frame, so a painter can draw it without reading the story:
- shot size / camera angle (wide, medium, close-up, ...)
- the EXACT pose and position of every character in the frame, frozen at that instant
- costume and appearance
- setting, lighting, time of day, weather
- key objects and their exact placement
- mood, dominant colors, composition
- any visible text/sign, or explicitly "no text"
- don't describe sexual situations
- hide nude nipples, vulvas, sexual organs anyhow, if they occurr

RULES:
- Static, descriptive language only — no motion sequences, no "then/next/after".
- No dialogue, no inner monologue, no speech bubbles.
- Keep characters, setting and style consistent across all {{total}} images.
- Never repeat an image.

Return ONLY a JSON object with a single key "pictures": an array of exactly {{total}} plain strings:
{"pictures": ["<description 1>", "<description 2>", ...]}
No markdown fences, no text before or after the JSON.`
  },
  {
    id: 'image.planning-scenes',
    category: 'image',
    label: 'Picture-description planning — scenes (per-scene render)',
    description: 'The planning prompt for planned-scenes. Like image.planning but scene-oriented: fewer static still photographs, more alive, action-bearing scenes. `{{total}}` is filled in.',
    default: `You are a storyboard artist who breaks narrative prose into CONCRETE SCENES.

Below is the story so far and the illustration request (the last text is the beat to depict; the earlier text is the established context).

Use at least ({{total}} * 200) tokens to produce EXACTLY {{total}} distinct scenes of different non sexual situations in the complete story in story order.

Each SCENE is ONE coherent, depictable moment — one clear action or gesture that moves the story forward. 
Prefer pictures that feel ALIVE (a character acting, a visible change, purpose-driven motion) rather than a frozen, static photograph. Every scene must still be drawable as a SINGLE picture.

For EVERY scene write ONE self-contained prose description of that single moment, so a painter can draw it without reading the story:
- the concrete ACTION in the frame (one verb/gesture, no montage)
- shot size / camera angle (wide, medium, close-up, ...)
- the EXACT pose and position of every character in the frame at that instant
- costume and appearance
- setting, lighting, time of day, weather
- key objects and their exact placement
- mood, dominant colors, composition
- any visible text/sign, or explicitly "no text"
- don't describe sexual situations
- hide nude nipples, vulvas, sexual organs anyhow, if they occurr

RULES:
- Each scene is a SINGLE decidable moment — describe one action or gesture with concrete, depictable language; do not compress a sequence of several moments into one frame.
- No dialogue, no inner monologue, no speech bubbles.
- Keep characters, setting and style consistent across all {{total}} scenes.
- Never repeat a scene.

Return ONLY a JSON object with a single key "pictures": an array of exactly {{total}} plain strings:
{"pictures": ["<description 1>", "<description 2>", ...]}
No markdown fences, no text before or after the JSON.`
  },

  // ---------------------------------------------------------------- language
  {
    id: 'language.check',
    category: 'language',
    label: 'Language / grammar check',
    description: 'Used by "Check my English" to review a writing direction. Async overrides are read at call time.',
    default: `You are a careful copy-editor for writing directions that a user sends to a creative-writing model.

The direction is NOT part of the final story — it is guidance for the model. Your ONLY goal is to make the model understand the user's intent correctly and unambiguously.

Rules:
- Do NOT beautify, embellish or restyle. Keep the author's voice and intent exactly.
- Change only what can cause misunderstanding: grammar, spelling, punctuation, ambiguous wording, unclear referents.
- Keep the direction as short as necessary. Never lengthen it for style.
- Deliberate creative phrasing is fine as long as it is not ambiguous.

Produce EXACTLY 3 variants of the corrected direction:
1. "minimal": closest to the original wording — fix only clear errors (spelling, grammar, punctuation), change as little as possible.
2. "clearer": same intent, reworded for unambiguity, still close to the original.
3. "rewritten": fully restated so it cannot be misunderstood — explicit and clear, preserving the intent.

Return ONLY a JSON array of exactly 3 strings in this order: [minimal, clearer, rewritten].
No text before or after the JSON, no markdown fences.`
  }
];

/** Look up a default def by id. */
export function promptDefaultById(id: string): PromptDefaultDef | undefined {
  return PROMPT_DEFAULTS.find(d => d.id === id);
}