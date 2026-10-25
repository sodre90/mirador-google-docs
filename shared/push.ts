import { locate, type Located } from "./anchor.ts";
import { isAnchored, type AnchoredChange, type Change, type GoogleDoc, type Snapshot } from "./document.ts";

export interface PushPlan {
  /** Comments and replies, sent first in a plain batch: they don't move any text. */
  commentRequests: unknown[];
  commentChanges: string[];
  /** Text edits, sent in one batch as suggestions, from the end of each tab back so no edit moves the next one's place. */
  suggestionRequests: unknown[];
  suggestionChanges: string[];
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

const placeOf = (change: Placed["change"], located: Located) => {
  if (change.kind !== "insert") return { from: located.startIndex, to: located.endIndex };
  const at = change.where === "before" ? located.startIndex : located.endIndex;
  return { from: at, to: at };
};

const overlapping = (a: Placed, b: Placed) => a.located.tab.id === b.located.tab.id && (a.from === b.from || (a.from < b.to && b.from < a.to));

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

function commentRequests(change: Change, fresh: Snapshot): unknown[] | string {
  if (change.kind === "comment") {
    const located = locate(change.anchor, fresh);
    if ("problem" in located) return located.problem;
    return [{ insertComment: { content: change.text, range: { startIndex: located.startIndex, endIndex: located.endIndex, tabId: located.tab.id } } }];
  }
  if (change.kind !== "reply" && change.kind !== "resolve") return [];
  if (!fresh.threads.some(({ id }) => id === change.thread)) return "Its comment thread isn't in the doc any more.";
  const resolve = { addCommentReply: { commentId: change.thread, post: { commentAction: "RESOLVE" } } };
  if (change.kind === "resolve") return [resolve];
  return [{ addCommentReply: { commentId: change.thread, post: { content: change.text } } }, ...(change.resolve ? [resolve] : [])];
}

/** What sending the approved changes to the doc as it is now takes: each change's quote is found again in `fresh`. */
export function planPush(document: GoogleDoc, fresh: Snapshot): PushPlan {
  const plan: PushPlan = { commentRequests: [], commentChanges: [], suggestionRequests: [], suggestionChanges: [], problems: {} };
  const approved = document.changes.filter(({ approved }) => approved);
  for (const change of approved.filter((change) => change.kind === "comment" || !isAnchored(change))) {
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
    const candidate = { change, located, ...placeOf(change, located) };
    const clash = placed.find((other) => overlapping(other, candidate));
    if (clash) plan.problems[change.id] = `It touches the same text as ${clash.change.id}; send that one first, then this one again.`;
    else placed.push(candidate);
  }
  const lastFirst = placed.toSorted((a, b) => b.from - a.from || b.to - a.to);
  plan.suggestionRequests = lastFirst.flatMap(editRequests);
  plan.suggestionChanges = lastFirst.map(({ change }) => change.id);
  return plan;
}
