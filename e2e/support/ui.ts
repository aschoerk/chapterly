import { Page, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// Reusable UI steps for chapterly. Each function packages ONE step of a
// recorded usecase ("do it by hand once, then parameterize") so tests read as
// a list of named actions and stay robust against layout changes.
// ---------------------------------------------------------------------------

export async function openApp(page: Page): Promise<void> {
  // Single origin (docker-compose.e2e.yml): SPA + API + proxy on the same
  // host, so the Angular client resolves the API base from window.location.
  await page.goto('/');
  await expect(page.locator('.sidebar')).toBeVisible();
}

/**
 * Click the "New story" button of the given project.
 * Returns the auto-generated chat title shown in the title editor.
 */
export async function newStory(page: Page, projectName: string): Promise<string> {
  const block = page.locator('.project-block').filter({ hasText: projectName }).first();
  const createBtn = block.locator('.project-actions button[title="New story"]');
  await createBtn.click();
  const title = page.locator('.chat-title-editor .chat-title');
  await expect(title).toBeVisible();
  return (await title.textContent())?.trim() ?? '';
}

/**
 * Open an existing chat by its sidebar title.
 *
 * Chats only render inside an EXPANDED project (`.project-block` → `.chat-list`),
 * so first expand the block, then click the chat. The item's geometric center
 * overlaps an action icon (rename/clone/…), so click the `.chat-title` span —
 * a neutral area with no child button — rather than the item box.
 */
export async function openChat(page: Page, chatTitle: string): Promise<void> {
  const project = page
    .locator('.project-block')
    .filter({ hasText: 'Demo Project' })
    .first();
  const header = project.locator('.project-header');
  if (!(await project.evaluate((el) => el.classList.contains('expanded')))) {
    await header.click();
  }
  const title = page
    .locator('.chat-item')
    .filter({ hasText: chatTitle })
    .first()
    .locator('.chat-title');
  await title.click();
  await expect(page.locator('.tree app-chat-node').first()).toBeVisible();
}

/**
 * The active draft leaf shows a "click to edit" placeholder-only empty-draft.
 * Note: user nodes WITH content also carry the .empty-draft.click-to-edit
 * classes, so select the one that still shows the writeNext placeholder —
 * that uniquely identifies the real composer leaf.
 */
export async function askQuestion(page: Page, text: string): Promise<void> {
  const draft = page
    .locator('.node-content.empty-draft.click-to-edit')
    .filter({ hasText: 'Write the next direction…' })
    .first();
  await draft.click();
  const editor = page.locator('.editor-textarea').first();
  await expect(editor).toBeVisible();
  await editor.fill(text);
  await editor.press('Control+Enter');
}

/** Assert that some node on the active path renders the given text. */
export async function expectNodeText(page: Page, text: string): Promise<void> {
  await expect(
    page.locator('.tree .node-content').filter({ hasText: text }).first()
  ).toBeVisible();
}

/** Assert the nav-path buttons (D/C/S chain) reflect an expected length. */
export async function expectNavPathLength(page: Page, n: number): Promise<void> {
  await expect(page.locator('.node-nav-bar .nav-node')).toHaveCount(n);
}

/** Navigate by clicking the k-th node in the nav path (1-based). */
export async function clickNavNode(page: Page, index: number): Promise<void> {
  await page.locator('.node-nav-bar .nav-node').nth(index - 1).click();
}