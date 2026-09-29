import { Injectable, signal } from '@angular/core';

/**
 * The value of the "current topic" selection.
 * A concrete topic id, or one of the two virtual filters.
 */
export type TopicSelection = string | 'all' | 'unassigned';

const LS_TOPIC = 'chat.selectedTopicId';

/**
 * Single source of truth for the "current topic".
 *
 * The sidebar, the Topics page and the Projects page all read and write the
 * same signal, so selecting a topic in any of them is reflected everywhere.
 * The selection is persisted to localStorage (same key the sidebar already
 * used, so existing selections are preserved).
 */
@Injectable({ providedIn: 'root' })
export class TopicSelectionService {
  private readonly _selectedTopicId = signal<TopicSelection>(this.readStored());

  /** Current topic: a topic id, 'all', or 'unassigned'. */
  readonly selectedTopicId = this._selectedTopicId.asReadonly();

  /** Set the current topic (syncs sidebar, Topics and Projects pages). */
  selectTopic(id: TopicSelection): void {
    const value = id || 'all';
    this._selectedTopicId.set(value);
    try {
      localStorage.setItem(LS_TOPIC, value);
    } catch {
      /* ignore */
    }
  }

  /** Reset back to "all" (e.g. after the selected topic was deleted). */
  clear(): void {
    this.selectTopic('all');
  }

  private readStored(): TopicSelection {
    try {
      return (localStorage.getItem(LS_TOPIC) as TopicSelection) || 'all';
    } catch {
      return 'all';
    }
  }
}