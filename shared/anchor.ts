import { findParagraph, paragraphs, type Anchor, type Paragraph, type Snapshot, type Tab } from "./document.ts";

/** How much text on each side of a quote an anchor keeps, to find the quote again once the doc changed. */
const CONTEXT = 24;

export const occurrences = (text: string, quote: string) => {
  const found: number[] = [];
  for (let at = text.indexOf(quote); at !== -1; at = text.indexOf(quote, at + 1)) found.push(at);
  return found;
};

const shortened = (text: string) => (text.length > 160 ? `${text.slice(0, 160)}…` : text);

/**
 * The anchor of a quote in a paragraph of the snapshot. Without `at` the quote must appear in the paragraph once; with it,
 * `at` is where it starts in the paragraph's text, as a selection in the view gives it.
 */
export function anchorIn(snapshot: Snapshot, block: string, quote: string, at?: number): Anchor {
  const found = findParagraph(snapshot, block);
  if (!found) throw new Error(`There's no paragraph ${block} in the doc; app_state lists them.`);
  const { tab, paragraph } = found;
  if (!quote && !paragraph.text) return emptyParagraphAnchor(tab, paragraph);
  if (!quote) throw new Error("Give the quote: the exact text of the paragraph the change is about.");
  const start = at ?? onlyOccurrence(paragraph, quote);
  if (paragraph.text.slice(start, start + quote.length) !== quote) throw new Error(`${block} doesn't have "${quote}" at ${at}; its text is "${shortened(paragraph.text)}".`);
  return { tab: tab.id, block, quote, prefix: paragraph.text.slice(Math.max(0, start - CONTEXT), start), suffix: paragraph.text.slice(start + quote.length, start + quote.length + CONTEXT) };
}

const OPENING_WORDS = 30;

/** The anchor of a whole paragraph: its first words, tied to its start, so edits further on in it don't lose it. */
export function paragraphAnchor(snapshot: Snapshot, block: string): Anchor {
  const text = findParagraph(snapshot, block)?.paragraph.text ?? "";
  const space = text.indexOf(" ", Math.min(OPENING_WORDS, text.length));
  return anchorIn(snapshot, block, text.slice(0, space === -1 ? text.length : space), 0);
}

/** An empty paragraph has no text to quote: its anchor keeps the end of the paragraph before it and the start of the one after. */
function emptyParagraphAnchor(tab: Tab, paragraph: Paragraph): Anchor {
  const { before, after } = neighboursOf(tab, paragraph);
  return { tab: tab.id, block: paragraph.id, quote: "", prefix: before.slice(-CONTEXT), suffix: after.slice(0, CONTEXT) };
}

function neighboursOf(tab: Tab, paragraph: Paragraph) {
  const all = paragraphs(tab);
  const at = all.indexOf(paragraph);
  return { before: all[at - 1]?.text ?? "", after: all[at + 1]?.text ?? "" };
}

/** Finds the empty paragraph an anchor with no quote is on: the one between the same neighbours, or its block among several. */
function locateEmpty(anchor: Anchor, tabs: Tab[]): Located | { problem: string } {
  const empty = tabs.flatMap((tab) => paragraphs(tab).filter(({ text }) => !text).map((paragraph) => ({ tab, paragraph })));
  const between = empty.filter(({ tab, paragraph }) => {
    const { before, after } = neighboursOf(tab, paragraph);
    return before.endsWith(anchor.prefix) && after.startsWith(anchor.suffix);
  });
  const found = between.length === 1 ? between[0] : (between.length ? between : empty).find(({ paragraph }) => paragraph.id === anchor.block);
  if (!found) return { problem: between.length ? "Several empty paragraphs are where it was, so it's unclear which one is meant." : "The empty paragraph it was in isn't in the doc any more." };
  return locatedAt(found.tab, found.paragraph, 0, "");
}

function onlyOccurrence(paragraph: Paragraph, quote: string) {
  const found = occurrences(paragraph.text, quote);
  if (found.length === 0) throw new Error(`"${quote}" isn't in ${paragraph.id}; its text is "${shortened(paragraph.text)}". Quote it exactly.`);
  if (found.length > 1) throw new Error(`"${quote}" appears ${found.length} times in ${paragraph.id}; quote more of the text around it, or give at, where it starts.`);
  return found[0]!;
}

export interface Located {
  tab: Tab;
  paragraph: Paragraph;
  /** Where the quote starts and ends in the paragraph's text. */
  start: number;
  end: number;
  /** The same, as Google's indexes in the tab count. */
  startIndex: number;
  endIndex: number;
}

/** How many characters next to a quote must still match when the rest of the text around it changed. */
const NEARBY = 8;

/** Whether the text on both sides of a candidate matches the anchor's, the nearest `length` characters of it (or both
 * sides on one, when the other changed); a side that was a paragraph's edge must still be one. */
function contextMatches(anchor: Anchor, { paragraph, start, end }: Located, length: number) {
  const before = paragraph.text.slice(0, start);
  const after = paragraph.text.slice(end);
  const prefixMatches = anchor.prefix ? before.endsWith(anchor.prefix.slice(-length)) : before === "";
  const suffixMatches = anchor.suffix ? after.startsWith(anchor.suffix.slice(0, length)) : after === "";
  return length === Infinity ? prefixMatches && suffixMatches : prefixMatches || suffixMatches;
}

const locatedAt = (tab: Tab, paragraph: Paragraph, start: number, quote: string): Located => ({
  tab,
  paragraph,
  start,
  end: start + quote.length,
  startIndex: paragraph.startIndex + start,
  endIndex: paragraph.startIndex + start + quote.length,
});

/**
 * Finds an anchor's quote in a snapshot that may differ from the one it was made in: where the text around it still
 * matches, or else where the quote is the only one of its kind. Its paragraph id only settles a tie between matches, as
 * ids move when paragraphs come and go.
 */
export function locate(anchor: Anchor, snapshot: Snapshot): Located | { problem: string } {
  const sameTab = snapshot.tabs.filter((tab) => tab.id === anchor.tab);
  // Before any search for the quote: occurrences of "" never ends.
  if (!anchor.quote) return locateEmpty(anchor, sameTab.length ? sameTab : snapshot.tabs);
  const candidates = (sameTab.length ? sameTab : snapshot.tabs).flatMap((tab) =>
    paragraphs(tab).flatMap((paragraph) => occurrences(paragraph.text, anchor.quote).map((start) => locatedAt(tab, paragraph, start, anchor.quote))),
  );
  if (candidates.length === 0) return { problem: `"${anchor.quote}" isn't in the doc any more.` };
  const inContext = candidates.filter((candidate) => contextMatches(anchor, candidate, Infinity));
  const inItsBlock = inContext.filter(({ paragraph }) => paragraph.id === anchor.block);
  const nearby = candidates.filter((candidate) => contextMatches(anchor, candidate, NEARBY));
  const found = inContext.length === 1 ? inContext[0] : inItsBlock.length === 1 ? inItsBlock[0] : !inContext.length && nearby.length === 1 ? nearby[0] : undefined;
  if (found) return found;
  if (!inContext.length && !nearby.length) return { problem: `"${anchor.quote}" isn't in the doc any more where it was.` };
  return { problem: `"${anchor.quote}" now appears ${inContext.length || nearby.length} times in the doc, so it's unclear which one is meant.` };
}

/** The stretch of a tab's indexes a text edit takes up; an insert takes up the one place it goes. */
export function spanOf(change: { kind: string; where?: "before" | "after" }, located: Located) {
  if (change.kind !== "insert") return { from: located.startIndex, to: located.endIndex };
  const at = change.where === "before" ? located.startIndex : located.endIndex;
  return { from: at, to: at };
}

/** Whether two text edits touch the same text, so the second would land in the first's suggestion. */
export const spansOverlap = (a: { located: Located; from: number; to: number }, b: { located: Located; from: number; to: number }) =>
  a.located.tab.id === b.located.tab.id && (a.from === b.from || (a.from < b.to && b.from < a.to));
