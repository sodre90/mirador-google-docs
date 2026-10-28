import type { AppAuthor } from "../mirador/api.ts";
import { anchorIn, locate, paragraphAnchor, spanOf, spansOverlap } from "./anchor.ts";
import { checkedDocument, documentIdOf, findParagraph, isAnchored, LISTS, PARAGRAPH_STYLES, TEXT_STYLES, type Anchor, type Change, type ChangeBody, type GoogleDoc, type List, type Paragraph, type ParagraphStyle, type Snapshot, type TextStyle } from "./document.ts";
import { STYLE_NAMES } from "./styles.ts";
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
  '- { "op": "format", "block": "p12", "quote": "launch", "bold": true, "link": "https://example.com" }: any of bold, italic, underline, strikethrough (true or false), and link (an address, or null to take the link off)',
  `- { "op": "paragraph", "block": "p12", "style": "HEADING_2", "list": "numbered" }: either or both; style is one of ${PARAGRAPH_STYLES.join(", ")}, list one of ${LISTS.join(", ")}`,
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

export const styleSummary = (style: TextStyle) =>
  [
    ...TEXT_STYLES.filter((name) => style[name] !== undefined).map((name) => (style[name] ? name : `not ${name}`)),
    ...(style.link === undefined ? [] : [style.link === null ? "no link" : `a link to ${style.link}`]),
  ].join(", ");

const LIST_NAMES: Record<List, string> = { bulleted: "a bulleted list item", numbered: "a numbered list item", none: "no list item" };

export const paragraphSummary = ({ style, list }: { style?: ParagraphStyle; list?: List }) => [style && (STYLE_NAMES[style] ?? "Normal text"), list && LIST_NAMES[list]].filter(Boolean).join(", ");

export function changeSummary(change: ChangeBody): string {
  switch (change.kind) {
    case "replace":
      return `replace ${quoted(change.anchor.quote)} in ${change.anchor.block} with ${quoted(change.text)}`;
    case "insert":
      if (!change.anchor.quote) return `write ${quoted(change.text)} in the empty paragraph ${change.anchor.block}`;
      return `insert ${quoted(change.text)} ${change.where} ${quoted(change.anchor.quote)} in ${change.anchor.block}`;
    case "delete":
      return `delete ${quoted(change.anchor.quote)} in ${change.anchor.block}`;
    case "format":
      return `make ${quoted(change.anchor.quote)} in ${change.anchor.block} ${styleSummary(change.style)}`;
    case "paragraph":
      return `make ${change.anchor.block} ${paragraphSummary(change)}`;
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
    case "format":
      return formatBody(operation, anchor("quote"));
    case "paragraph":
      return paragraphBody(operation, snapshot);
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

function formatBody(operation: Operation, anchor: Anchor): ChangeBody {
  const style: TextStyle = {};
  for (const name of TEXT_STYLES) {
    const value = operation[name];
    if (value === undefined) continue;
    if (typeof value !== "boolean") throw new Error(`${name} must be true or false.`);
    style[name] = value;
  }
  if (operation.link !== undefined) {
    const link = operation.link;
    if (link !== null && (typeof link !== "string" || !/^(https?:|mailto:)\S+$/.test(link))) throw new Error("link must be an address such as https://example.com, or null to take the link off.");
    style.link = link;
  }
  if (!Object.keys(style).length) throw new Error(`format needs a style to set: ${[...TEXT_STYLES, "link"].join(", ")}.`);
  return { kind: "format", anchor, style };
}

/** Whether all of [start, end) of a paragraph already has the style. */
export function styledAlready(paragraph: Paragraph, start: number, end: number, style: TextStyle) {
  const covering = paragraph.runs.filter((run) => run.start < end && start < run.start + run.text.length);
  return covering.every((run) => TEXT_STYLES.every((name) => style[name] === undefined || style[name] === (run[name] === true)) && (style.link === undefined || style.link === (run.link ?? null)));
}

/** Text of one paragraph, as a selection gives it. */
export interface Stretch {
  block: string;
  at: number;
  quote: string;
}

/** The pending format of just this stretch, if any. */
export function formatOf(snapshot: Snapshot, changes: Change[], { block, at, quote }: Stretch) {
  return changes.find((change): change is Change & { kind: "format" } => {
    if (change.kind !== "format") return false;
    const located = locate(change.anchor, snapshot);
    return !("problem" in located) && located.paragraph.id === block && located.start === at && located.end === at + quote.length;
  });
}

/** Whether a stretch of a paragraph shows the style, with a pending format of just that stretch made. */
export function shownStyled(snapshot: Snapshot, changes: Change[], stretch: Stretch, style: TextStyle): boolean {
  const found = findParagraph(snapshot, stretch.block);
  if (!found) return false;
  const { at } = stretch;
  const end = at + stretch.quote.length;
  const exact = formatOf(snapshot, changes, stretch);
  return Object.entries(style).every(([name, value]) => {
    const pending = exact?.style[name as keyof TextStyle];
    return pending !== undefined ? pending === value : styledAlready(found.paragraph, at, end, { [name]: value });
  });
}

/** A paragraph's style and list with its pending change of them made. */
export function shownParagraph(snapshot: Snapshot, changes: Change[], block: string): { style: string; list: List } | null {
  const found = findParagraph(snapshot, block);
  if (!found) return null;
  const pending = changes.find((change): change is Change & { kind: "paragraph" } => {
    if (change.kind !== "paragraph") return false;
    const located = locate(change.anchor, snapshot);
    return !("problem" in located) && located.paragraph.id === block;
  });
  return { style: pending?.style ?? found.paragraph.style, list: pending?.list ?? listOf(found.paragraph) };
}

/** What a button of the selection box asks for. */
export type BoxRequest = { toggle: "bold" | "italic" } | { link: string | null } | { paragraph: { style: ParagraphStyle } | { list: List } };

/**
 * The user's operations a selection box button makes for the selected text, leaving out what already is that way, or
 * why it can't be done: all of them go in, or none.
 */
export function boxOperations(document: GoogleDoc, parts: Stretch[], request: BoxRequest): { operations: Operation[] } | { problem: string } {
  const snapshot = requireSnapshot(document);
  const shown = (part: Stretch, style: TextStyle) => shownStyled(snapshot, document.changes, part, style);
  const formats = (style: TextStyle) => parts.filter((part) => !shown(part, style)).map(({ block, quote, at }) => ({ op: "format", block, quote, at, ...style }));
  const operations: Operation[] = (() => {
    if ("toggle" in request) {
      const name = request.toggle;
      return formats({ [name]: !parts.every((part) => shown(part, { [name]: true })) });
    }
    if ("link" in request) return formats({ link: request.link });
    const wanted = request.paragraph;
    return [...new Set(parts.map(({ block }) => block))]
      .filter((block) => {
        const now = shownParagraph(snapshot, document.changes, block);
        return "style" in wanted ? now?.style !== wanted.style : now?.list !== wanted.list;
      })
      .map((block) => ({ op: "paragraph", block, ...wanted }));
  })();
  try {
    operations.reduce((current, operation) => applyOperation(current, operation, { kind: "you" }).document, document);
  } catch (error) {
    return { problem: (error as Error).message };
  }
  return { operations };
}

export const listOf = (paragraph: Paragraph): List => (!paragraph.bullet ? "none" : paragraph.bullet.numbered ? "numbered" : "bulleted");

function paragraphBody(operation: Operation, snapshot: Snapshot): ChangeBody {
  const block = string(operation, "block");
  const found = findParagraph(snapshot, block);
  if (!found) throw new Error(`There's no paragraph ${block} in the doc; app_state lists them.`);
  const { paragraph } = found;
  const style = operation.style;
  const list = operation.list;
  if (style !== undefined && !PARAGRAPH_STYLES.includes(style as ParagraphStyle)) throw new Error(`style must be one of ${PARAGRAPH_STYLES.join(", ")}.`);
  if (list !== undefined && !LISTS.includes(list as List)) throw new Error(`list must be one of ${LISTS.join(", ")}.`);
  if (style === undefined && list === undefined) throw new Error("paragraph needs a style or a list to set.");
  const newList = list !== undefined && list !== listOf(paragraph) ? (list as List) : undefined;
  if (newList && newList !== "none" && !paragraph.bullet && paragraph.text.startsWith("\t")) throw new Error(`${block} starts with a tab, which Google would take out to nest the item, moving the text after it: take the tab out first.`);
  if (newList && newList !== "none" && paragraph.bullet && paragraph.bullet.nesting > 0) throw new Error(`${block} is nested in its list, and changing the kind of a nested item would lose its place: change the list's kind from its top item.`);
  return { kind: "paragraph", anchor: paragraphAnchor(snapshot, block), ...(style !== undefined && { style: style as ParagraphStyle }), ...(list !== undefined && { list: list as List }) };
}

type StyleChange = Extract<ChangeBody, { kind: "format" | "paragraph" }>;

const isStyleChange = (body: ChangeBody): body is StyleChange => body.kind === "format" || body.kind === "paragraph";

/** A style change without the parts that the doc has already, or null when nothing is left of it. */
function withoutNoOps(body: StyleChange, snapshot: Snapshot): StyleChange | null {
  const found = locate(body.anchor, snapshot);
  if ("problem" in found) return body;
  const { paragraph, start, end } = found;
  if (body.kind === "format") {
    const style = Object.fromEntries(Object.entries(body.style).filter(([name, value]) => !styledAlready(paragraph, start, end, { [name]: value })));
    return Object.keys(style).length ? { ...body, style } : null;
  }
  const { style, list, ...rest } = body;
  const changed = { ...rest, ...(style !== undefined && style !== paragraph.style && { style }), ...(list !== undefined && list !== listOf(paragraph) && { list }) };
  return changed.style || changed.list ? changed : null;
}

const alreadyMessage = (body: StyleChange) => (body.kind === "format" ? `“${body.anchor.quote}” is ${styleSummary(body.style)} already.` : `${body.anchor.block} is ${paragraphSummary(body)} already.`);

/** The user's own pending style change on just what `body` changes: the same stretch of text, or the same paragraph. */
function ownStyleChangeOn(document: GoogleDoc, body: StyleChange): (Change & StyleChange) | undefined {
  const snapshot = requireSnapshot(document);
  const mine = locate(body.anchor, snapshot);
  if ("problem" in mine) return undefined;
  return document.changes.find((change): change is Change & StyleChange => {
    if (change.by !== "you" || change.kind !== body.kind) return false;
    const theirs = locate(change.anchor, snapshot);
    if ("problem" in theirs || theirs.paragraph.id !== mine.paragraph.id) return false;
    return body.kind === "paragraph" || (theirs.start === mine.start && theirs.end === mine.end);
  });
}

/** The user restyles what their own pending change restyles: one change takes both, or none when the doc is back as it was. */
function restyledOwn(document: GoogleDoc, own: Change & StyleChange, body: StyleChange): Applied {
  const merged: StyleChange =
    own.kind === "format" && body.kind === "format" ? { ...own, style: { ...own.style, ...body.style } } : ({ ...own, ...body, anchor: own.anchor } as StyleChange);
  const kept = withoutNoOps(merged, requireSnapshot(document));
  if (!kept) return { document: { ...document, changes: document.changes.filter(({ id }) => id !== own.id) }, inverse: { op: "restore", changes: [own] }, summary: `Took back ${own.id}.`, touched: [own.id] };
  const change = { ...own, ...kept } as Change;
  return { document: replaced(document, [change]), inverse: { op: "put", change: own }, summary: `Changed ${own.id}: ${changeSummary(change)}.`, touched: [own.id] };
}

const PROPOSALS = new Set(["replace", "insert", "delete", "format", "paragraph", "comment", "reply", "resolve", "accept", "reject"]);

/** The pending change that already accepts, rejects or resolves what `body` would, if any: one is enough. */
export const pendingDecisionOn = (changes: Change[], target: string) =>
  changes.find((change) => (change.kind === "accept" || change.kind === "reject" || change.kind === "resolve" || (change.kind === "reply" && change.resolve)) && threadIdOf(change) === target);

const decisionTarget = (body: ChangeBody) => (body.kind === "accept" || body.kind === "reject" ? body.suggestion : body.kind === "resolve" || (body.kind === "reply" && body.resolve) ? body.thread : null);

/** A change that Send makes to a stretch of text, which another such change on the same text would land in. */
export const changesText = (change: ChangeBody) => change.kind === "replace" || change.kind === "insert" || change.kind === "delete" || change.kind === "format";

/** The pending change that `body` would clash with when sent: one on the same text, or one on the same paragraph's style. */
export function changeClashing(document: GoogleDoc, body: ChangeBody, ignoring: string[] = []): Change | undefined {
  if (!changesText(body) && body.kind !== "paragraph") return undefined;
  const snapshot = requireSnapshot(document);
  const placed = (change: ChangeBody) => {
    const located = locate((change as Change & { anchor: Anchor }).anchor, snapshot);
    return "problem" in located ? null : { located, ...spanOf(change, located) };
  };
  const mine = placed(body);
  if (!mine) return undefined;
  return document.changes.find((change) => {
    if (ignoring.includes(change.id) || (change.kind === "paragraph") !== (body.kind === "paragraph") || !(changesText(change) || change.kind === "paragraph")) return false;
    const theirs = placed(change);
    if (!theirs) return false;
    return body.kind === "paragraph" ? theirs.located.paragraph.id === mine.located.paragraph.id : spansOverlap(mine, theirs);
  });
}

function propose(document: GoogleDoc, operation: Operation, author: AppAuthor | undefined): Applied {
  const snapshot = requireSnapshot(document);
  const raw = bodyOf(operation, snapshot);
  const own = author?.kind === "you" && isStyleChange(raw) ? ownStyleChangeOn(document, raw) : undefined;
  if (own) return restyledOwn(document, own, raw as StyleChange);
  const body = isStyleChange(raw) ? withoutNoOps(raw, snapshot) : raw;
  if (!body) throw new Error(alreadyMessage(raw as StyleChange));
  const target = decisionTarget(body);
  const earlier = target && pendingDecisionOn(document.changes, target);
  if (earlier) throw new Error(`${earlier.id} already does that: ${changeSummary(earlier)}. Drop it first to decide otherwise.`);
  const clash = changeClashing(document, body);
  if (clash) throw new Error(`${clash.id} already changes ${clash.kind === "paragraph" ? "this paragraph" : "this text"} (${changeSummary(clash)}): drop it first, or make one change that covers both.`);
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
    case "put": {
      requireUser(author, "put back their own change");
      const change = given.change as Change;
      const current = changeNamed(document, change?.id);
      return { document: replaced(document, [change]), inverse: { op: "put", change: current }, summary: `Put back ${change.id}: ${changeSummary(change)}.`, touched: [change.id] };
    }
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
