import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppAuthor, AppChange, AppTaskContext } from "../mirador/api.ts";
import { pull, push, signInTask } from "../host/tasks.ts";
import { checkedDocument, type GoogleDoc } from "../shared/document.ts";
import { applyOperation } from "../shared/operations.ts";
import fixture from "./fixtures/launch-plan.json";
import { fakeGcloud, fakeGoogle, type FakeGoogle } from "./fake-google.ts";

const URL = "https://docs.google.com/document/d/1testDocumentIdForMiradorGoogleDocs/edit";
const agent: AppAuthor = { kind: "agent", conversationId: "c1", turnSeq: 1 };
const you: AppAuthor = { kind: "you" };

let google: FakeGoogle;
let gcloud: ReturnType<typeof fakeGcloud>;

beforeEach(() => {
  google = fakeGoogle(fixture, ["work@example.com"]);
  gcloud = fakeGcloud(["home@example.com", "work@example.com"]);
  Object.assign(process.env, { GOOGLE_DOCS_API_URL: google.url, GOOGLE_DOCS_GCLOUD: gcloud.program });
});
afterEach(() => google.stop());

/** Runs a task the way Mirador does, applying its operations to the document as whoever ran it. */
async function run(task: typeof pull, document: GoogleDoc, author: AppAuthor = agent) {
  let current = document;
  const progress: string[] = [];
  const context = {
    document,
    author,
    apply: async (operation: unknown) => {
      const applied = applyOperation(current, operation, author);
      current = applied.document;
      return { seq: 1, author, summary: applied.summary, touched: [], at: 0 } satisfies AppChange;
    },
    progress: (_done: number | null, text?: string) => progress.push(text ?? ""),
    signal: new AbortController().signal,
  } as unknown as AppTaskContext<GoogleDoc>;
  const summary = await task.run(context);
  return { summary, document: current, progress };
}

describe("pull", () => {
  test("tries each signed-in account until one may read the doc, and keeps that one", async () => {
    const { summary, document } = await run(pull, checkedDocument({ url: URL }));
    expect(summary).toBe("Read “Launch plan” as work@example.com: 7 blocks, 1 comment thread, 1 open suggestion.");
    expect(google.tokens).toEqual(["token-for-home@example.com", "token-for-work@example.com"]);
    expect(document.snapshot!.account).toBe("work@example.com");
    google.tokens.length = 0;
    await run(pull, document);
    expect(google.tokens).toEqual(["token-for-work@example.com"]);
  });

  test("says to sign in when nobody is, when a session ended, or when no account may read the doc", async () => {
    writeFileSync(join(gcloud.folder, "accounts"), "");
    await expect(run(pull, checkedDocument({ url: URL }))).rejects.toThrow("No Google account is signed in yet");
    writeFileSync(join(gcloud.folder, "accounts"), "home@example.com\nwork@example.com\n");
    writeFileSync(join(gcloud.folder, "expired"), "work@example.com\n");
    await expect(run(pull, checkedDocument({ url: URL }))).rejects.toThrow(
      "None of the signed-in accounts could read https://docs.google.com/document/d/1testDocumentIdForMiradorGoogleDocs/edit: home@example.com can't open it (403). work@example.com's Google sign-in has ended or needs confirming (ERROR: (gcloud.auth.print-access-token) Reauthentication failed. cannot prompt during non-interactive execution.). Sign it in again with Sign in a Google account.",
    );
    expect(google.tokens.join()).not.toContain("work@example.com");
  });
});

describe("push", () => {
  async function approvedChanges() {
    const pulled = (await run(pull, checkedDocument({ url: URL }))).document;
    return [
      [{ op: "replace", block: "p2", quote: "by Q3", with: "by the end of October" }, agent],
      [{ op: "comment", block: "p2", quote: "launch", text: "Which one?" }, you],
      [{ op: "delete", block: "p1", quote: "Launch " }, agent],
      [{ op: "approve", changes: ["c1"] }, you],
    ].reduce((document, [operation, author]) => applyOperation(document, operation, author as AppAuthor).document, pulled);
  }

  test("only the user may send, and only what they approved", async () => {
    const document = await approvedChanges();
    await expect(run(push, document, agent)).rejects.toThrow("Only the user sends changes to Google Docs, with Send in the view.");
    expect(google.batches).toEqual([]);
    const { summary, document: after } = await run(push, document, you);
    expect(summary).toBe("Sent c2, c1; the edits are suggestions in the doc now.");
    expect(google.batches).toEqual([
      { requests: [{ insertComment: { content: "Which one?", range: { startIndex: 17, endIndex: 23, tabId: "t.0" } } }] },
      {
        requests: [
          { deleteContentRange: { range: { startIndex: 35, endIndex: 40, tabId: "t.0" } } },
          { insertText: { location: { index: 35, tabId: "t.0" }, text: "by the end of October" } },
        ],
        writeControl: { writeMode: "SUGGEST", targetRevisionId: "rev-1" },
      },
    ]);
    expect(after.changes.map(({ id, approved }) => [id, approved])).toEqual([["c3", false]]);
  });

  test("with direct edits on, your edit goes in first; when reading the doc again then fails, it isn't sent twice", async () => {
    const linked = (await run(pull, checkedDocument({ url: URL }))).document;
    const document = [
      [{ op: "direct-edits", on: true }, you],
      [{ op: "write", block: "p4", text: "We ship by May and review by Q3." }, you],
      [{ op: "replace", block: "p2", quote: "by Q3", with: "soon" }, agent],
      [{ op: "approve-all" }, you],
    ].reduce((current, [operation, author]) => applyOperation(current, operation, author as AppAuthor).document, linked);
    const both = await run(push, document, you);
    expect(both.summary).toBe("Sent c1, c2; c1 is in the doc; c2 is a suggestion.");
    expect(google.batches.map(({ writeControl }) => writeControl)).toEqual([{ targetRevisionId: "rev-1" }, { writeMode: "SUGGEST", targetRevisionId: "rev-1" }]);
    google.batches.length = 0;
    google.readsLeft = 1;
    const cut = await run(push, document, you);
    expect(cut.summary).toBe("Sent c1; c1 is in the doc. The rest wasn't sent: Google Docs said 500: Backend Error. Reading it again failed (Google Docs said 500: Backend Error): read it again before sending more.");
    expect(google.batches).toHaveLength(1);
    expect(cut.document.changes.map(({ id }) => id)).toEqual(["c2"]);
  });

  test("keeps a change whose text a collaborator removed, and sends the others", async () => {
    const document = applyOperation(await approvedChanges(), { op: "approve-all" }, you).document;
    const edited = structuredClone(fixture);
    edited.tabs[0]!.documentTab.body.content[1]!.paragraph!.elements[0]!.textRun!.content = "Spring plan\n";
    google.document = edited;
    const { summary, document: after } = await run(push, document, you);
    expect(summary).toBe("Sent c2, c1; the edits are suggestions in the doc now. c3 stayed pending: c3: \"Launch \" isn't in the doc any more.");
    expect(after.changes).toMatchObject([{ id: "c3", approved: true, note: "\"Launch \" isn't in the doc any more." }]);
  });
});

test("sign-in adds the account the user picked in the browser", async () => {
  writeFileSync(join(gcloud.folder, "next-sign-in"), "new@example.com\n");
  expect((await run(signInTask, checkedDocument({ url: URL }), you)).summary).toBe("Signed in: home@example.com, work@example.com, new@example.com.");
});
