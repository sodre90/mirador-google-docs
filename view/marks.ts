import { locate, occurrences } from "../shared/anchor.ts";
import { isAnchored, paragraphs, type Change, type Paragraph, type Snapshot, type TextRun } from "../shared/document.ts";

/** Where a pending change or a comment thread shows in a paragraph's text. */
export interface Mark {
  start: number;
  end: number;
  kind: "deleted" | "commented" | "thread" | "point";
  /** A change's id, or a thread's. */
  id: string;
  /** Text the change would add there, shown but not part of the paragraph's text. */
  added?: { text: string; at: number };
}

function markOf(change: Change, start: number, end: number): Mark {
  switch (change.kind) {
    case "replace":
      return { start, end, kind: "deleted", id: change.id, added: { text: change.text, at: end } };
    case "delete":
      return { start, end, kind: "deleted", id: change.id };
    case "insert":
      return { start, end, kind: "point", id: change.id, added: { text: change.text, at: change.where === "before" ? start : end } };
    default:
      return { start, end, kind: "commented", id: change.id };
  }
}

const overlaps = (a: Mark, b: Mark) => a.start < b.end && b.start < a.end;

/**
 * The marks of each paragraph, by its id: the pending changes where their quote is now, and the comment threads whose
 * quote appears once in the doc. A mark that would overlap an earlier one shows only in the list beside the doc.
 */
export function marksOf(snapshot: Snapshot, changes: Change[]): Map<string, Mark[]> {
  const byParagraph = new Map<string, Mark[]>();
  const add = (paragraph: string, mark: Mark) => {
    const marks = byParagraph.get(paragraph) ?? [];
    if (marks.some((other) => overlaps(other, mark))) return;
    byParagraph.set(paragraph, [...marks, mark].sort((a, b) => a.start - b.start));
  };
  for (const change of changes.filter(isAnchored)) {
    const found = locate(change.anchor, snapshot);
    if (!("problem" in found)) add(found.paragraph.id, markOf(change, found.start, found.end));
  }
  const allParagraphs = snapshot.tabs.flatMap(paragraphs);
  for (const thread of snapshot.threads.filter(({ status, quote }) => status === "open" && quote)) {
    const places = allParagraphs.flatMap((paragraph) => occurrences(paragraph.text, thread.quote).map((start) => ({ paragraph, start })));
    const [only] = places;
    if (places.length === 1 && only) add(only.paragraph.id, { start: only.start, end: only.start + thread.quote.length, kind: "thread", id: thread.id });
  }
  return byParagraph;
}

/** A piece of a paragraph as the view draws it: its own text with one style and at most one mark, or a change's added text. */
export type Piece = { kind: "text"; text: string; start: number; run: TextRun; mark?: Mark } | { kind: "added"; text: string; mark: Mark };

export function piecesOf(paragraph: Paragraph, marks: Mark[]): Piece[] {
  const cuts = new Set([0, paragraph.text.length, ...paragraph.runs.map(({ start }) => start), ...marks.flatMap(({ start, end }) => [start, end])]);
  const points = [...cuts].filter((cut) => cut >= 0 && cut <= paragraph.text.length).sort((a, b) => a - b);
  const addedAt = (at: number) => marks.filter((mark) => mark.added?.at === at).map((mark): Piece => ({ kind: "added", text: mark.added!.text, mark }));
  const pieces: Piece[] = [];
  points.slice(0, -1).forEach((from, index) => {
    const to = points[index + 1]!;
    pieces.push(...addedAt(from));
    const run = paragraph.runs.findLast(({ start }) => start <= from)!;
    const mark = marks.find(({ kind, start, end }) => kind !== "point" && start <= from && to <= end && start < end);
    pieces.push({ kind: "text", text: paragraph.text.slice(from, to), start: from, run, ...(mark && { mark }) });
  });
  pieces.push(...addedAt(paragraph.text.length));
  return pieces;
}
