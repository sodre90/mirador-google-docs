import { readFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import { fakeGcloud } from "../tests/fake-google.ts";

const miradorDir = process.env.MIRADOR_DIR ?? join(import.meta.dirname, "..", "..", "visualized-claude-sessions");
const pluginDir = process.env.GOOGLE_DOCS_PLUGIN_DIR ?? join(import.meta.dirname, "..");
const profileName = "docs";
const fixture: unknown = JSON.parse(readFileSync(join(import.meta.dirname, "..", "tests", "fixtures", "launch-plan.json"), "utf8"));
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

/** Selects text in a paragraph of the doc as a drag would, then lets go. */
async function select(page: Page, block: string, text: string) {
  await view(page)
    .locator(`[data-block="${block}"]`)
    .evaluate((paragraph, wanted) => {
      const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent!.indexOf(wanted);
        if (at === -1 || node.parentElement!.closest("ins")) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + wanted.length);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(range);
        node.parentElement!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        return;
      }
      throw new Error(`${wanted} isn't in one piece of ${paragraph.textContent}`);
    }, text);
}

test("the agent proposes edits to a Google doc shown in Mirador; you select text to ask for more and comment, approve each, and send them as suggestions", async ({ page }) => {
  const conversation = await startWithTheAgent(page);

  await test.step("the agent links the doc and reads it; the view shows it as a doc, with its comments", async () => {
    expect(await tool(conversation, "app_open", { app: "google-docs", file: "launch-plan.gdoc" })).toContain("No doc is linked yet.");
    expect(await tool(conversation, "apply", { op: { op: "link", url: URL } })).toContain('run the task "pull"');
    expect(await tool(conversation, "app_run", { task: "pull" })).toContain("Read “Launch plan” as ana@example.com: 7 blocks, 1 comment thread, 1 open suggestion.");
    await expect(view(page).locator("h1")).toHaveText("Launch plan");
    await expect(view(page).locator('[data-block="p2"] .bold')).toHaveText("launch");
    await expect(view(page).locator("table td")).toHaveText(["Risk", "Low"]);
    await expect(view(page).locator(".thread")).toContainText("Which launch?");
    await expect(view(page).locator(".mark-thread")).toHaveText("launch");
    expect(await tool(conversation, "app_state", {})).toContain("p2 The launch is planned by Q3 🚀.");
  });

  await test.step("the agent proposes a rewrite; it shows in the text and waits, and the agent can't approve or send it", async () => {
    expect(await tool(conversation, "apply", { op: { op: "replace", block: "p2", quote: "by Q3", with: "by the end of October" } })).toContain("Proposed c1");
    await expect(view(page).locator('[data-block="p2"] .mark-deleted')).toHaveText("by Q3");
    await expect(view(page).locator('[data-block="p2"] ins')).toHaveText("by the end of October");
    await expect(view(page).locator('.change[data-change="c1"]')).toContainText("replace “by Q3” in p2 with “by the end of October”");
    expect(await tool(conversation, "apply", { op: { op: "approve", change: "c1" } })).toContain("Only the user can approve a change, in the view.");
    expect(await tool(conversation, "app_run", { task: "push" })).toContain("Only the user sends changes to Google Docs");
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

  await test.step("you comment on a selection and reply to a thread; both are yours, so they're approved already", async () => {
    await select(page, "p2", "planned");
    const box = view(page).getByRole("dialog", { name: "Selected text" });
    await box.getByLabel("What should change here?").fill("Planned by whom?");
    await box.getByRole("button", { name: "Comment" }).click();
    await expect(view(page).locator('.change[data-change="c2"]')).toContainText("comment on “planned” in p2: “Planned by whom?”");
    await expect(view(page).locator('.change[data-change="c2"] .badge')).toHaveText("Approved");
    const thread = view(page).locator(".thread");
    await thread.getByRole("button", { name: "Reply" }).click();
    await thread.getByLabel("Reply").fill("The spring launch, yes.");
    await thread.getByRole("button", { name: "Reply and resolve" }).click();
    await expect(view(page).locator('.change[data-change="c3"]')).toContainText("reply to thread doco.thread1: “The spring launch, yes.”, and resolve it");
  });

  await test.step("you approve the agent's change and send everything; it lands as suggestions and comments", async () => {
    await expect(view(page).getByRole("button", { name: "Send to Google Docs (2)" })).toBeVisible();
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

  await test.step("you sign in another Google account from the view", async () => {
    writeFileSync(join(gcloud.folder, "next-sign-in"), "ana@work.example.com\n");
    await view(page).getByRole("button", { name: "Sign in a Google account" }).click();
    await expect(view(page).locator(".task.done")).toHaveText("Signed in: ana@example.com, ana@work.example.com.");
  });
});
