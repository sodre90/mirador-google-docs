import type { AppAuthor } from "../mirador/api.ts";
import { anchorIn, locate } from "./anchor.ts";
import { checkedDocument, documentIdOf, isAnchored, type Change, type ChangeBody, type GoogleDoc, type Snapshot } from "./document.ts";
import { writtenChange } from "./write.ts";

export interface Applied {
  document: GoogleDoc;
  inverse: unknown;
  summary: string;
  touched?: string[];
}

type Operation = Record<string, unknown> & { op?: unknown };

export const OPERATIONS_HELP = [
  'Operations, which apply takes; a quote is exact text of one paragraph, and "at" (optional) is where it starts in that paragraph:',
  '- { "op": "replace", "block": "p12", "quote": "by Q3", "with": "by the end of October" }',
  '- { "op": "insert", "block": "p12", "after": "planned", "text": " carefully" } (or "before" instead of "after"; "\\n" in text starts a new paragraph; "after": "" writes into an empty paragraph)',
  '- { "op": "delete", "block": "p12", "quote": " carefully" }',
  '- { "op": "comment", "block": "p12", "quote": "launch", "text": "Which launch?" }',
  '- { "op": "reply", "thread": "<thread id>", "text": "Done.", "resolve": true }',
  '- { "op": "resolve", "thread": "<thread id>" }',
  '- { "op": "accept", "suggestion": "<suggestion id>" } or { "op": "reject", … }: a suggestion in the doc; "reply" takes a suggestion id as its thread too',
  '- { "op": "drop", "change": "c3" }: takes back a pending change',
  "Your changes wait for the user to approve them; only the user sends them to Google Docs, where they arrive as suggestions.",
].join("\n");

const string = (operation: Operation, field: string): string => {
  const value = operation[field];
  if (typeof value !== "string") throw new Error(`${field} must be a string. ${OPERATIONS_HELP}`);
  return value;
};

const optionalNumber = (operation: Operation, field: string): number | undefined => {
  const value = operation[field];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${field} must be a whole number, where the quote starts in the paragraph.`);
  return value as number;
};

const requireSnapshot = (document: GoogleDoc): Snapshot => {
  if (!document.snapshot) throw new Error(document.url ? 'The doc hasn\'t been read yet: run app_run with the task "pull" first.' : 'No doc is linked yet: apply { "op": "link", "url": "<the doc\'s address>" }, then run the task "pull".');
  return document.snapshot;
};

const requireUser = (author: AppAuthor | undefined, what: string) => {
  if (author?.kind !== "you") throw new Error(`Only the user can ${what}, in the view.`);
};

export const countOf = (count: number, one: string) => `${count} ${count === 1 ? one : `${one}s`}`;

const quoted = (text: string) => `“${text.length > 60 ? `${text.slice(0, 60)}…` : text}”`;

export function changeSummary(change: ChangeBody): string {
  switch (change.kind) {
    case "replace":
      return `replace ${quoted(change.anchor.quote)} in ${change.anchor.block} with ${quoted(change.text)}`;
    case "insert":
      if (!change.anchor.quote) return `write ${quoted(change.text)} in the empty paragraph ${change.anchor.block}`;
      return `insert ${quoted(change.text)} ${change.where} ${quoted(change.anchor.quote)} in ${change.anchor.block}`;
    case "delete":
      return `delete ${quoted(change.anchor.quote)} in ${change.anchor.block}`;
    case "comment":
      return `comment on ${quoted(change.anchor.quote)} in ${change.anchor.block}: ${quoted(change.text)}`;
    case "reply":
      return `reply to thread ${change.thread}: ${quoted(change.text)}${change.resolve ? ", and resolve it" : ""}`;
    case "resolve":
      return `resolve thread ${change.thread}`;
    case "accept":
      return `accept suggestion ${change.suggestion}`;
    case "reject":
      return `reject suggestion ${change.suggestion}`;
  }
}

function bodyOf(operation: Operation, snapshot: Snapshot): ChangeBody {
  const anchor = (quoteField: string) => anchorIn(snapshot, string(operation, "block"), string(operation, quoteField), optionalNumber(operation, "at"));
  const thread = () => {
    const id = string(operation, "thread");
    const isSuggestion = snapshot.suggestions.some((candidate) => candidate.id === id);
    if (!snapshot.threads.some((candidate) => candidate.id === id) && !isSuggestion) throw new Error(`There's no comment thread or suggestion ${id}; app_state lists them.`);
    if (isSuggestion && operation.op === "resolve") throw new Error(`${id} is a suggestion: accept or reject it instead of resolving it.`);
    return id;
  };
  const suggestion = () => {
    const id = string(operation, "suggestion");
    if (!snapshot.suggestions.some((candidate) => candidate.id === id)) throw new Error(`There's no open suggestion ${id}; app_state lists them.`);
    return id;
  };
  switch (operation.op) {
    case "replace":
      return { kind: "replace", anchor: anchor("quote"), text: string(operation, "with") };
    case "insert": {
      const where = operation.after !== undefined ? "after" : operation.before !== undefined ? "before" : null;
      if (!where) throw new Error('insert needs "after" or "before": the quote to insert next to.');
      const text = string(operation, "text");
      if (!text) throw new Error("insert needs some text.");
      return { kind: "insert", anchor: anchor(where), where, text };
    }
    case "delete":
      return { kind: "delete", anchor: anchor("quote") };
    case "comment": {
      const text = string(operation, "text");
      if (!text.trim()) throw new Error("A comment needs some text.");
      return { kind: "comment", anchor: anchor("quote"), text };
    }
    case "reply": {
      const text = string(operation, "text");
      if (!text.trim()) throw new Error("A reply needs some text.");
      return { kind: "reply", thread: thread(), text, resolve: operation.resolve === true };
    }
    case "resolve":
      return { kind: "resolve", thread: thread() };
    case "accept":
      return { kind: "accept", suggestion: suggestion() };
    case "reject":
      return { kind: "reject", suggestion: suggestion() };
  }
  throw new Error(`Unknown operation ${JSON.stringify(operation.op)}. ${OPERATIONS_HELP}`);
}

const PROPOSALS = new Set(["replace", "insert", "delete", "comment", "reply", "resolve", "accept", "reject"]);

/** The pending change that already accepts, rejects or resolves what `body` would, if any: one is enough. */
export const pendingDecisionOn = (changes: Change[], target: string) =>
  changes.find((change) => (change.kind === "accept" || change.kind === "reject" || change.kind === "resolve" || (change.kind === "reply" && change.resolve)) && threadIdOf(change) === target);

const decisionTarget = (body: ChangeBody) => (body.kind === "accept" || body.kind === "reject" ? body.suggestion : body.kind === "resolve" || (body.kind === "reply" && body.resolve) ? body.thread : null);

function propose(document: GoogleDoc, operation: Operation, author: AppAuthor | undefined): Applied {
  const body = bodyOf(operation, requireSnapshot(document));
  const target = decisionTarget(body);
  const earlier = target && pendingDecisionOn(document.changes, target);
  if (earlier) throw new Error(`${earlier.id} already does that: ${changeSummary(earlier)}. Drop it first to decide otherwise.`);
  const yours = author?.kind === "you";
  const change: Change = { ...body, id: `c${document.nextChange}`, by: yours ? "you" : "agent", approved: yours };
  return {
    document: { ...document, changes: [...document.changes, change], nextChange: document.nextChange + 1 },
    inverse: { op: "drop", change: change.id },
    summary: `${yours ? "Added" : "Proposed"} ${change.id}: ${changeSummary(change)}.`,
    touched: [change.id],
  };
}

/** The user typed `text` as a paragraph's new text: one change takes the place of their earlier edits there. */
function write(document: GoogleDoc, block: string, text: string): Applied {
  const { body, replaces, before } = writtenChange(requireSnapshot(document), document.changes, block, text);
  const replaced = new Set(replaces.map(({ id }) => id));
  const kept = document.changes.filter(({ id }) => !replaced.has(id));
  const inverse = { op: "write", block, text: before };
  if (!body) return { document: { ...document, changes: kept }, inverse, summary: replaces.length ? `Took back your edits in ${block}: ${[...replaced].join(", ")}.` : `Nothing changed in ${block}.`, touched: [...replaced] };
  const change: Change = { ...body, id: `c${document.nextChange}`, by: "you", approved: true };
  return {
    document: { ...document, changes: [...kept, change], nextChange: document.nextChange + 1 },
    inverse,
    summary: `Wrote ${change.id}: ${changeSummary(change)}${replaces.length ? `, in place of ${[...replaced].join(", ")}` : ""}.`,
    touched: [change.id, ...replaced],
  };
}

const changeNamed = (document: GoogleDoc, id: unknown) => {
  const change = document.changes.find((candidate) => candidate.id === id);
  if (!change) throw new Error(`There's no pending change ${JSON.stringify(id)}; app_state lists them.`);
  return change;
};

const replaced = (document: GoogleDoc, changes: Change[]) => ({ ...document, changes: document.changes.map((change) => changes.find(({ id }) => id === change.id) ?? change) });

function setApproved(document: GoogleDoc, ids: string[], approved: boolean): GoogleDoc {
  return replaced(
    document,
    ids.map((id) => ({ ...changeNamed(document, id), approved })),
  );
}

/** Puts changes back, as undoing a drop or a send does; only the user's own hand keeps one approved. */
function restore(document: GoogleDoc, changes: Change[], author: AppAuthor | undefined): Applied {
  const yours = author?.kind === "you";
  for (const change of changes) {
    if (document.changes.some(({ id }) => id === change.id)) throw new Error(`${change.id} is already pending.`);
    if (change.by === "you" && !yours) throw new Error(`${change.id} is the user's own; only they can bring it back.`);
  }
  const restored = changes.map((change) => ({ ...change, approved: yours && change.approved }));
  return {
    document: { ...document, changes: [...document.changes, ...restored] },
    inverse: { op: "drop", changes: restored.map(({ id }) => id) },
    summary: `Brought back ${restored.map(({ id }) => id).join(", ")}.`,
    touched: restored.map(({ id }) => id),
  };
}

const idsOf = (operation: Operation): string[] => {
  const ids = operation.changes ?? (operation.change === undefined ? undefined : [operation.change]);
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) throw new Error('Name the change: { "change": "c3" }.');
  return ids;
};

/** Notes on changes whose quote the snapshot doesn't have once, so the view and the agent see them before sending. */
function noted(changes: Change[], snapshot: Snapshot): Change[] {
  return changes.map((change) => {
    const { note: _, ...rest } = change;
    if (isAnchored(change)) {
      const found = locate(change.anchor, snapshot);
      return "problem" in found ? { ...rest, note: found.problem } : (rest as Change);
    }
    return threadIdOf(change) && !threadIn(snapshot, threadIdOf(change)!) ? { ...rest, note: "Its comment thread or suggestion isn't in the doc any more." } : (rest as Change);
  });
}

/** The comment thread or suggestion a change replies to, resolves, accepts or rejects. */
export const threadIdOf = (change: Change): string | null => ("thread" in change ? change.thread : "suggestion" in change ? change.suggestion : null);

export const threadIn = (snapshot: Snapshot, id: string) => snapshot.threads.some((thread) => thread.id === id) || snapshot.suggestions.some((suggestion) => suggestion.id === id);

export function applyOperation(document: GoogleDoc, operation: unknown, author?: AppAuthor): Applied {
  if (typeof operation !== "object" || operation === null) throw new Error(`An operation is an object. ${OPERATIONS_HELP}`);
  const given = operation as Operation;
  if (typeof given.op === "string" && PROPOSALS.has(given.op)) return propose(document, given, author);
  switch (given.op) {
    case "link": {
      const url = given.url === null ? null : string(given, "url");
      if (document.changes.length) throw new Error(`Send or drop the ${document.changes.length} pending changes before linking another doc.`);
      const next = url === null ? { ...document, url: null, documentId: null, snapshot: null } : { ...document, url, documentId: documentIdOf(url), snapshot: documentIdOf(url) === document.documentId ? document.snapshot : null };
      return { document: next, inverse: { op: "link", url: document.url }, summary: url ? `Linked ${url}; run the task "pull" to read it.` : "Unlinked the doc." };
    }
    case "pulled": {
      const snapshot = given.snapshot as Snapshot | null;
      if (snapshot !== null && (typeof snapshot !== "object" || !Array.isArray(snapshot.tabs))) throw new Error("pulled takes the snapshot a pull read.");
      const changes = snapshot ? noted(document.changes, snapshot) : document.changes;
      const counted = snapshot ? `: ${countOf(snapshot.tabs.reduce((sum, tab) => sum + tab.blocks.length, 0), "block")}, ${countOf(snapshot.threads.length, "comment thread")}` : "";
      return {
        document: { ...document, snapshot, changes },
        inverse: { op: "pulled", snapshot: document.snapshot },
        summary: snapshot ? `Read “${snapshot.title}” as ${snapshot.account}${counted}.` : "Forgot the doc's text.",
        touched: changes.filter(({ note }) => note).map(({ id }) => id),
      };
    }
    case "approve": {
      requireUser(author, "approve a change");
      const ids = idsOf(given);
      return { document: setApproved(document, ids, true), inverse: { op: "unapprove", changes: ids }, summary: `Approved ${ids.join(", ")}.`, touched: ids };
    }
    case "approve-all": {
      requireUser(author, "approve changes");
      const ids = document.changes.filter(({ approved }) => !approved).map(({ id }) => id);
      if (!ids.length) throw new Error("Every pending change is approved already.");
      return { document: setApproved(document, ids, true), inverse: { op: "unapprove", changes: ids }, summary: `Approved ${ids.join(", ")}.`, touched: ids };
    }
    case "unapprove": {
      const ids = idsOf(given);
      return { document: setApproved(document, ids, false), inverse: { op: "approve", changes: ids }, summary: `Took back the approval of ${ids.join(", ")}.`, touched: ids };
    }
    case "drop": {
      const changes = idsOf(given).map((id) => changeNamed(document, id));
      const theUsers = changes.find(({ by }) => by === "you");
      if (theUsers && author?.kind !== "you") throw new Error(`${theUsers.id} is the user's own; only they can drop it.`);
      const ids = changes.map(({ id }) => id);
      return { document: { ...document, changes: document.changes.filter(({ id }) => !ids.includes(id)) }, inverse: { op: "restore", changes }, summary: `Dropped ${ids.join(", ")}.`, touched: ids };
    }
    case "restore":
      return restore(document, (given.changes as Change[] | undefined) ?? [], author);
    case "write":
      requireUser(author, "type into the doc");
      return write(document, string(given, "block"), string(given, "text"));
    case "direct-edits": {
      requireUser(author, "choose how their edits are sent");
      const on = given.on === true;
      return { document: { ...document, directEdits: on }, inverse: { op: "direct-edits", on: document.directEdits }, summary: on ? "Your own edits go straight into the doc on Send." : "Your own edits go to the doc as suggestions on Send." };
    }
    case "sent": {
      const ids = idsOf(given);
      const problems = (given.problems ?? {}) as Record<string, string>;
      const sent = document.changes.filter(({ id }) => ids.includes(id));
      const left = document.changes.filter(({ id }) => !ids.includes(id)).map((change) => (problems[change.id] ? { ...change, note: problems[change.id] } : change));
      return { document: { ...document, changes: left }, inverse: { op: "restore", changes: sent }, summary: `Sent ${ids.length ? ids.join(", ") : "nothing"}.`, touched: [...ids, ...Object.keys(problems)] };
    }
  }
  throw new Error(`Unknown operation ${JSON.stringify(given.op)}. ${OPERATIONS_HELP}`);
}

export const parseDocument = (text: string) => checkedDocument(JSON.parse(text));
