import { describe, expect, test } from "bun:test";
import type { AppAuthor } from "../mirador/api.ts";
import { anchorIn, locate } from "../shared/anchor.ts";
import { snapshotOf, type GoogleDocument } from "../shared/convert.ts";
import { describeDocument } from "../shared/describe.ts";
import { checkedDocument, newDocument, OBJECT_MARK, type GoogleDoc, type Paragraph, type Snapshot } from "../shared/document.ts";
import { applyOperation, changeSummary } from "../shared/operations.ts";
import { planPush } from "../shared/push.ts";
import { differenceOf, editedText, toWholeWords, unwritable } from "../shared/write.ts";
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
    expect(read.suggestions).toEqual([{ id: "suggest.a", summary: "Replace: “5k” with “10k”", author: "Ben", posts: [] }]);
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
    expect(() => applyOperation(document, { op: "reply", thread: "doco.nope", text: "Hi" }, agent)).toThrow("There's no comment thread or suggestion doco.nope");
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
      [{ op: "delete", block: "p1", quote: " plan" }, agent],
      [{ op: "delete", block: "p5", quote: "Budget" }, agent],
    );
    const savedBeforeClashesWereRefused = applyOperation(linked(), { op: "replace", block: "p2", quote: "Q3 🚀", with: "Q4" }, agent).document.changes[0]!;
    const clashing: GoogleDoc = applied({ ...document, changes: [document.changes[0]!, { ...savedBeforeClashesWereRefused, id: "c4" }, ...document.changes.slice(1)], nextChange: 5 }, [{ op: "approve", changes: ["c1", "c4", "c2"] }, you]);
    const plan = planPush(clashing, snapshotOf(editedFixture((text) => text.replace("plan", "date"), "Launch plan"), "a", 0));
    expect(plan.suggestionChanges).toEqual(["c1"]);
    expect(plan.problems).toEqual({ c4: "It touches the same text as c1, which goes in with this Send: drop this one, or drop c1 and send this one.", c2: '" plan" isn\'t in the doc any more where it was.' });
  });

  test("a text edit touching text another pending one changes is refused, whoever proposes it", () => {
    const document = applied(linked(), [{ op: "replace", block: "p2", quote: "🚀", with: "!" }, agent]);
    expect(() => applyOperation(document, { op: "replace", block: "p2", quote: "Q3 🚀", with: "Q4" }, agent)).toThrow("c1 already changes this text (replace “🚀” in p2 with “!”): drop it first, or make one change that covers both.");
    expect(() => applyOperation(document, { op: "insert", block: "p2", before: "🚀", text: "!" }, you)).toThrow("c1 already changes this text");
    expect(applyOperation(document, { op: "replace", block: "p2", quote: "Q3", with: "Q4" }, agent).summary).toBe("Proposed c2: replace “Q3” in p2 with “Q4”.");
    expect(applyOperation(document, { op: "comment", block: "p2", quote: "Q3 🚀", text: "Sure?" }, agent).summary).toStartWith("Proposed c2: comment");
  });
});

describe("styles", () => {
  test("the agent formats a quote or restyles a paragraph; a change to what's there already, or a bad link, is refused", () => {
    const document = applied(
      linked(),
      [{ op: "format", block: "p4", quote: "Q3 and", bold: true, link: "https://example.com/q3" }, agent],
      [{ op: "format", block: "p2", quote: "launch", bold: false }, agent],
      [{ op: "paragraph", block: "p4", style: "HEADING_2", list: "numbered" }, agent],
      [{ op: "paragraph", block: "p3", list: "none" }, agent],
    );
    expect(document.changes.map(changeSummary)).toEqual([
      "make “Q3 and” in p4 bold, a link to https://example.com/q3",
      "make “launch” in p2 not bold",
      "make p4 Heading 2, a numbered list item",
      "make p3 no list item",
    ]);
    expect(document.changes[2]).toMatchObject({ anchor: { block: "p4", quote: "We ship by Q3 and review by Q3.", prefix: "" } });
    expect(() => applyOperation(linked(), { op: "format", block: "p2", quote: "launch", bold: true }, agent)).toThrow("“launch” is bold already.");
    expect(() => applyOperation(linked(), { op: "format", block: "p2", quote: "launch", link: "javascript:alert(1)" }, agent)).toThrow("link must be an address");
    expect(() => applyOperation(linked(), { op: "format", block: "p2", quote: "launch" }, agent)).toThrow("format needs a style to set");
    expect(() => applyOperation(linked(), { op: "paragraph", block: "p1", style: "HEADING_1" }, agent)).toThrow("p1 is Heading 1 already.");
    expect(() => applyOperation(linked(), { op: "paragraph", block: "p3", list: "bulleted" }, agent)).toThrow("p3 is a bulleted list item already.");
    expect(() => applyOperation(linked(), { op: "paragraph", block: "p2", style: "HEADING_9" }, agent)).toThrow("style must be one of NORMAL_TEXT");
  });

  test("a format clashes with any change on its text; a paragraph's style only with another change of that paragraph", () => {
    const document = applied(linked(), [{ op: "replace", block: "p4", quote: "Q3 and", with: "Q4 and" }, agent], [{ op: "paragraph", block: "p4", style: "HEADING_2" }, agent]);
    expect(() => applyOperation(document, { op: "format", block: "p4", quote: "ship by Q3", bold: true }, agent)).toThrow("c1 already changes this text");
    expect(() => applyOperation(document, { op: "paragraph", block: "p4", list: "bulleted" }, you)).toThrow("c2 already changes this paragraph (make p4 Heading 2): drop it first");
    expect(applyOperation(document, { op: "insert", block: "p4", before: "We", text: "Now " }, agent).summary).toStartWith("Proposed c3");
    expect(applyOperation(document, { op: "format", block: "p4", quote: "review", italic: true }, you).summary).toBe("Added c3: make “review” in p4 italic.");
  });

  test("a nested list item keeps its kind, and a paragraph starting with a tab doesn't become one: either would move text", () => {
    const nested = linked();
    (paragraph(nested.snapshot!, "p3").bullet as { nesting: number }).nesting = 1;
    expect(() => applyOperation(nested, { op: "paragraph", block: "p3", list: "numbered" }, agent)).toThrow("p3 is nested in its list");
    expect(applyOperation(nested, { op: "paragraph", block: "p3", list: "none" }, agent).summary).toBe("Proposed c1: make p3 no list item.");
    const tabbed = linked();
    Object.assign(paragraph(tabbed.snapshot!, "p6"), { text: "\tNotes by Q3" });
    expect(() => applyOperation(tabbed, { op: "paragraph", block: "p6", list: "bulleted" }, agent)).toThrow("p6 starts with a tab");
  });

  test("Send puts the styles in the suggestion batch before the text edits, and paragraphs next to each other in one list", () => {
    const document = applied(
      linked(),
      [{ op: "insert", block: "p4", before: "We", text: "Intro\n" }, agent],
      [{ op: "format", block: "p4", quote: "review", italic: true, link: null }, agent],
      [{ op: "paragraph", block: "p4", style: "HEADING_2", list: "numbered" }, agent],
      [{ op: "paragraph", block: "p5", list: "numbered" }, agent],
      [{ op: "paragraph", block: "p3", list: "none" }, agent],
      [{ op: "approve-all" }, you],
    );
    const plan = planPush(document, snapshot());
    expect(plan.problems).toEqual({});
    expect(plan.suggestionRequests).toEqual([
      { updateTextStyle: { range: { startIndex: 90, endIndex: 96, tabId: "t.0" }, textStyle: { italic: true }, fields: "italic,link" } },
      { updateParagraphStyle: { range: { startIndex: 72, endIndex: 73, tabId: "t.0" }, paragraphStyle: { namedStyleType: "HEADING_2" }, fields: "namedStyleType" } },
      { deleteParagraphBullets: { range: { startIndex: 45, endIndex: 46, tabId: "t.0" } } },
      { createParagraphBullets: { range: { startIndex: 72, endIndex: 105, tabId: "t.0" }, bulletPreset: "NUMBERED_DECIMAL_ALPHA_ROMAN" } },
      { insertText: { location: { index: 72, tabId: "t.0" }, text: "Intro\n" } },
    ]);
  });

  test("a pull reads numbered lists and Google's own style suggestions, which make a card when the doc lists none, and stop typing there", () => {
    const google = structuredClone(fixture) as unknown as { tabs: { documentTab: { lists?: unknown; body: { content: { paragraph?: { bullet?: unknown; suggestedParagraphStyleChanges?: unknown; elements: { textRun?: { suggestedTextStyleChanges?: unknown } }[] } }[] } } }[] };
    const content = google.tabs[0]!.documentTab.body.content.filter(({ paragraph }) => paragraph);
    google.tabs[0]!.documentTab.lists = { "kix.list": { listProperties: { nestingLevels: [{ glyphType: "DECIMAL" }] } } };
    content[1]!.paragraph!.elements[0]!.textRun!.suggestedTextStyleChanges = { "suggest.bold": { textStyle: { bold: true }, textStyleSuggestionState: { boldSuggested: true } } };
    const budget = content[4]!.paragraph!.elements.find((element) => (element as { textRun?: { suggestedInsertionIds?: string[] } }).textRun?.suggestedInsertionIds)!;
    budget.textRun!.suggestedTextStyleChanges = { "suggest.a": {} };
    content[3]!.paragraph!.suggestedParagraphStyleChanges = { "suggest.heading": {} };
    const read = snapshot(google as unknown as GoogleDocument);
    expect(paragraph(read, "p3").bullet).toEqual({ nesting: 0, numbered: true });
    expect(paragraph(read, "p2").runs[0]!.restyled).toEqual(["suggest.bold"]);
    expect(paragraph(read, "p4").restyled).toEqual(["suggest.heading"]);
    expect(paragraph(read, "p5").runs.some((run) => run.restyled)).toBe(false);
    expect(read.suggestions.map(({ id, summary }) => [id, summary])).toEqual([
      ["suggest.a", "Replace: “5k” with “10k”"],
      ["suggest.bold", "A change of style"],
      ["suggest.heading", "A change of style"],
    ]);
    expect(unwritable(paragraph(read, "p4"))).toStartWith("This paragraph has suggestions in the doc");
    expect(describeDocument({ ...linked(), snapshot: read })).toContain("p3 1. [object] Owner: Ana\nt1");
    expect(describeDocument({ ...linked(), snapshot: read })).toContain("p4 We ship by Q3 and review by Q3. (style suggestion suggest.heading)");
  });

  test("typing over text with a pending change of style is refused, whoever made it", () => {
    const document = applied(linked(), [{ op: "format", block: "p4", quote: "review", italic: true }, you]);
    expect(() => applyOperation(document, { op: "write", block: "p4", text: "We ship by Q3 and check by Q3." }, you)).toThrow("c1 changes the style of this text: send or drop it first, then type here.");
    expect(applyOperation(document, { op: "write", block: "p4", text: "We ship by Q4 and review by Q3." }, you).summary).toBe("Wrote c2: replace “Q3” in p4 with “Q4”.");
  });
});

describe("suggestions in the doc", () => {
  test("Send skips a second decision on one suggestion, as docs saved before it was refused can hold", () => {
    const accept = { kind: "accept", suggestion: "suggest.a", by: "you", approved: true } as const;
    const document: GoogleDoc = { ...linked(), changes: [{ ...accept, id: "c1" }, { ...accept, id: "c2" }], nextChange: 3 };
    const plan = planPush(document, snapshot());
    expect(plan.decisionRequests).toEqual([{ acceptSuggestion: { suggestionId: "suggest.a" } }]);
    expect(plan.problems).toEqual({ c2: "c1 already decides that suggestion; drop this one." });
  });

  test("a suggestion is accepted or rejected once, and a thread resolved once, until that change is dropped", () => {
    const decided = applied(linked(), [{ op: "accept", suggestion: "suggest.a" }, you], [{ op: "resolve", thread: "doco.thread1" }, you]);
    expect(() => applyOperation(decided, { op: "accept", suggestion: "suggest.a" }, you)).toThrow("c1 already does that: accept suggestion suggest.a. Drop it first to decide otherwise.");
    expect(() => applyOperation(decided, { op: "reject", suggestion: "suggest.a" }, agent)).toThrow("c1 already does that");
    expect(() => applyOperation(decided, { op: "reply", thread: "doco.thread1", text: "Done.", resolve: true }, you)).toThrow("c2 already does that: resolve thread doco.thread1.");
    expect(applyOperation(decided, { op: "reply", thread: "doco.thread1", text: "Done." }, you).document.changes).toHaveLength(3);
    const dropped = applied(decided, [{ op: "drop", change: "c1" }, you]);
    expect(applyOperation(dropped, { op: "reject", suggestion: "suggest.a" }, you).summary).toBe("Added c3: reject suggestion suggest.a.");
  });

  test("a doc saved before suggestions kept their replies still reads", () => {
    const saved = snapshot();
    const older = { ...saved, suggestions: saved.suggestions.map(({ posts, ...rest }) => rest) };
    const document = checkedDocument(JSON.parse(JSON.stringify({ url: URL, snapshot: older, changes: [], nextChange: 1 })));
    expect(document.snapshot!.suggestions.every(({ posts }) => posts.length === 0)).toBe(true);
    expect(describeDocument(document)).toContain("Suggestions in the doc:");
  });

  test("you accept, reject or reply to one; it goes last on Send, after the edits placed in the text it changes", () => {
    const document = applied(
      linked(),
      [{ op: "reject", suggestion: "suggest.a" }, agent],
      [{ op: "reply", thread: "suggest.a", text: "10k is too much" }, you],
      [{ op: "replace", block: "p2", quote: "by Q3", with: "soon" }, agent],
      [{ op: "approve-all" }, you],
    );
    expect(document.changes.map(({ id, kind, by }) => [id, kind, by])).toEqual([
      ["c1", "reject", "agent"],
      ["c2", "reply", "you"],
      ["c3", "replace", "agent"],
    ]);
    const plan = planPush(document, snapshot());
    expect(plan.commentRequests).toEqual([{ addCommentReply: { commentId: "suggest.a", post: { content: "10k is too much" } } }]);
    expect(plan.suggestionChanges).toEqual(["c3"]);
    expect(plan.decisionChanges).toEqual(["c1"]);
    expect(plan.decisionRequests).toEqual([{ rejectSuggestion: { suggestionId: "suggest.a" } }]);
    const accepted = applied(linked(), [{ op: "accept", suggestion: "suggest.a" }, you]);
    expect(planPush(accepted, snapshot()).decisionRequests).toEqual([{ acceptSuggestion: { suggestionId: "suggest.a" } }]);
  });

  test("refuse a suggestion that isn't open, and resolving one, which is for comments", () => {
    expect(() => applyOperation(linked(), { op: "accept", suggestion: "suggest.zz" }, you)).toThrow("There's no open suggestion suggest.zz");
    expect(() => applyOperation(linked(), { op: "resolve", thread: "suggest.a" }, you)).toThrow("suggest.a is a suggestion: accept or reject it instead");
    const gone = { ...snapshot(), suggestions: [] };
    const document = applied(linked(), [{ op: "accept", suggestion: "suggest.a" }, you]);
    expect(planPush(document, gone).problems).toEqual({ c1: "The suggestion isn't open in the doc any more." });
    expect(describeDocument(linked())).toContain("Suggestions in the doc:\n- suggest.a by Ben: Replace: “5k” with “10k”");
  });
});

type FixtureTab = { tabProperties: { tabId: string }; childTabs?: FixtureTab[]; documentTab: { body: { content: unknown[] } } };

const emptyParagraphAt = (startIndex: number) => ({ startIndex, endIndex: startIndex + 1, paragraph: { elements: [{ startIndex, endIndex: startIndex + 1, textRun: { content: "\n", textStyle: {} } }], paragraphStyle: { namedStyleType: "NORMAL_TEXT" } } });

const paragraphAt = (startIndex: number, text: string) => ({ startIndex, endIndex: startIndex + text.length + 1, paragraph: { elements: [{ startIndex, endIndex: startIndex + text.length + 1, textRun: { content: `${text}\n`, textStyle: {} } }], paragraphStyle: { namedStyleType: "NORMAL_TEXT" } } });

/**
 * The fixture with an empty paragraph after "Notes by Q3" in the second tab, and, if asked, another one at the end of the
 * first, or a second empty one in the second tab after a paragraph "Ask Ana".
 */
function withEmptyParagraphs({ alsoInFirstTab = false, twoInSecondTab = false } = {}): GoogleDocument {
  const copy = structuredClone(fixture) as unknown as { tabs: FixtureTab[] };
  const tabs = copy.tabs.flatMap((tab) => [tab, ...(tab.childTabs ?? [])]);
  const notes = tabs.find(({ tabProperties }) => tabProperties.tabId === "t.1")!.documentTab.body.content;
  notes.push(emptyParagraphAt(13));
  if (twoInSecondTab) notes.push(paragraphAt(14, "Ask Ana"), emptyParagraphAt(22));
  if (alsoInFirstTab) tabs.find(({ tabProperties }) => tabProperties.tabId === "t.0")!.documentTab.body.content.push(emptyParagraphAt(118));
  return copy as unknown as GoogleDocument;
}

describe("typing into the doc", () => {
  const write = (document: GoogleDoc, block: string, text: string) => applyOperation(document, { op: "write", block, text }, you);

  test("the difference of two texts is what lies between their common start and end", () => {
    expect(differenceOf("We ship by Q3.", "We ship by Q3.")).toBeNull();
    expect(differenceOf("We ship by Q3.", "We ship by the end of Q3.")).toEqual({ start: 11, end: 11, text: "the end of " });
    expect(differenceOf("We ship by Q3.", "We ship.")).toEqual({ start: 7, end: 13, text: "" });
    expect(differenceOf("aaa", "aaaa")).toEqual({ start: 3, end: 3, text: "a" });
    expect(toWholeWords("We ship", "So we ship", { start: 0, end: 1, text: "So w" })).toEqual({ start: 0, end: 2, text: "So we" });
    expect(toWholeWords("by Q3", "by the end of Q3", { start: 3, end: 3, text: "the end of " })).toEqual({ start: 3, end: 3, text: "the end of " });
    expect(editedText("We ship by Q3.", [{ start: 11, end: 13, text: "May" }, { start: 0, end: 2, text: "They" }])).toBe("They ship by May.");
  });

  test("what you type in a paragraph becomes one approved change: a replace, a delete or an insert next to the words around it", () => {
    const replaced = write(linked(), "p4", "We ship by May and review by Q3.");
    expect(replaced.summary).toBe("Wrote c1: replace “Q3” in p4 with “May”.");
    expect(replaced.document.changes[0]).toMatchObject({ kind: "replace", by: "you", approved: true, anchor: { block: "p4", quote: "Q3", prefix: "We ship by " } });
    expect(write(linked(), "p4", "We ship and review by Q3.").summary).toBe("Wrote c1: delete “by Q3 ” in p4.");
    expect(write(linked(), "p4", "We ship by Q3 and then review by Q3.").summary).toBe("Wrote c1: insert “then ” after “and ” in p4.");
    expect(write(linked(), "p4", "So we ship by Q3 and review by Q3.").summary).toBe("Wrote c1: replace “We” in p4 with “So we”.");
    expect(write(linked(), "p4", "Now we ship by Q3 and review by Q3.").summary).toBe("Wrote c1: replace “We” in p4 with “Now we”.");
    expect(write(linked(), "p4", "We shipped by Q3 and review by Q3.").summary).toBe("Wrote c1: replace “ship” in p4 with “shipped”.");
  });

  test("typing again in a paragraph takes the place of your earlier edits there, and the agent's stay", () => {
    const first = applied(linked(), [{ op: "write", block: "p4", text: "We ship by May and review by Q3." }, you], [{ op: "replace", block: "p4", quote: "review", with: "check" }, agent]);
    const again = write(first, "p4", "We ship by early May and review by Q3.");
    expect(again.summary).toBe("Wrote c3: replace “Q3” in p4 with “early May”, in place of c1.");
    expect(again.document.changes.map(({ id }) => id)).toEqual(["c2", "c3"]);
    expect(again.inverse).toEqual({ op: "write", block: "p4", text: "We ship by May and review by Q3." });
    const undone = applyOperation(again.document, again.inverse, you).document;
    expect(undone.changes.map(changeSummary)).toEqual(["replace “review” in p4 with “check”", "replace “Q3” in p4 with “May”"]);
    const back = write(first, "p4", "We ship by Q3 and review by Q3.");
    expect(back.summary).toBe("Took back your edits in p4: c1.");
    expect(back.document.changes.map(({ id }) => id)).toEqual(["c2"]);
  });

  test("typing into an empty paragraph writes there, found again by the paragraphs around it when ids move", () => {
    const withEmpty = (): GoogleDoc => ({ ...checkedDocument({ url: URL }), snapshot: snapshot(withEmptyParagraphs()) });
    const written = write(withEmpty(), "p7", "Ask Ben");
    expect(written.summary).toBe("Wrote c1: write “Ask Ben” in the empty paragraph p7.");
    expect(written.document.changes[0]).toMatchObject({ anchor: { tab: "t.1", block: "p7", quote: "", prefix: "Notes by Q3", suffix: "" } });
    expect(planPush(written.document, snapshot(withEmptyParagraphs())).suggestionRequests).toEqual([{ insertText: { location: { index: 13, tabId: "t.1" }, text: "Ask Ben" } }]);
    const movedOn = snapshot(withEmptyParagraphs({ alsoInFirstTab: true }));
    expect(movedOn.tabs.at(-1)!.blocks.map(({ id }) => id)).toEqual(["p7", "p8"]);
    expect(planPush(written.document, movedOn).suggestionRequests).toEqual([{ insertText: { location: { index: 13, tabId: "t.1" }, text: "Ask Ben" } }]);
    const twoEmpty = (): GoogleDoc => ({ ...checkedDocument({ url: URL }), snapshot: snapshot(withEmptyParagraphs({ twoInSecondTab: true })) });
    expect(twoEmpty().snapshot!.tabs.at(-1)!.blocks.map((block) => [block.id, block.kind === "paragraph" ? block.text : null])).toEqual([["p6", "Notes by Q3"], ["p7", ""], ["p8", "Ask Ana"], ["p9", ""]]);
    const both = applied(twoEmpty(), [{ op: "write", block: "p7", text: "First" }, you], [{ op: "write", block: "p9", text: "Second" }, you]);
    const shifted = snapshot(withEmptyParagraphs({ twoInSecondTab: true, alsoInFirstTab: true }));
    expect(shifted.tabs.at(-1)!.blocks.map(({ id }) => id)).toEqual(["p7", "p8", "p9", "p10"]);
    expect(planPush(both, shifted).suggestionRequests).toEqual([
      { insertText: { location: { index: 22, tabId: "t.1" }, text: "Second" } },
      { insertText: { location: { index: 13, tabId: "t.1" }, text: "First" } },
    ]);
    expect(describeDocument(withEmpty())).toContain("\np7 [empty]");
    expect(applyOperation(withEmpty(), { op: "insert", block: "p7", after: "", text: "Hi" }, agent).summary).toBe("Proposed c1: write “Hi” in the empty paragraph p7.");
    expect(() => applyOperation(withEmpty(), { op: "insert", block: "p6", after: "", text: "Hi" }, agent)).toThrow("Give the quote");
  });

  test("typing is refused where it can't be sent: images, open suggestions, and for the agent", () => {
    expect(() => write(linked(), "p3", " Owner: Ana")).toThrow("Images and chips can't be changed by typing");
    expect(write(linked(), "p3", "\uFFFC Owner: Ana Lee").summary).toBe("Wrote c1: insert “ Lee” after “Ana” in p3.");
    expect(() => write(linked(), "p5", "Budget: 20k")).toThrow("This paragraph has suggestions in the doc: accept or reject them first");
    expect(() => applyOperation(linked(), { op: "write", block: "p4", text: "x" }, agent)).toThrow("Only the user can type into the doc, in the view.");
    const proposed = applied(linked(), [{ op: "replace", block: "p4", quote: "review", with: "check" }, agent]);
    expect(() => write(proposed, "p4", "We ship by Q3 and reviews by Q3.")).toThrow("The agent's change c1 is on this text: approve or drop it first, then type here.");
    expect(write(proposed, "p4", "We ship by May and review by Q3.").summary).toBe("Wrote c2: replace “Q3” in p4 with “May”.");
  });

  test("with direct edits on, Send puts your edits in first and leaves the agent's to be placed after them", () => {
    const document = applied(
      linked(),
      [{ op: "direct-edits", on: true }, you],
      [{ op: "write", block: "p4", text: "We ship by May and review by Q3." }, you],
      [{ op: "replace", block: "p2", quote: "by Q3", with: "soon" }, agent],
      [{ op: "approve-all" }, you],
    );
    const plan = planPush(document, snapshot());
    expect(plan.directChanges).toEqual(["c1"]);
    expect(plan.directRequests).toEqual([
      { deleteContentRange: { range: { startIndex: expect.any(Number), endIndex: expect.any(Number), tabId: "t.0" } } },
      { insertText: { location: { index: expect.any(Number), tabId: "t.0" }, text: "May" } },
    ]);
    expect(plan.suggestionChanges).toEqual([]);
    expect(plan.problems).toEqual({});
    const later = planPush({ ...document, changes: document.changes.filter(({ id }) => id !== "c1") }, snapshot());
    expect(later.suggestionChanges).toEqual(["c2"]);
    expect(() => applyOperation(linked(), { op: "direct-edits", on: true }, agent)).toThrow("Only the user can choose how their edits are sent");
  });
});

describe("describing the doc for the agent", () => {
  test("lists blocks with ids, styles, others' suggestions, threads and the pending changes", () => {
    const document = applied(linked(), [{ op: "delete", block: "p2", quote: " 🚀" }, agent]);
    const text = describeDocument(document);
    expect(text).toContain("“Launch plan”, read 2026-10-25 12:00 UTC as ana@example.com.");
    expect(text).toContain("p1 [Heading 1] Launch plan\np2 The launch is planned by Q3 🚀.\n  styles: bold “launch”\np3 • [object] Owner: Ana\nt1 [table, read only] Risk | Low");
    expect(text).toContain("p5 Budget: [+10k+][-5k-]");
    expect(text).toContain("Tab “Notes”:\np6 Notes by Q3");
    expect(text).toContain("- doco.thread1 (open) on “launch”: Ana: “Which launch?”; Ben: “The spring one.”");
    expect(text).toContain("- c1 by you, the agent, waiting for approval: delete “ 🚀” in p2");
    expect(describeDocument(newDocument())).toStartWith("No doc is linked yet.");
  });
});

describe("a doc as Google really sends it", () => {
  test("reads both tabs of the live test doc, its heading and its thread, with the indexes Google gave", async () => {
    const live = snapshotOf(await Bun.file(`${import.meta.dir}/fixtures/live-two-tabs.json`).json(), "ana@example.com", 0);
    expect(live.tabs.map(({ title, blocks }) => [title, blocks.map((block) => (block.kind === "paragraph" ? block.text : block.id))])).toEqual([
      ["Tab 1", ["Launch plan", "The launch is planned by Q3 🚀.", "We ship by Q3 and review by Q3.", "Owner: Ana", ""]],
      ["Notes", ["Open questions by Q3", "Who reviews the budget?", ""]],
    ]);
    expect(paragraph(live, "p1").style).toBe("HEADING_1");
    expect(paragraph(live, "p2").startIndex).toBe(13);
    expect(paragraph(live, "p6").startIndex).toBe(1);
    expect(live.threads).toMatchObject([{ quote: "launch", status: "open", posts: [{ author: "Ana", content: "Which launch?" }] }]);
  });
});
