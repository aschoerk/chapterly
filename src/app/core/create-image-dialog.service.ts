import { Injectable, signal } from '@angular/core';
import { Chat, ChatNode, NodeAttachment } from '../models/chat';
import { newId } from './common/helpers';
import { estimateDataUrlBytes } from './llm/llm-message';

/**
 * Per-chat persistence keys for the "Create image" dialog. The chat-specific
 * constant (and the reference images) are stored per chat so they ALWAYS
 * appear when the dialog is opened for the same chat again.
 */
const LS_CONSTANT = 'chat.createImage.constantByChatId';
const LS_IMAGES = 'chat.createImage.imagesByChatId';
/** Last image-producing model selected in the dialog (remembered for the next run). */
const LS_MODEL = 'chat.createImage.model.v1';
/**
 * Safety cap for the reference images persisted PER CHAT (localStorage quota).
 * Images attached beyond this byte total still work for the current send —
 * they are simply not remembered for the next dialog open.
 */
const MAX_PERSISTED_BYTES = 3_000_000;

/** A remembered model choice (id + provider). */
interface RememberedModel {
  modelId: string;
  providerId: string;
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

/** What the user confirms in the "Create image of a selection" dialog. */
export interface CreateImageResult {
  /** Chat-specific constant — always pre-filled for the same chat. */
  constant: string;
  /** The marked text (editable); part of the image-creating text. */
  script: string;
  /** Reference images attached in the dialog (also sent to the model). */
  images: NodeAttachment[];
  /** Image-producing model selected in the dialog. */
  modelId: string;
  /** Provider of the selected model. */
  providerId: string;
}

/** The open dialog state: the editable fields + the resolve callback. */
export interface CreateImageState extends CreateImageResult {
  chatId: string;
  chat: Chat | null;
  /** The assistant node the picture will be attached to. */
  node: ChatNode;
  /** The caller-provided default model (settings task) — used when the
   *  remembered model is no longer enabled. */
  defaultModelId: string;
  defaultProviderId: string;
  /** Collect the modal result. Resolves null when the user cancels. */
  resolve: (value: CreateImageResult | null) => void;
}

function readConstantMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(LS_CONSTANT);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function readImagesMap(): Record<string, NodeAttachment[]> {
  try {
    const raw = localStorage.getItem(LS_IMAGES);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, NodeAttachment[]> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (!Array.isArray(v)) continue;
      const images = v
        .filter((a): a is NodeAttachment => !!a && typeof a === 'object' && typeof a.dataUrl === 'string')
        .map(a => ({ ...a, id: a.id || newId() }));
      if (images.length) out[k] = images;
    }
    return out;
  } catch {
    return {};
  }
}

/** Keep images (in order) whose total data-url bytes fit under the cap. */
function clampImagesForStorage(images: NodeAttachment[]): NodeAttachment[] {
  let total = 0;
  const out: NodeAttachment[] = [];
  for (const img of images) {
    const bytes = estimateDataUrlBytes(img.dataUrl ?? '');
    if (total + bytes > MAX_PERSISTED_BYTES) break;
    total += bytes;
    out.push(img);
  }
  return out;
}

function writeConstantMap(map: Record<string, string>): void {
  try {
    localStorage.setItem(LS_CONSTANT, JSON.stringify(map));
  } catch {
    // storage may be unavailable (private mode / quota) — the current dialog
    // still holds the constant; it just will not be remembered.
  }
}

function writeImagesMap(map: Record<string, NodeAttachment[]>): void {
  try {
    localStorage.setItem(LS_IMAGES, JSON.stringify(map));
  } catch {
    // same as above — ignored on quota/private mode.
  }
}

/**
 * Holds the open state of the "Create image of a selection" dialog (mounted
 * once in the app root, mirroring RewriteDialogService). The chat-specific
 * constant and the attached reference images are remembered PER CHAT so they
 * always appear when the dialog is opened for the same chat again.
 */
@Injectable({ providedIn: 'root' })
export class CreateImageDialogService {
  /** The dialog entry, or null when the dialog is closed. */
  readonly current = signal<CreateImageState | null>(null);

  /**
   * Open the dialog for the marked text of an assistant node. The chat-specific
   * constant (and the previously attached reference images) of that chat are
   * loaded from localStorage and pre-filled. The last image model selected in
   * the dialog is remembered (localStorage) and wins over the caller-provided
   * default (the settings task model) — so repeated calls need no reselection.
   * Resolves with the confirmed result, or null when the user cancels.
   */
  open(opts: {
    chatId: string;
    chat: Chat | null;
    node: ChatNode;
    script: string;
    modelId: string;
    providerId: string;
  }): Promise<CreateImageResult | null> {
    const constants = readConstantMap();
    const imagesMap = readImagesMap();
    const remembered = readModel();
    return new Promise(resolve => {
      this.current.set({
        chatId: opts.chatId,
        chat: opts.chat,
        node: opts.node,
        script: opts.script,
        constant: typeof constants[opts.chatId] === 'string' ? constants[opts.chatId] : '',
        images: imagesMap[opts.chatId] ?? [],
        // Remembered model wins; the caller default stays available as the
        // fallback when the remembered model is no longer enabled.
        modelId: remembered.modelId || opts.modelId,
        providerId: remembered.providerId || opts.providerId,
        defaultModelId: opts.modelId,
        defaultProviderId: opts.providerId,
        resolve
      });
    });
  }

  /** Confirm: remember the constant + reference images + the model for this
   *  chat and resolve. */
  submit(result: CreateImageResult): void {
    const cur = this.current();
    if (!cur) return; // no dialog open — the values are just not resolved
    // Persist the chat-specific constant + a size-clamped set of the
    // reference images (best-effort; quota may silently drop them).
    const constants = readConstantMap();
    constants[cur.chatId] = (result.constant ?? '').trim();
    writeConstantMap(constants);

    const imagesMap = readImagesMap();
    const clamped = clampImagesForStorage(result.images ?? []);
    if (clamped.length) {
      imagesMap[cur.chatId] = clamped;
    } else {
      delete imagesMap[cur.chatId];
    }
    writeImagesMap(imagesMap);

    // Remember the selected image model for the next dialog run.
    writeModel({
      modelId: (result.modelId ?? '').trim(),
      providerId: (result.providerId ?? '').trim()
    });

    this.current.set(null);
    cur.resolve(result);
  }

  /** Cancel — close without creating the image. */
  cancel(): void {
    const cur = this.current();
    if (!cur) return;
    this.current.set(null);
    cur.resolve(null);
  }
}