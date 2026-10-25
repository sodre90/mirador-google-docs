import { readFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import { fakeGcloud } from "../tests/fake-google.ts";

const miradorDir = process.env.MIRADOR_DIR ?? join(import.meta.dirname, "..", "..", "visualized-claude-sessions");
const pluginDir = process.env.GOOGLE_DOCS_PLUGIN_DIR ?? join(import.meta.dirname, "..");
const profileName = "docs";
const launchPlan = JSON.parse(readFileSync(join(import.meta.dirname, "..", "tests", "fixtures", "launch-plan.json"), "utf8"));
const resolvedThread = { commentId: "doco.old", status: "RESOLVED", plainTextQuote: "Q3", headPost: { postId: "doco.old", content: "Is Q3 firm?", author: { displayName: "Ben" } } };
const fixture = { ...launchPlan, comments: [...launchPlan.comments, resolvedThread] };
const URL = "https://docs.google.com/document/d/1testDocumentIdForMiradorGoogleDocs/edit";

type Helpers = typeof import("../../visualized-claude-sessions/e2e/helpers.ts");
type TestHostModule = typeof import("../../visualized-claude-sessions/e2e/test-host.ts");
let mirador: Helpers;
let host: InstanceType<TestHostModule["TestHost"]>;
let gcloud: ReturnType<typeof fakeGcloud>;

/** The Docs API, as far as the plugin uses it: one doc, and every batchUpdate it is sent. */
const google = { batches: [] as { requests: unknown[]; writeControl?: unknown }[], server: null as Server | null };

function startGoogle(): Promise<string> {
  google.server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      response.setHeader("Content-Type", "application/json");
      if (request.headers.authorization !== "Bearer token-for-ana@example.com") {
        response.statusCode = 403;
        response.end(JSON.stringify({ error: { message: "The caller does not have permission" } }));
      } else if (request.method === "POST") {
        google.batches.push(JSON.parse(body));
        response.end(JSON.stringify({ replies: [], writeControl: { requiredRevisionId: "rev-2" } }));
      } else response.end(JSON.stringify(fixture));
    });
  });
  return new Promise((resolve) => google.server!.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(google.server!.address() as AddressInfo).port}`)));
}

const prompts = () => readFileSync(join(host.root, "prompts"), "utf8");
const view = (page: Page): FrameLocator => page.frameLocator(".canvas-panel:visible .canvas-frame.app iframe");
const tool = (conversation: string, name: string, args: Record<string, unknown>) => mirador.callCanvasTool(host, conversation, name, args);

test.beforeAll(async () => {
  const { TestHost, writeBunProgram } = (await import(join(miradorDir, "e2e", "test-host.ts"))) as TestHostModule;
  mirador = (await import(join(miradorDir, "e2e", "helpers.ts"))) as Helpers;
  const apiUrl = await startGoogle();
  gcloud = fakeGcloud(["ana@example.com"]);
  host = new TestHost({ fakePrograms: true, environment: { GOOGLE_DOCS_API_URL: apiUrl, GOOGLE_DOCS_GCLOUD: gcloud.program } });
  writeBunProgram(host.fakeProgramsDir, "opencode", join(miradorDir, "e2e", "fake-acp-agent.ts"), { FAKE_ACP_PROMPTS: join(host.root, "prompts") });
  writeFileSync(join(host.root, "prompts"), "");
  mkdirSync(join(host.dataDir, "plugins"), { recursive: true });
  symlinkSync(pluginDir, join(host.dataDir, "plugins", "google-docs"));
  await host.start();
});
test.afterAll(async () => {
  await host?.stop();
  await host?.cleanUp();
  google.server?.close();
});

async function startWithTheAgent(page: Page) {
  await mirador.signIn(page, host);
  await mirador.addWorkspace(page, host.projectDir);
  const profiles = await mirador.createProfile(page, profileName, "", "", "opencode");
  await profiles.getByRole("button", { name: "Close" }).click();
  await page.getByLabel("Agent", { exact: true }).selectOption({ label: `${profileName} · opencode` });
  const previousUrl = page.url();
  await page.getByRole("button", { name: "+ New conversation" }).click();
  await expect(page).not.toHaveURL(previousUrl);
  const conversation = page.url().match(/#\/c\/(.+)$/)![1]!;
  await mirador.sendMessage(page, "Start");
  await expect(page.locator(".chat-header:visible .badge")).toHaveText("idle", { timeout: 60_000 });
  return conversation;
}

const tab = (page: Page, title: string) => view(page).getByRole("tab", { name: new RegExp(`^${title}`) }).click();

/** Opens a sidebar card, unless it is open already. */
async function open(card: ReturnType<FrameLocator["locator"]>) {
  const head = card.locator(".card-head");
  if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
}

/** Selects as a drag would, from the start of `from`'s text in its paragraph to the end of `to`'s text in its own, then lets go. */
async function selectAcross(page: Page, from: [block: string, text: string], to: [block: string, text: string]) {
  await view(page)
    .locator(".page")
    .evaluate((page, [from, to]) => {
      const point = ([block, wanted]: string[], atEnd: boolean) => {
        const paragraph = page.querySelector(`[data-block="${block}"]`)!;
        const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const at = node.textContent!.indexOf(wanted);
          if (at !== -1 && !node.parentElement!.closest("ins")) return { node, offset: atEnd ? at + wanted.length : at };
        }
        throw new Error(`${wanted} isn't in one piece of ${paragraph.textContent}`);
      };
      const start = point(from, false);
      const end = point(to, true);
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      end.node.parentElement!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    }, [from, to]);
}

const select = (page: Page, block: string, text: string) => selectAcross(page, [block, text], [block, text]);

test("the agent proposes edits to a Google doc shown in Mirador; you select text to ask for more and comment, approve each, and send them as suggestions", async ({ page }) => {
  const conversation = await startWithTheAgent(page);

  await test.step("the agent links the doc and reads it; the view shows it as a doc, with its comments", async () => {
    expect(await tool(conversation, "app_open", { app: "google-docs", file: "launch-plan.gdoc" })).toContain("No doc is linked yet.");
    expect(await tool(conversation, "apply", { op: { op: "link", url: URL } })).toContain('run the task "pull"');
    expect(await tool(conversation, "app_run", { task: "pull" })).toContain("Read “Launch plan” as ana@example.com: 7 blocks, 2 comment threads, 1 open suggestion.");
    await expect(view(page).locator("h1")).toHaveText("Launch plan");
    await expect(view(page).locator('[data-block="p2"] .bold')).toHaveText("launch");
    await expect(view(page).locator("table td")).toHaveText(["Risk", "Low"]);
    const thread = view(page).locator('.thread[data-thread="doco.thread1"]');
    await expect(view(page).getByRole("tab", { selected: true })).toHaveText("Comments 1");
    await expect(thread).toContainText("Ana Which launch? · 1 reply");
    await expect(thread.getByRole("button", { name: "Reply", exact: true })).toHaveCount(0);
    await expect(view(page).locator('.thread[data-thread="doco.old"]')).toHaveCount(0);
    await view(page).getByRole("button", { name: "Show resolved (1)" }).click();
    await expect(view(page).locator('.thread[data-thread="doco.old"]')).toContainText("Is Q3 firm?");
    await view(page).getByRole("button", { name: "Hide resolved" }).click();
    await expect(view(page).locator(".mark-thread")).toHaveText("launch");
    expect(await tool(conversation, "app_state", {})).toContain("p2 The launch is planned by Q3 🚀.");
  });

  await test.step("the agent proposes a rewrite; it shows in the text and waits, and the agent can't approve or send it", async () => {
    expect(await tool(conversation, "apply", { op: { op: "replace", block: "p2", quote: "by Q3", with: "by the end of October" } })).toContain("Proposed c1");
    await expect(view(page).locator('[data-block="p2"] .mark-deleted')).toHaveText("by Q3");
    await expect(view(page).locator('[data-block="p2"] ins')).toHaveText("by the end of October");
    await expect(view(page).getByRole("tab", { selected: true })).toHaveText("To send 1");
    await expect(view(page).locator('.change[data-change="c1"]')).toContainText("replace “by Q3” in p2 with “by the end of October”");
    expect(await tool(conversation, "apply", { op: { op: "approve", change: "c1" } })).toContain("Only the user can approve a change, in the view.");
    expect(await tool(conversation, "app_run", { task: "push" })).toContain("Only the user sends changes to Google Docs");
    await expect(view(page).locator(".task")).toHaveText("The agent asked to send the changes. Look them over, then press Send.");
    await expect(view(page).locator(".problem")).toHaveCount(0);
    expect(google.batches).toEqual([]);
  });

  await test.step("you select text and ask the agent to change it; the agent hears the quote, where it is and your words", async () => {
    await select(page, "p4", "We ship");
    const box = view(page).getByRole("dialog", { name: "Selected text" });
    await box.getByLabel("What should change here?").fill("Say who ships it");
    await box.getByRole("button", { name: "Ask the agent" }).click();
    await expect(box).toBeHidden();
    await expect.poll(prompts).toContain("About “We ship” in p4: Say who ships it");
    expect(prompts()).toContain('{"op":"replace","block":"p4","quote":"We ship","at":0,"with":"…"}');
  });

  await test.step("you select across paragraphs and ask the agent about all of it; a comment needs one paragraph", async () => {
    await selectAcross(page, ["p4", "review by Q3."], ["p5", "Budget:"]);
    const box = view(page).getByRole("dialog", { name: "Selected text" });
    await expect(box.locator(".quote")).toHaveText("“review by Q3. ¶ Budget:”");
    await box.getByLabel("What should change here?").fill("Merge these into one sentence");
    await expect(box.getByRole("button", { name: "Comment" })).toBeDisabled();
    await expect(box).toContainText("A comment goes on text in one paragraph.");
    await box.getByRole("button", { name: "Ask the agent" }).click();
    await expect(box).toBeHidden();
    await expect.poll(prompts).toContain("About the text from p4 through p5:\n- p4: “review by Q3.”\n- p5: “Budget:”\nMerge these into one sentence\nPropose it with apply, one change per paragraph");
  });

  await test.step("you comment on a selection and reply to a thread; both are yours, so they're approved already", async () => {
    await select(page, "p2", "planned");
    const box = view(page).getByRole("dialog", { name: "Selected text" });
    await box.getByLabel("What should change here?").fill("Planned by whom?");
    await box.getByRole("button", { name: "Comment" }).click();
    await expect(view(page).locator('.change[data-change="c2"]')).toContainText("comment on “planned” in p2: “Planned by whom?”");
    await expect(view(page).locator('.change[data-change="c2"] .badge')).toHaveText("Approved");
    await view(page).locator(".mark-thread").click();
    await expect(view(page).getByRole("tab", { selected: true })).toHaveText("Comments 1");
    const thread = view(page).locator('.thread[data-thread="doco.thread1"]');
    await expect(thread.locator(".card-head")).toHaveAttribute("aria-expanded", "true");
    await thread.getByRole("button", { name: "Reply", exact: true }).click();
    await thread.getByLabel("Reply").fill("The spring launch, yes.");
    await thread.getByRole("button", { name: "Reply and resolve" }).click();
    await expect(thread).toContainText("Resolved in c3, not sent yet");
    await tab(page, "To send");
    await expect(view(page).locator('.change[data-change="c3"]')).toContainText("reply to thread doco.thread1: “The spring launch, yes.”, and resolve it");
  });

  await test.step("you ask the agent to reply to a thread; it hears the thread and what the reply should say", async () => {
    await tab(page, "Comments");
    const thread = view(page).locator('.thread[data-thread="doco.thread1"]');
    await open(thread);
    await thread.getByRole("button", { name: "Ask the agent to reply" }).click();
    await thread.getByLabel("What should the reply say?").fill("Say it's the spring one, and thank Ana");
    await thread.getByRole("button", { name: "Ask the agent", exact: true }).click();
    await expect(thread).toContainText("Asked the agent; its reply shows in Pending changes.");
    await expect.poll(prompts).toContain("Write a reply to comment thread doco.thread1 on “launch”:\n- Ana: “Which launch?”\n- Ben: “The spring one.”\nWhat the reply should say: Say it's the spring one, and thank Ana");
    expect(prompts()).toContain('{"op":"reply","thread":"doco.thread1","text":"…","resolve":false}');
  });

  await test.step("you approve the agent's change and send everything; it lands as suggestions and comments", async () => {
    await expect(view(page).getByRole("button", { name: "Send to Google Docs (2)" })).toBeVisible();
    await tab(page, "To send");
    await view(page).locator('.change[data-change="c1"]').getByRole("button", { name: "Approve" }).click();
    await view(page).getByRole("button", { name: "Send to Google Docs (3)" }).click();
    await expect(view(page).locator(".task.done")).toHaveText("Sent c2, c3, c1; the edits are suggestions in the doc now.");
    await expect(view(page).locator(".change")).toHaveCount(0);
    expect(google.batches).toEqual([
      {
        requests: [
          { insertComment: { content: "Planned by whom?", range: { startIndex: 27, endIndex: 34, tabId: "t.0" } } },
          { addCommentReply: { commentId: "doco.thread1", post: { content: "The spring launch, yes." } } },
          { addCommentReply: { commentId: "doco.thread1", post: { commentAction: "RESOLVE" } } },
        ],
      },
      {
        requests: [
          { deleteContentRange: { range: { startIndex: 35, endIndex: 40, tabId: "t.0" } } },
          { insertText: { location: { index: 35, tabId: "t.0" }, text: "by the end of October" } },
        ],
        writeControl: { writeMode: "SUGGEST", targetRevisionId: "rev-1" },
      },
    ]);
    expect(await tool(conversation, "app_state", {})).toContain("No pending changes.");
  });

  await test.step("you drop one of the agent's changes and approve all the others at once", async () => {
    google.batches.length = 0;
    await tool(conversation, "apply", { op: { op: "delete", block: "p1", quote: " plan" } });
    await tool(conversation, "apply", { op: { op: "insert", block: "p3", after: "Ana", text: " and Ben" } });
    await tool(conversation, "apply", { op: { op: "replace", block: "p6", quote: "Notes", with: "Open questions" } });
    await view(page).locator('.change[data-change="c4"]').getByRole("button", { name: "Drop" }).click();
    await expect(view(page).locator(".change")).toHaveCount(2);
    await view(page).getByRole("button", { name: "Approve all" }).click();
    await expect(view(page).locator(".change .badge")).toHaveText(["Approved", "Approved"]);
    await expect(view(page).getByRole("button", { name: "Approve all" })).toBeHidden();
    await view(page).getByRole("button", { name: "Send to Google Docs (2)" }).click();
    await expect(view(page).locator(".task.done")).toHaveText("Sent c5, c6; the edits are suggestions in the doc now.");
    expect(google.batches.map(({ requests }) => requests)).toEqual([
      [
        { insertText: { location: { index: 57, tabId: "t.0" }, text: " and Ben" } },
        { deleteContentRange: { range: { startIndex: 1, endIndex: 6, tabId: "t.1" } } },
        { insertText: { location: { index: 1, tabId: "t.1" }, text: "Open questions" } },
      ],
    ]);
  });

  await test.step("you accept a suggestion in the doc and ask the agent to reply to it; Send accepts it in Docs", async () => {
    google.batches.length = 0;
    await tab(page, "Suggestions");
    const suggestion = view(page).locator('.suggestion[data-suggestion="suggest.a"]');
    await expect(suggestion).toContainText("Ben");
    await expect(suggestion).toContainText("Replace: “5k” with “10k”");
    await open(suggestion);
    await suggestion.hover();
    await expect(view(page).locator('[data-block="p5"] .focused')).toHaveText(["10k", "5k"]);
    await suggestion.getByRole("button", { name: "Ask the agent to reply" }).click();
    await suggestion.getByLabel("What should the reply say?").fill("Say 10k is fine");
    await suggestion.getByRole("button", { name: "Ask the agent", exact: true }).click();
    await expect.poll(prompts).toContain("Write a reply to Ben's suggestion suggest.a (Replace: “5k” with “10k”):\nWhat the reply should say: Say 10k is fine");
    expect(prompts()).toContain('{"op":"reply","thread":"suggest.a","text":"…"}');
    await suggestion.getByRole("button", { name: "Accept" }).click();
    await expect(suggestion).toHaveCount(0);
    await expect(view(page).getByRole("tab", { name: /^Suggestions/ })).toHaveText("Suggestions 0");
    await tab(page, "To send");
    await expect(view(page).locator('.change[data-change="c7"]')).toContainText("accept suggestion suggest.a");
    await view(page).locator('.change[data-change="c7"]').getByRole("button", { name: "Drop" }).click();
    await tab(page, "Suggestions");
    await open(suggestion);
    await suggestion.getByRole("button", { name: "Accept" }).click();
    await expect(suggestion).toHaveCount(0);
    await tab(page, "To send");
    await expect(view(page).locator('.change[data-change="c8"]')).toContainText("accept suggestion suggest.a");
    await view(page).getByRole("button", { name: "Send to Google Docs (1)" }).click();
    await expect(view(page).locator(".task.done")).toHaveText("Sent c8.");
    expect(google.batches).toEqual([{ requests: [{ acceptSuggestion: { suggestionId: "suggest.a" } }] }]);
  });

  await test.step("you sign in another Google account from the view", async () => {
    writeFileSync(join(gcloud.folder, "next-sign-in"), "ana@work.example.com\n");
    await view(page).getByRole("button", { name: "Sign in a Google account" }).click();
    await expect(view(page).locator(".task.done")).toHaveText("Signed in: ana@example.com, ana@work.example.com.");
  });
});
