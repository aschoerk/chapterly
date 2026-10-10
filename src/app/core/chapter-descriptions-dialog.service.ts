import { Injectable, signal } from '@angular/core';
import { Chat, ChatNode } from '../models/chat';

/**
 * Per-chat persistence for the "Create chapter descriptions" dialog. The
 * parameters of the LAST generation are stored per chat so the next press of
 * the button provides the latest input parameters again (Prefill), and the
 * first chapter number continues right after the previously generated list.
 */
const LS_PARAMS = 'chat.chapterDescriptions.paramsByChatId';
/** Last model selected in the dialog (remembered for the next run). */
const LS_MODEL = 'chat.chapterDescriptions.model.v1';

/** Fallback defaults used the very first time (nothing generated yet). */
const DEFAULT_CHAPTER_COUNT = 5;
const DEFAULT_SENTENCES_PER_CHAPTER = 1;

/** The generated-list parameters the user enters in the dialog. */
export interface ChapterDescriptionsParams {
  /** Number of chapter headings / descriptions to create. */
  chapterCount: number;
  /** Number of sentences each chapter description should contain. */
  sentencesPerChapter: number;
  /** Number of the first chapter (default 1 or the last generated + 1). */
  firstChapter: number;
  /** Free-form description of what the chapters should achieve. */
  goal: string;
}

/** What the user confirms in the "Create chapter descriptions" dialog. */
export interface ChapterDescriptionsResult extends ChapterDescriptionsParams {
  /** Writing/heading model selected in the dialog. */
  modelId: string;
  /** Provider of the selected model. */
  providerId: string;
}

/** The open dialog state: the prefilled fields + the resolve callback. */
export interface ChapterDescriptionsState extends ChapterDescriptionsResult {
  chatId: string;
  chat: Chat | null;
  /** The empty leaf question where Continue lives (the current node). */
  node: ChatNode;
  /** Collect the modal result. Resolves null when the user cancels. */
  resolve: (value: ChapterDescriptionsResult | null) => void;
}

/** A remembered model choice (id + provider). */
interface RememberedModel {
  modelId: string;
  providerId: string;
}

function readParamsMap(): Record<string, ChapterDescriptionsParams> {
  try {
    const raw = localStorage.getItem(LS_PARAMS);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, ChapterDescriptionsParams> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (!v || typeof v !== 'object') continue;
      const p = v as Partial<ChapterDescriptionsParams>;
      out[k] = {
        chapterCount: clampPositive(p.chapterCount),
        sentencesPerChapter: clampPositive(p.sentencesPerChapter),
        firstChapter: clampPositive(p.firstChapter),
        goal: typeof p.goal === 'string' ? p.goal : ''
      };
    }
    return out;
  } catch {
    return {};
  }
}

function writeParamsMap(map: Record<string, ChapterDescriptionsParams>): void {
  try {
    localStorage.setItem(LS_PARAMS, JSON.stringify(map));
  } catch {
    // storage may be unavailable (private mode / quota) — best-effort.
  }
}

function clampPositive(n: unknown): number {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 1;
}

function readModel(): RememberedModel {
  try {
    const raw = localStorage.getItem(LS_MODEL);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { modelId: '', providerId: '' };
    return {
      modelId: typeof parsed.modelId === 'string' ? parsed.modelId : '',
      providerId: typeof parsed.providerId === 'string' ? parsed.providerId : ''
    };
  } catch {
    return { modelId: '', providerId: '' };
  }
}

function writeModel(model: RememberedModel): void {
  try {
    localStorage.setItem(LS_MODEL, JSON.stringify(model));
  } catch {
    // storage may be unavailable (private mode / quota) — best-effort.
  }
}

/**
 * Holds the open state of the "Create chapter descriptions" dialog (mounted
 * once in the app root, mirroring RewriteDialogService). The LAST input
 * parameters are remembered PER CHAT so re-opening always provides them; the
 * first chapter number defaults to the last generated chapter + 1. The model
 * chosen in the dialog is remembered globally (like the image dialog).
 */
@Injectable({ providedIn: 'root' })
export class ChapterDescriptionsDialogService {
  /** The dialog entry, or null when the dialog is closed. */
  readonly current = signal<ChapterDescriptionsState | null>(null);

  /**
   * Open the dialog for the empty leaf question. When a chapter description
   * list was generated for this chat before, the latest input parameters are
   * pre-filled and the first chapter continues right after the last generated
   * one (firstChapter = stored.firstChapter + stored.chapterCount). Resolves
   * with the confirmed result, or null when the user cancels.
   */
  open(opts: {
    chatId: string;
    chat: Chat | null;
    node: ChatNode;
    /** Caller-provided default model (current model of the node). */
    defaultModelId: string;
    defaultProviderId: string;
  }): Promise<ChapterDescriptionsResult | null> {
    const stored = readParamsMap()[opts.chatId];
    const remembered = readModel();
    const hadStored = !!stored;

    return new Promise(resolve => {
      this.current.set({
        chatId: opts.chatId,
        chat: opts.chat,
        node: opts.node,
        // Latest input parameters (first press: sensible defaults).
        chapterCount: hadStored ? stored!.chapterCount : DEFAULT_CHAPTER_COUNT,
        sentencesPerChapter: hadStored ? stored!.sentencesPerChapter : DEFAULT_SENTENCES_PER_CHAPTER,
        // Default 1, or the last generated chapter + 1.
        firstChapter: hadStored ? stored!.firstChapter + stored!.chapterCount : 1,
        goal: hadStored ? stored!.goal : '',
        // Remembered model wins; the current model stays the fallback.
        modelId: remembered.modelId || opts.defaultModelId,
        providerId: remembered.providerId || opts.defaultProviderId,
        resolve
      });
    });
  }

  /** Confirm: remember the parameters for this chat + the model and resolve. */
  submit(result: ChapterDescriptionsResult): void {
    const cur = this.current();
    if (!cur) return; // no dialog open — the values are just not resolved
    const params = readParamsMap();
    params[cur.chatId] = {
      chapterCount: clampPositive(result.chapterCount),
      sentencesPerChapter: clampPositive(result.sentencesPerChapter),
      firstChapter: clampPositive(result.firstChapter),
      goal: (result.goal ?? '').trim()
    };
    writeParamsMap(params);

    // Remember the selected heading model for the next dialog run.
    writeModel({
      modelId: (result.modelId ?? '').trim(),
      providerId: (result.providerId ?? '').trim()
    });

    this.current.set(null);
    cur.resolve(result);
  }

  /** Cancel — close without generating. */
  cancel(): void {
    const cur = this.current();
    if (!cur) return;
    this.current.set(null);
    cur.resolve(null);
  }
}