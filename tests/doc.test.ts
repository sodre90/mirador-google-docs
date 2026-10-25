import { describe, expect, test } from "bun:test";
import type { AppAuthor } from "../mirador/api.ts";
import { anchorIn, locate } from "../shared/anchor.ts";
import { snapshotOf, type GoogleDocument } from "../shared/convert.ts";
import { describeDocument } from "../shared/describe.ts";
import { checkedDocument, newDocument, OBJECT_MARK, type GoogleDoc, type Paragraph, type Snapshot } from "../shared/document.ts";
import { applyOperation } from "../shared/operations.ts";
import { planPush } from "../shared/push.ts";
import fixture from "./fixtures/launch-plan.json";

const URL = "https://docs.google.com/document/d/1testDocumentIdForMiradorGoogleDocs/edit";
const agent: AppAuthor = { kind: "agent", conversationId: "c1", turnSeq: 1 };
const you: AppAuthor = { kind: "you" };

const snapshot = (google: GoogleDocument = fixture as GoogleDocument) => snapshotOf(google, "ana@example.com", Date.UTC(2026, 9, 25, 12, 0));
const paragraph = (from: Snapshot, id: string) => from.tabs.flatMap((tab) => tab.blocks).find((block) => block.id === id) as Paragraph;

/** The fixture with one paragraph's text changed, as a collaborator's edit leaves it: every later index moves along. */
function editedFixture(edit: (text: string) => string, paragraphText: string): GoogleDocument {
  const copy = structuredClone(fixture) as unknown as { tabs: { documentTab: { body: { content: { startIndex?: number; endIndex: number; paragraph?: { elements: { startIndex: number; endIndex: number; textRun?: { content: string } }[] } }[] } } }[] };
  const content = copy.tabs[0]!.documentTab.body.content;
  let shift = 0;
  for (const element of content) {
    if (element.startIndex !== undefined) element.startIndex += shift;
    const runs = element.paragraph?.elements ?? [];
    const whole = runs.map((run) => run.textRun?.content ?? "").join("");
    if (whole === `${paragraphText}\n`) {
      const changed = `${edit(paragraphText)}\n`;
      runs.splice(0, runs.length, { startIndex: element.startIndex!, endIndex: element.startIndex! + changed.length, textRun: { content: changed } });
      shift += changed.length - whole.length;
    } else for (const run of runs) Object.assign(run, { startIndex: run.startIndex + shift, endIndex: run.endIndex + shift });
    element.endIndex += shift;
  }
  return copy as unknown as GoogleDocument;
}

const linked = (): GoogleDoc => ({ ...checkedDocument({ url: URL }), snapshot: snapshot() });

function applied(document: GoogleDoc, ...steps: [unknown, AppAuthor][]) {
  return steps.reduce((current, [operation, author]) => applyOperation(current, operation, author).document, document);
}

describe("reading a Google doc", () => {
  test("numbers paragraphs and tables through every tab, child tabs too, and keeps styles and bullets", () => {
    const read = snapshot();
    expect(read.tabs.map(({ id, title, blocks }) => [id, title, blocks.map(({ id }) => id)])).toEqual([
      ["t.0", "Plan", ["p1", "p2", "p3", "t1", "p4", "p5"]],
      ["t.1", "Notes", ["p6"]],
    ]);
    expect(paragraph(read, "p1")).toMatchObject({ style: "HEADING_1", text: "Launch plan", startIndex: 1 });
    expect(paragraph(read, "p3").bullet).toEqual({ nesting: 0 });
    expect(read.tabs[0]!.blocks[3]).toEqual({ kind: "table", id: "t1", rows: [["Risk", "Low"]] });
  });

  test("counts text in UTF-16 code units, as Google does, so an emoji takes two places", () => {
    const p2 = paragraph(snapshot(), "p2");
    expect(p2.text).toBe("The launch is planned by Q3 🚀.");
    expect(p2.runs.map(({ text, start, bold }) => [text, start, bold ?? false])).toEqual([
      ["The ", 0, false],
      ["launch", 4, true],
      [" is planned by Q3 🚀.", 10, false],
    ]);
    expect(p2.startIndex + p2.text.length + 1).toBe(45);
  });

  test("stands an object in for its places, and marks Google's own suggestions on their text", () => {
    const read = snapshot();
    expect(paragraph(read, "p3").text).toBe(`${OBJECT_MARK} Owner: Ana`);
    expect(paragraph(read, "p5").runs.map(({ text, inserted, deleted }) => [text, inserted ?? deleted ?? null])).toEqual([
      ["Budget: ", null],
      ["10k", ["suggest.a"]],
      ["5k", ["suggest.a"]],
    ]);
    expect(read.suggestions).toEqual([{ id: "suggest.a", summary: "Replace: “5k” with “10k”", author: "Ben" }]);
    expect(read.threads).toEqual([
      {
        id: "doco.thread1",
        quote: "launch",
        status: "open",
        posts: [
          { author: "Ana", content: "Which launch?", at: "2026-10-20T10:00:00Z" },
          { author: "Ben", content: "The spring one.", at: "2026-10-20T11:00:00Z" },
        ],
      },
    ]);
  });
});

describe("anchors", () => {
  test("anchor a quote that appears once in its paragraph, with the text around it", () => {
    expect(anchorIn(snapshot(), "p2", "by Q3")).toEqual({ tab: "t.0", block: "p2", quote: "by Q3", prefix: "The launch is planned ", suffix: " 🚀." });
  });

  test("refuse a quote that isn't there, or that appears twice unless at says which", () => {
    expect(() => anchorIn(snapshot(), "p2", "by Q4")).toThrow('"by Q4" isn\'t in p2; its text is "The launch is planned by Q3 🚀."');
    expect(() => anchorIn(snapshot(), "p4", "by Q3")).toThrow('"by Q3" appears 2 times in p4; quote more of the text around it, or give at');
    expect(anchorIn(snapshot(), "p4", "by Q3", 25)).toMatchObject({ prefix: "e ship by Q3 and review ", suffix: "." });
    expect(() => anchorIn(snapshot(), "p4", "by Q3", 3)).toThrow("p4 doesn't have \"by Q3\" at 3");
    expect(() => anchorIn(snapshot(), "t1", "Risk")).toThrow("There's no paragraph t1");
  });

  test("find their quote again after a collaborator's edit moved it, and tell which twin by the text around it", () => {
    const anchor = anchorIn(snapshot(), "p4", "by Q3", 25);
    const moved = snapshotOf(editedFixture((text) => `Today: ${text}`, "We ship by Q3 and review by Q3."), "ana@example.com", 0);
    expect(locate(anchor, moved)).toMatchObject({ start: 32, startIndex: 72 + 32, endIndex: 72 + 37 });
    const later = snapshotOf(editedFixture(() => "We ship by Q3 and review it all", "We ship by Q3 and review by Q3."), "ana@example.com", 0);
    expect(locate(anchor, later)).toEqual({ problem: "\"by Q3\" isn't in the doc any more where it was." });
    expect(locate(anchorIn(snapshot(), "p2", "🚀"), snapshotOf(editedFixture(() => "No rocket", "The launch is planned by Q3 🚀."), "a", 0))).toEqual({ problem: '"🚀" isn\'t in the doc any more.' });
  });
});

describe("operations", () => {
  test("the agent's changes wait for approval, which only the user can give", () => {
    const proposed = applyOperation(linked(), { op: "replace", block: "p2", quote: "by Q3", with: "by the end of October" }, agent);
    expect(proposed.summary).toBe("Proposed c1: replace “by Q3” in p2 with “by the end of October”.");
    expect(proposed.document.changes[0]).toMatchObject({ id: "c1", kind: "replace", by: "agent", approved: false });
    expect(proposed.inverse).toEqual({ op: "drop", change: "c1" });
    expect(() => applyOperation(proposed.document, { op: "approve", change: "c1" }, agent)).toThrow("Only the user can approve a change, in the view.");
    expect(() => applyOperation(proposed.document, { op: "approve-all" }, agent)).toThrow("Only the user can approve changes");
    expect(() => applyOperation(proposed.document, { op: "approve", change: "c1" }, undefined)).toThrow("Only the user");
    expect(applyOperation(proposed.document, { op: "approve", change: "c1" }, you).document.changes[0]!.approved).toBe(true);
  });

  test("the user's own comments and replies count as approved; the agent may not drop them", () => {
    const document = applied(linked(), [{ op: "comment", block: "p2", quote: "launch", text: "Say which" }, you], [{ op: "reply", thread: "doco.thread1", text: "Thanks", resolve: true }, you]);
    expect(document.changes.map(({ id, by, approved }) => [id, by, approved])).toEqual([
      ["c1", "you", true],
      ["c2", "you", true],
    ]);
    expect(() => applyOperation(document, { op: "drop", change: "c1" }, agent)).toThrow("c1 is the user's own; only they can drop it.");
    expect(() => applyOperation(document, { op: "reply", thread: "doco.nope", text: "Hi" }, agent)).toThrow("There's no comment thread doco.nope");
  });

  test("an approved change the agent brings back after a drop or a send comes back unapproved", () => {
    const approved = applied(linked(), [{ op: "delete", block: "p2", quote: " 🚀" }, agent], [{ op: "approve-all" }, you]);
    const dropped = applyOperation(approved, { op: "drop", change: "c1" }, agent);
    expect(applyOperation(dropped.document, dropped.inverse, agent).document.changes[0]).toMatchObject({ id: "c1", approved: false });
    expect(applyOperation(dropped.document, dropped.inverse, you).document.changes[0]).toMatchObject({ id: "c1", approved: true });
    const sent = applyOperation(approved, { op: "sent", changes: ["c1"] }, you);
    expect(sent.document.changes).toEqual([]);
    expect(applyOperation(sent.document, sent.inverse, agent).document.changes[0]!.approved).toBe(false);
  });

  test("explain what's missing before a doc is linked and read, and refuse another link while changes wait", () => {
    expect(() => applyOperation(newDocument(), { op: "replace", block: "p1", quote: "a", with: "b" }, agent)).toThrow('No doc is linked yet: apply { "op": "link"');
    const linkedOnly = applyOperation(newDocument(), { op: "link", url: URL }, agent).document;
    expect(linkedOnly.documentId).toBe("1testDocumentIdForMiradorGoogleDocs");
    expect(() => applyOperation(linkedOnly, { op: "delete", block: "p1", quote: "a" }, agent)).toThrow('run app_run with the task "pull" first');
    const pending = applied(linked(), [{ op: "delete", block: "p2", quote: "The " }, agent]);
    expect(() => applyOperation(pending, { op: "link", url: URL.replace("1test", "2test") }, agent)).toThrow("Send or drop the 1 pending changes");
    expect(() => applyOperation(newDocument(), { op: "link", url: "https://example.com/doc" }, agent)).toThrow("isn't a Google Docs address");
  });

  test("a pull notes the changes whose text it can't find once any more", () => {
    const pending = applied(linked(), [{ op: "replace", block: "p2", quote: "🚀", with: "!" }, agent], [{ op: "delete", block: "p1", quote: "plan" }, agent]);
    const pulled = applyOperation(pending, { op: "pulled", snapshot: snapshotOf(editedFixture(() => "No rocket", "The launch is planned by Q3 🚀."), "a", 0) }, agent);
    expect(pulled.document.changes.map(({ id, note }) => [id, note ?? null])).toEqual([
      ["c1", '"🚀" isn\'t in the doc any more.'],
      ["c2", null],
    ]);
    expect(pulled.touched).toEqual(["c1"]);
  });
});

describe("sending", () => {
  test("sends two edits in one paragraph from the end back, each range in its tab, and comments in a batch of their own", () => {
    const document = applied(
      linked(),
      [{ op: "replace", block: "p2", quote: "by Q3", with: "by the end of October" }, agent],
      [{ op: "insert", block: "p2", after: "launch", text: " of Mirador" }, agent],
      [{ op: "delete", block: "p6", quote: " by Q3" }, agent],
      [{ op: "comment", block: "p2", quote: "🚀", text: "Too playful?" }, you],
      [{ op: "reply", thread: "doco.thread1", text: "Fixed", resolve: true }, agent],
      [{ op: "approve-all" }, you],
    );
    const plan = planPush(document, snapshot());
    expect(plan.problems).toEqual({});
    expect(plan.suggestionChanges).toEqual(["c1", "c2", "c3"]);
    expect(plan.suggestionRequests).toEqual([
      { deleteContentRange: { range: { startIndex: 35, endIndex: 40, tabId: "t.0" } } },
      { insertText: { location: { index: 35, tabId: "t.0" }, text: "by the end of October" } },
      { insertText: { location: { index: 23, tabId: "t.0" }, text: " of Mirador" } },
      { deleteContentRange: { range: { startIndex: 6, endIndex: 12, tabId: "t.1" } } },
    ]);
    expect(plan.commentChanges).toEqual(["c4", "c5"]);
    expect(plan.commentRequests).toEqual([
      { insertComment: { content: "Too playful?", range: { startIndex: 41, endIndex: 43, tabId: "t.0" } } },
      { addCommentReply: { commentId: "doco.thread1", post: { content: "Fixed" } } },
      { addCommentReply: { commentId: "doco.thread1", post: { commentAction: "RESOLVE" } } },
    ]);
  });

  test("sends only approved changes, keeps one whose text is gone or that clashes with another, and sends the rest", () => {
    const document = applied(
      linked(),
      [{ op: "replace", block: "p2", quote: "🚀", with: "!" }, agent],
      [{ op: "replace", block: "p2", quote: "Q3 🚀", with: "Q4" }, agent],
      [{ op: "delete", block: "p1", quote: " plan" }, agent],
      [{ op: "delete", block: "p5", quote: "Budget" }, agent],
      [{ op: "approve", changes: ["c1", "c2", "c3"] }, you],
    );
    const plan = planPush(document, snapshotOf(editedFixture((text) => text.replace("plan", "date"), "Launch plan"), "a", 0));
    expect(plan.suggestionChanges).toEqual(["c1"]);
    expect(plan.problems).toEqual({ c2: "It touches the same text as c1; send that one first, then this one again.", c3: '" plan" isn\'t in the doc any more where it was.' });
  });
});

describe("describing the doc for the agent", () => {
  test("lists blocks with ids, styles, others' suggestions, threads and the pending changes", () => {
    const document = applied(linked(), [{ op: "delete", block: "p2", quote: " 🚀" }, agent]);
    const text = describeDocument(document);
    expect(text).toContain("“Launch plan”, read 2026-10-25 12:00 UTC as ana@example.com.");
    expect(text).toContain("p1 [Heading 1] Launch plan\np2 The launch is planned by Q3 🚀.\np3 • [object] Owner: Ana\nt1 [table, read only] Risk | Low");
    expect(text).toContain("p5 Budget: [+10k+][-5k-]");
    expect(text).toContain("Tab “Notes”:\np6 Notes by Q3");
    expect(text).toContain("- doco.thread1 (open) on “launch”: Ana: “Which launch?”; Ben: “The spring one.”");
    expect(text).toContain("- c1 by you, the agent, waiting for approval: delete “ 🚀” in p2");
    expect(describeDocument(newDocument())).toStartWith("No doc is linked yet.");
  });
});
