import { anchorIn, locate } from "./anchor.ts";
import { findParagraph, isAnchored, OBJECT_MARK, type AnchoredChange, type Change, type ChangeBody, type Paragraph, type Snapshot } from "./document.ts";

/** Text that takes the place of [start, end) in a paragraph's text. */
export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

type TextChange = Extract<AnchoredChange, { kind: "replace" | "insert" | "delete" }>;

const isTextChange = (change: Change): change is TextChange => change.kind === "replace" || change.kind === "insert" || change.kind === "delete";

/** The user's own pending edits to a paragraph's text, where they are in it now. */
export function ownEditsIn(snapshot: Snapshot, changes: Change[], block: string): { change: TextChange; edit: TextEdit }[] {
  return changes
    .filter((change): change is TextChange => change.by === "you" && isAnchored(change) && isTextChange(change))
    .flatMap((change): { change: TextChange; edit: TextEdit }[] => {
      const found = locate(change.anchor, snapshot);
      if ("problem" in found || found.paragraph.id !== block) return [];
      if (change.kind === "insert") {
        const at = change.where === "before" ? found.start : found.end;
        return [{ change, edit: { start: at, end: at, text: change.text } }];
      }
      return [{ change, edit: { start: found.start, end: found.end, text: change.kind === "replace" ? change.text : "" } }];
    });
}

/** A paragraph's text with edits made to it; an edit overlapping an earlier one is left out, as the view leaves out its mark. */
export function editedText(text: string, edits: TextEdit[]): string {
  const kept: TextEdit[] = [];
  for (const edit of edits.toSorted((a, b) => a.start - b.start)) {
    const last = kept.at(-1);
    if (!last || edit.start >= last.end) kept.push(edit);
  }
  return kept.toReversed().reduce((written, { start, end, text: added }) => written.slice(0, start) + added + written.slice(end), text);
}

/** The one edit that turns `before` into `after`: what lies between their common start and their common end. */
export function differenceOf(before: string, after: string): TextEdit | null {
  if (before === after) return null;
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let fromEnd = 0;
  while (fromEnd < before.length - start && fromEnd < after.length - start && before[before.length - 1 - fromEnd] === after[after.length - 1 - fromEnd]) fromEnd++;
  return { start, end: before.length - fromEnd, text: after.slice(start, after.length - fromEnd) };
}

const isWordCharacter = (character: string | undefined) => character !== undefined && /[\p{L}\p{N}_]/u.test(character);

/** The edit widened to whole words where it starts or ends inside one, so it reads as Docs shows a suggestion: “We” to “So we”, not “W” to “So w”. */
export function toWholeWords(before: string, after: string, { start, end, text }: TextEdit): TextEdit {
  let from = start;
  while (from > 0 && isWordCharacter(before[from - 1]) && (isWordCharacter(before[from]) || isWordCharacter(text[0]))) from--;
  let to = end;
  while (to < before.length && isWordCharacter(before[to]) && (isWordCharacter(before[to - 1]) || isWordCharacter(text.at(-1)))) to++;
  return { start: from, end: to, text: after.slice(from, after.length - (before.length - to)) };
}

const QUOTE_LENGTH = 30;

/** The words just before `at`, for an insert to go after: up to the previous space, and not too long. */
const wordBefore = (text: string, at: number) => Math.max(text.lastIndexOf(" ", at - 2) + 1, at - QUOTE_LENGTH, 0);

const wordAfter = (text: string, at: number) => {
  const space = text.indexOf(" ", at + 1);
  return Math.min(space === -1 ? text.length : space, at + QUOTE_LENGTH);
};

/** The agent's pending edit of the text that [start, end) touches, which typing there would clash with when sent. */
function agentEditOn(snapshot: Snapshot, changes: Change[], block: string, start: number, end: number): TextChange | undefined {
  return changes.filter((change): change is TextChange => change.by === "agent" && isAnchored(change) && isTextChange(change)).find((change) => {
    const found = locate(change.anchor, snapshot);
    return !("problem" in found) && found.paragraph.id === block && (start === end ? found.start <= start && start <= found.end : found.start < end && start < found.end);
  });
}

/** Why typing can't change this paragraph, or null when it can. */
export function unwritable(paragraph: Paragraph): string | null {
  if (paragraph.runs.some((run) => run.inserted || run.deleted)) return "This paragraph has suggestions in the doc: accept or reject them first, then type here.";
  return null;
}

/** The change that typing `text` into a paragraph makes, in place of the user's earlier edits there, and the text it had before. */
export function writtenChange(snapshot: Snapshot, changes: Change[], block: string, text: string): { body: ChangeBody | null; replaces: TextChange[]; before: string } {
  const found = findParagraph(snapshot, block);
  if (!found) throw new Error(`There's no paragraph ${block} in the doc.`);
  const { paragraph } = found;
  const problem = unwritable(paragraph);
  if (problem) throw new Error(problem);
  const own = ownEditsIn(snapshot, changes, block);
  const before = editedText(paragraph.text, own.map(({ edit }) => edit));
  const replaces = own.map(({ change }) => change);
  const difference = differenceOf(paragraph.text, text);
  if (!difference) return { body: null, replaces, before };
  const { start, end, text: added } = toWholeWords(paragraph.text, text, difference);
  const theAgents = agentEditOn(snapshot, changes, block, start, end);
  if (theAgents) throw new Error(`The agent's change ${theAgents.id} is on this text: approve or drop it first, then type here.`);
  if (paragraph.text.slice(start, end).includes(OBJECT_MARK) || added.includes(OBJECT_MARK)) throw new Error("Images and chips can't be changed by typing: type around them, or ask the agent.");
  const original = paragraph.text;
  if (!original) return { body: { kind: "insert", anchor: anchorIn(snapshot, block, "", 0), where: "after", text: added }, replaces, before };
  if (start < end) {
    const anchor = anchorIn(snapshot, block, original.slice(start, end), start);
    return { body: added ? { kind: "replace", anchor, text: added } : { kind: "delete", anchor }, replaces, before };
  }
  if (start > 0) {
    const from = wordBefore(original, start);
    return { body: { kind: "insert", anchor: anchorIn(snapshot, block, original.slice(from, start), from), where: "after", text: added }, replaces, before };
  }
  return { body: { kind: "insert", anchor: anchorIn(snapshot, block, original.slice(0, wordAfter(original, 0)), 0), where: "before", text: added }, replaces, before };
}
