import { locate, spanOf, spansOverlap, type Located } from "./anchor.ts";
import { isAnchored, TEXT_STYLES, type AnchoredChange, type Change, type GoogleDoc, type Snapshot } from "./document.ts";
import { threadIn } from "./operations.ts";

export interface PushPlan {
  /** Comments and replies, sent first in a plain batch: they don't move any text. */
  commentRequests: unknown[];
  commentChanges: string[];
  /**
   * Edits, sent in one batch as suggestions: the style changes first, which move no text, then the text edits from the
   * end of each tab back so no edit moves the next one's place.
   */
  suggestionRequests: unknown[];
  suggestionChanges: string[];
  /** The user's own edits when they go straight into the doc: sent before the suggestions, which are placed again after them. */
  directRequests: unknown[];
  directChanges: string[];
  /** Accepting and rejecting suggestions, sent last: accepting one changes the text the edits were placed in. */
  decisionRequests: unknown[];
  decisionChanges: string[];
  /** Approved changes that can't be sent, with why. */
  problems: Record<string, string>;
}

interface Placed {
  change: Exclude<AnchoredChange, { kind: "comment" }>;
  located: Located;
  /** The range the edit takes up in the tab; an insert takes up the one place it goes. */
  from: number;
  to: number;
}

function editRequests({ change, located }: Placed): unknown[] {
  const tabId = located.tab.id;
  const range = { startIndex: located.startIndex, endIndex: located.endIndex, tabId };
  switch (change.kind) {
    case "format": {
      const { link, ...flags } = change.style;
      const textStyle = { ...flags, ...(link && { link: { url: link } }) };
      const fields = [...TEXT_STYLES.filter((name) => flags[name] !== undefined), ...(link === undefined ? [] : ["link"])];
      return [{ updateTextStyle: { range, textStyle, fields: fields.join(",") } }];
    }
    case "paragraph":
      return change.style ? [{ updateParagraphStyle: { range: paragraphRange(located, located), paragraphStyle: { namedStyleType: change.style }, fields: "namedStyleType" } }] : [];
    case "replace":
      return [{ deleteContentRange: { range } }, { insertText: { location: { index: located.startIndex, tabId }, text: change.text } }];
    case "delete":
      return [{ deleteContentRange: { range } }];
    case "insert":
      return [{ insertText: { location: { index: change.where === "before" ? located.startIndex : located.endIndex, tabId }, text: change.text } }];
  }
}

/** From the start of one paragraph to the start of another's text, which Google's paragraph requests take as both and those between. */
const paragraphRange = (first: Located, last: Located) => ({ startIndex: first.paragraph.startIndex, endIndex: last.paragraph.startIndex + 1, tabId: first.tab.id });

const BULLET_PRESETS = { bulleted: "BULLET_DISC_CIRCLE_SQUARE", numbered: "NUMBERED_DECIMAL_ALPHA_ROMAN" };

/** Bullets for the paragraphs whose list changes, one request for each run of paragraphs next to each other that become the same kind of list, so they make one list. */
function listRequests(placed: Placed[]): unknown[] {
  const listed = placed
    .filter((each): each is Placed & { change: { kind: "paragraph"; list: string } } => each.change.kind === "paragraph" && each.change.list !== undefined)
    .toSorted((a, b) => a.located.tab.id.localeCompare(b.located.tab.id) || a.located.paragraph.startIndex - b.located.paragraph.startIndex);
  const runs: Placed[][] = [];
  for (const each of listed) {
    const run = runs.at(-1);
    const last = run?.at(-1);
    const blocks = each.located.tab.blocks;
    const follows = last && last.located.tab.id === each.located.tab.id && last.change.kind === "paragraph" && last.change.list === each.change.list && blocks.indexOf(last.located.paragraph) + 1 === blocks.indexOf(each.located.paragraph);
    if (run && follows) run.push(each);
    else runs.push([each]);
  }
  return runs.map((run) => {
    const range = paragraphRange(run[0]!.located, run.at(-1)!.located);
    const list = (run[0]!.change as { list: "bulleted" | "numbered" | "none" }).list;
    return list === "none" ? { deleteParagraphBullets: { range } } : { createParagraphBullets: { range, bulletPreset: BULLET_PRESETS[list] } };
  });
}

const movesText = ({ change }: Placed) => change.kind === "replace" || change.kind === "insert" || change.kind === "delete";

/** The requests for placed changes: styles first, as they move no text, then the text edits from the end back. */
function requestsFor(placed: Placed[]): unknown[] {
  const styles = placed.filter((each) => !movesText(each));
  const edits = placed.filter(movesText).toSorted((a, b) => b.from - a.from || b.to - a.to);
  return [...styles.flatMap(editRequests), ...listRequests(styles), ...edits.flatMap(editRequests)];
}

function decisionRequest(change: Extract<Change, { kind: "accept" | "reject" }>, fresh: Snapshot): unknown | string {
  if (!fresh.suggestions.some(({ id }) => id === change.suggestion)) return "The suggestion isn't open in the doc any more.";
  return change.kind === "accept" ? { acceptSuggestion: { suggestionId: change.suggestion } } : { rejectSuggestion: { suggestionId: change.suggestion } };
}

function commentRequests(change: Change, fresh: Snapshot): unknown[] | string {
  if (change.kind === "comment") {
    const located = locate(change.anchor, fresh);
    if ("problem" in located) return located.problem;
    return [{ insertComment: { content: change.text, range: { startIndex: located.startIndex, endIndex: located.endIndex, tabId: located.tab.id } } }];
  }
  if (change.kind !== "reply" && change.kind !== "resolve") return [];
  if (!threadIn(fresh, change.thread)) return "Its comment thread or suggestion isn't in the doc any more.";
  const resolve = { addCommentReply: { commentId: change.thread, post: { commentAction: "RESOLVE" } } };
  if (change.kind === "resolve") return [resolve];
  return [{ addCommentReply: { commentId: change.thread, post: { content: change.text } } }, ...(change.resolve ? [resolve] : [])];
}

/** What sending the approved changes to the doc as it is now takes: each change's quote is found again in `fresh`. */
export function planPush(document: GoogleDoc, fresh: Snapshot): PushPlan {
  const plan: PushPlan = { commentRequests: [], commentChanges: [], suggestionRequests: [], suggestionChanges: [], directRequests: [], directChanges: [], decisionRequests: [], decisionChanges: [], problems: {} };
  const approved = document.changes.filter(({ approved }) => approved);
  const decided = new Map<string, string>();
  for (const change of approved.filter((change) => change.kind === "accept" || change.kind === "reject")) {
    const request = decisionRequest(change as Extract<Change, { kind: "accept" | "reject" }>, fresh);
    const earlier = decided.get(change.suggestion);
    if (earlier) plan.problems[change.id] = `${earlier} already decides that suggestion; drop this one.`;
    else if (typeof request === "string") plan.problems[change.id] = request;
    else {
      plan.decisionRequests.push(request);
      plan.decisionChanges.push(change.id);
      decided.set(change.suggestion, change.id);
    }
  }
  for (const change of approved.filter((change) => change.kind === "comment" || change.kind === "reply" || change.kind === "resolve")) {
    const requests = commentRequests(change, fresh);
    if (typeof requests === "string") plan.problems[change.id] = requests;
    else {
      plan.commentRequests.push(...requests);
      plan.commentChanges.push(change.id);
    }
  }
  const placed: Placed[] = [];
  for (const change of approved.filter((change): change is Placed["change"] => isAnchored(change) && change.kind !== "comment")) {
    const located = locate(change.anchor, fresh);
    if ("problem" in located) {
      plan.problems[change.id] = located.problem;
      continue;
    }
    const candidate = { change, located, ...spanOf(change, located) };
    const isParagraph = (each: Placed) => each.change.kind === "paragraph";
    const clash = placed.find((other) => isParagraph(other) === isParagraph(candidate) && (isParagraph(candidate) ? other.located.paragraph.id === located.paragraph.id : spansOverlap(other, candidate)));
    if (clash) plan.problems[change.id] = `It touches the same text as ${clash.change.id}, which goes in with this Send: drop this one, or drop ${clash.change.id} and send this one.`;
    else placed.push(candidate);
  }
  const isDirect = ({ change }: Placed) => document.directEdits && change.by === "you";
  const direct = placed.filter(isDirect);
  const suggested = direct.length ? [] : placed;
  plan.directRequests = requestsFor(direct);
  plan.directChanges = direct.map(({ change }) => change.id);
  plan.suggestionRequests = requestsFor(suggested);
  plan.suggestionChanges = suggested.map(({ change }) => change.id);
  return plan;
}
