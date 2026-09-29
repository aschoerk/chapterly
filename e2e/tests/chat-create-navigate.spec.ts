// ---------------------------------------------------------------------------
// TEMPLATE 01 — "Chat create + navigate"
//
// Recorded once by hand / with `npm run e2e:codegen`:
//   1. Open the app                                  → sidebar visible
//   2. Click "New story" on a project                → chat is created + selected
//   3. Click the draft leaf (composer)               → inline editor opens
//   4. Type a question, press Ctrl+Enter             → persistQuestion + LLM answer
//   5. Answer streams in via {proxyBase}/chat/completions (wiremock-LLM)
//   6. Click chat items / nav-path buttons           → navigation
//
// Then parameterized: the exact same steps run for every row of the data
// tables below, so one recorded usecase becomes a repeatable matrix.
// ---------------------------------------------------------------------------

import { test, expect } from '@playwright/test';
import { mockLlm } from '../support/llm-mock';
import {
  openApp,
  newStory,
  askQuestion,
  expectNodeText,
  expectNavPathLength,
  openChat,
} from '../support/ui';

// Each row = one repeatable scenario built from the recorded steps.
const questions = [
  { project: 'Demo Project', question: 'Who is the hero?', answer: 'The hero is Ada.' },
  { project: 'Demo Project', question: 'Where does it happen?', answer: 'In a floating castle.' },
];

for (const scenario of questions) {
  test(`create a story and ask: "${scenario.question}"`, async ({ page }) => {
    // Wiremock-style LLM: intercept /proxy/chat/completions, return canned SSE.
    await mockLlm(page, { answer: [scenario.answer] });

    await openApp(page);

    // 2 → create + select the story
    const title = await newStory(page, scenario.project);
    expect(title).toContain('New Chat');

    // 3+4 → click draft, type, send
    await askQuestion(page, scenario.question);

    // 5 → answer rendered on the active path
    await expectNodeText(page, scenario.answer);
  });
}


test('test', async ({ page }) => {
  await page.goto('http://127.0.0.1:8081/#/chat');
  await page.getByText('Demo Project').click();
  await page.getByTitle('Drag to resize sidebar').click();
  await page.getByRole('button', { name: 'New story' }).click();
  page.once('dialog', dialog => {
    console.log(`Dialog message: ${dialog.message()}`);
    dialog.dismiss().catch(() => {});
  });
  await page.getByRole('button', { name: 'Title' }).click();
});

test('check chat create/delete', async ({ page }) => {
  await page.goto('http://127.0.0.1:8081/#/chat');
  await page.getByRole('button').nth(3).click();
  await page.getByRole('button', { name: 'New story' }).click();
  await page.getByText('Demo Project – New Chat').first().click();
  await page.getByRole('button', { name: 'Delete' }).nth(1).click();
  await page.getByText('Delete', { exact: true }).click();
});
test('navigate a seeded story: open chat and walk the nav path', async ({ page }) => {
  await openApp(page);

  // Open the seeded chat (has: user → assistant → draft = 3 nodes).
  await openChat(page, 'Getting Started');
  await expectNavPathLength(page, 3);

  // The seeded assistant answer is visible in the tree.
  await expectNodeText(page, 'memorable, decisive moment');
});

test('navigate back to a newly created story after switching chats', async ({ page }) => {
  await mockLlm(page, { answer: ['A quiet, warm opening scene.'] });

  await openApp(page);
  const title = await newStory(page, 'Demo Project');
  await askQuestion(page, 'How should chapter one open?');
  await expectNodeText(page, 'quiet, warm opening scene');

  // Switch to the seeded chat, then back to the new one — it must persist.
  await openChat(page, 'Getting Started');
  await expectNavPathLength(page, 3);
  await openChat(page, title);
  await expectNodeText(page, 'quiet, warm opening scene');
});