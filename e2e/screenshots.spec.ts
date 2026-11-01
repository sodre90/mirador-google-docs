import { readFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import { fakeGcloud } from "../tests/fake-google.ts";

test.skip(process.env.MIRADOR_SCREENSHOTS !== "1", "Screenshots are taken only with MIRADOR_SCREENSHOTS=1");
test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "light" });

const miradorDir = process.env.MIRADOR_DIR ?? join(import.meta.dirname, "..", "..", "visualized-claude-sessions");
const pluginDir = process.env.GOOGLE_DOCS_PLUGIN_DIR ?? join(import.meta.dirname, "..");
const screenshotsDir = process.env.SCREENSHOTS_DIR ?? join(import.meta.dirname, "..", "screenshots");
const profileName = "docs";
const account = "docs-writer";
const docUrl = "https://docs.google.com/document/d/1proposalDocumentIdForScreenshots/edit";

type Helpers = typeof import("../../visualized-claude-sessions/e2e/helpers.ts");
type TestHostModule = typeof import("../../visualized-claude-sessions/e2e/test-host.ts");
let mirador: Helpers;
let host: InstanceType<TestHostModule["TestHost"]>;
let googleServer: Server;

type Piece = string | { text: string; bold?: boolean; insertedBy?: string; deletedBy?: string };

function proposalDocument() {
  let index = 1;
  const paragraph = (style: string, pieces: Piece[]) => {
    const startIndex = index;
    const elements = pieces.map((piece) => {
      const { text, bold, insertedBy, deletedBy } = typeof piece === "string" ? { text: piece } : piece;
      const element = {
        startIndex: index,
        endIndex: index + text.length,
        textRun: {
          content: text,
          textStyle: bold ? { bold: true } : {},
          ...(insertedBy ? { suggestedInsertionIds: [insertedBy] } : {}),
          ...(deletedBy ? { suggestedDeletionIds: [deletedBy] } : {}),
        },
      };
      index += text.length;
      return element;
    });
    elements.at(-1)!.textRun.content += "\n";
    elements.at(-1)!.endIndex += 1;
    index += 1;
    return { startIndex, endIndex: index, paragraph: { elements, paragraphStyle: { namedStyleType: style } } };
  };
  const content = [
    { endIndex: 1, sectionBreak: {} },
    paragraph("HEADING_1", ["Website redesign proposal"]),
    paragraph("HEADING_2", ["Summary"]),
    paragraph("NORMAL_TEXT", ["We propose to rebuild the company website so that customers can find pricing and book a demo in under a minute. The current site is slow and hard to use on phones."]),
    paragraph("HEADING_2", ["Timeline"]),
    paragraph("NORMAL_TEXT", ["The work takes about ten weeks: ", { text: "design first", bold: true }, ", then the build, then a two-week test with real customers."]),
    paragraph("HEADING_2", ["Budget"]),
    paragraph("NORMAL_TEXT", ["Design and build cost ", { text: "40k", insertedBy: "suggest.budget" }, { text: "35k", deletedBy: "suggest.budget" }, " in total, plus hosting."]),
  ];
  return {
    documentId: "1proposalDocumentIdForScreenshots",
    title: "Website redesign proposal",
    revisionId: "rev-1",
    tabs: [{ tabProperties: { tabId: "t.0", title: "Proposal", index: 0 }, documentTab: { body: { content } } }],
    comments: [
      {
        commentId: "doco.timeline",
        status: "OPEN",
        plainTextQuote: "design first",
        headPost: { postId: "doco.timeline", content: "Can design start earlier, before the budget is signed off?", author: { displayName: "Maya" }, createTime: "2026-10-20T10:00:00Z" },
        replies: [{ postId: "doco.timeline.1", content: "Only the first two weeks, as discovery.", author: { displayName: "Sam" }, createTime: "2026-10-20T11:00:00Z" }],
      },
    ],
    suggestions: [{ suggestionId: "suggest.budget", status: "OPEN", summaryText: "Replace: “35k” with “40k”", headPost: { author: { displayName: "Sam" } } }],
    suggestionsViewMode: "SUGGESTIONS_INLINE",
    commentsViewMode: "COMMENTS_VIEW_MODE_INCLUDED",
  };
}

function startGoogle(): Promise<string> {
  googleServer = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.setHeader("Content-Type", "application/json");
      if (request.headers.authorization !== `Bearer token-for-${account}`) {
        response.statusCode = 403;
        response.end(JSON.stringify({ error: { message: "The caller does not have permission" } }));
      } else if (request.method === "POST") response.end(JSON.stringify({ replies: [], writeControl: { requiredRevisionId: "rev-2" } }));
      else response.end(JSON.stringify(proposalDocument()));
    });
  });
  return new Promise((resolve) => googleServer.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(googleServer.address() as AddressInfo).port}`)));
}

const view = (page: Page): FrameLocator => page.frameLocator(".canvas-panel:visible .canvas-frame.app iframe");
const tool = (conversation: string, name: string, args: Record<string, unknown>) => mirador.callCanvasTool(host, conversation, name, args);
const shot = (page: Page, name: string) => page.locator(".canvas-panel:visible").screenshot({ path: join(screenshotsDir, `${name}.png`) });

test.beforeAll(async () => {
  if (process.env.MIRADOR_SCREENSHOTS !== "1") return;
  mkdirSync(screenshotsDir, { recursive: true });
  const { TestHost, writeBunProgram } = (await import(join(miradorDir, "e2e", "test-host.ts"))) as TestHostModule;
  mirador = (await import(join(miradorDir, "e2e", "helpers.ts"))) as Helpers;
  const apiUrl = await startGoogle();
  const gcloud = fakeGcloud([account]);
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
  googleServer?.close();
});

test("screenshots of the agent proposing edits to a project proposal", async ({ page }) => {
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

  await tool(conversation, "app_open", { app: "google-docs", file: "website-proposal.gdoc" });
  await tool(conversation, "apply", { op: { op: "link", url: docUrl } });
  await tool(conversation, "app_run", { task: "pull" });
  await expect(view(page).locator("h1")).toHaveText("Website redesign proposal");

  await tool(conversation, "apply", { op: { op: "replace", block: "p3", quote: "hard to use on phones", with: "difficult to use on a phone" } });
  await tool(conversation, "apply", { op: { op: "replace", block: "p5", quote: "ten weeks", with: "twelve weeks" } });
  await tool(conversation, "apply", { op: { op: "insert", block: "p7", after: "plus hosting", text: " and support for the first year" } });
  await tool(conversation, "apply", { op: { op: "reply", thread: "doco.timeline", text: "Agreed: discovery can start now, and design follows once the budget is signed off.", resolve: false } });
  await expect(view(page).getByRole("tab", { selected: true })).toHaveText("To send 4");
  await page.screenshot({ path: "/tmp/probe-1.png" });
  await page.getByRole("button", { name: "Fullscreen canvas" }).click();
  await view(page).getByRole("tab", { name: /^To send/ }).click();
  await view(page).locator('.change[data-change="c1"]').getByRole("button", { name: "Approve" }).click();
  await expect(view(page).locator('[data-block="p5"] ins')).toHaveText("twelve weeks");
  await shot(page, "proposed-changes");

  await view(page).getByRole("tab", { name: /^Comments/ }).click();
  const thread = view(page).locator('.thread[data-thread="doco.timeline"]');
  await thread.locator(".card-head").click();
  await expect(thread).toContainText("Only the first two weeks");
  await shot(page, "comment-thread");

  await view(page).getByRole("tab", { name: /^To send/ }).click();
  await view(page)
    .locator('[data-block="p3"]')
    .evaluate((paragraph) => {
      const wanted = "pricing and book a demo in under a minute";
      const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent!.indexOf(wanted);
        if (at === -1) continue;
        getSelection()!.setBaseAndExtent(node, at, node, at + wanted.length);
        node.parentElement!.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
        return;
      }
      throw new Error(`${wanted} isn't in one piece of ${paragraph.textContent}`);
    });
  await expect(view(page).getByRole("dialog", { name: "Selected text" })).toBeVisible();
  await shot(page, "ask-the-agent");
});
