import { locate, spanOf, spansOverlap, type Located } from "./anchor.ts";
import { isAnchored, type AnchoredChange, type Change, type GoogleDoc, type Snapshot } from "./document.ts";
import { threadIn } from "./operations.ts";

export interface PushPlan {
  /** Comments and replies, sent first in a plain batch: they don't move any text. */
  commentRequests: unknown[];
  commentChanges: string[];
  /** Text edits, sent in one batch as suggestions, from the end of each tab back so no edit moves the next one's place. */
  suggestionRequests: unknown[];
  suggestionChanges: string[];
  /** The user's own text edits when they go straight into the doc: sent before the suggestions, which are placed again after them. */
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
    case "replace":
      return [{ deleteContentRange: { range } }, { insertText: { location: { index: located.startIndex, tabId }, text: change.text } }];
    case "delete":
      return [{ deleteContentRange: { range } }];
    case "insert":
      return [{ insertText: { location: { index: change.where === "before" ? located.startIndex : located.endIndex, tabId }, text: change.text } }];
  }
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
    const clash = placed.find((other) => spansOverlap(other, candidate));
    if (clash) plan.problems[change.id] = `It touches the same text as ${clash.change.id}, which goes in with this Send: drop this one, or drop ${clash.change.id} and send this one.`;
    else placed.push(candidate);
  }
  const lastFirst = placed.toSorted((a, b) => b.from - a.from || b.to - a.to);
  const isDirect = ({ change }: Placed) => document.directEdits && change.by === "you";
  const direct = lastFirst.filter(isDirect);
  const suggested = direct.length ? [] : lastFirst;
  plan.directRequests = direct.flatMap(editRequests);
  plan.directChanges = direct.map(({ change }) => change.id);
  plan.suggestionRequests = suggested.flatMap(editRequests);
  plan.suggestionChanges = suggested.map(({ change }) => change.id);
  return plan;
}
