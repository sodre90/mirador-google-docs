/** A run of text in a paragraph, with its place in the paragraph's text counted in UTF-16 code units, as Google counts. */
export interface TextRun {
  text: string;
  start: number;
  bold?: true;
  italic?: true;
  underline?: true;
  strikethrough?: true;
  link?: string;
  /** Google's own open suggestions this text is part of, as inserted or as deleted text. */
  inserted?: string[];
  deleted?: string[];
  /** An image, a chip or another object, which takes up places in the doc but has no text: its text is OBJECT_MARK. */
  object?: true;
}

/** What stands for an object in a paragraph's text, one per place it takes up. */
export const OBJECT_MARK = "\uFFFC";

export interface Paragraph {
  kind: "paragraph";
  id: string;
  /** Google's named style: NORMAL_TEXT, TITLE, SUBTITLE, HEADING_1 to HEADING_6. */
  style: string;
  bullet?: { nesting: number };
  /** Where its text starts in the tab, as Google's indexes count. */
  startIndex: number;
  /** Its text without the newline that ends it. */
  text: string;
  runs: TextRun[];
}

export interface Table {
  kind: "table";
  id: string;
  rows: string[][];
}

export type Block = Paragraph | Table;

export interface Tab {
  id: string;
  title: string;
  blocks: Block[];
}

export interface Post {
  author: string;
  content: string;
  at: string;
  action?: "resolve" | "reopen";
}

export interface Thread {
  id: string;
  quote: string;
  status: "open" | "resolved";
  posts: Post[];
}

/** A suggestion in the doc, made in Docs' suggesting mode by anyone, the user included; it has a thread like a comment's. */
export interface GoogleSuggestion {
  id: string;
  summary: string;
  author: string;
  /** The replies on its thread. */
  posts: Post[];
}

/** The doc as the latest pull read it. */
export interface Snapshot {
  title: string;
  revisionId: string;
  account: string;
  pulledAt: number;
  tabs: Tab[];
  threads: Thread[];
  suggestions: GoogleSuggestion[];
}

/** Where a change goes: a quote in a paragraph, with the text just around it to find it again after the doc changed. */
export interface Anchor {
  tab: string;
  block: string;
  quote: string;
  prefix: string;
  suffix: string;
}

export type ChangeBody =
  | { kind: "replace"; anchor: Anchor; text: string }
  | { kind: "insert"; anchor: Anchor; where: "before" | "after"; text: string }
  | { kind: "delete"; anchor: Anchor }
  | { kind: "comment"; anchor: Anchor; text: string }
  | { kind: "reply"; thread: string; text: string; resolve: boolean }
  | { kind: "resolve"; thread: string }
  | { kind: "accept"; suggestion: string }
  | { kind: "reject"; suggestion: string };

export type Change = ChangeBody & {
  id: string;
  by: "agent" | "you";
  approved: boolean;
  /** Why it can't be sent as it is, e.g. its text isn't in the doc any more. */
  note?: string;
};

export type AnchoredChange = Extract<Change, { anchor: Anchor }>;

export const isAnchored = (change: Change): change is AnchoredChange => "anchor" in change;

/** The app's document: a link to a Google doc, what the latest pull read, and the changes waiting to be sent. */
export interface GoogleDoc {
  url: string | null;
  documentId: string | null;
  snapshot: Snapshot | null;
  changes: Change[];
  nextChange: number;
}

export const newDocument = (): GoogleDoc => ({ url: null, documentId: null, snapshot: null, changes: [], nextChange: 1 });

/** The doc's id in a Google Docs address, or the id itself. */
export function documentIdOf(url: string): string {
  const id = url.match(/\/document\/(?:u\/\d+\/)?d\/([\w-]{20,})/)?.[1] ?? url.match(/^[\w-]{20,}$/)?.[0];
  if (!id) throw new Error(`${url} isn't a Google Docs address; give one like https://docs.google.com/document/d/<id>/edit.`);
  return id;
}

/** Reads the app's file, which may also be a bare link file that holds just { "url": "…" }. */
export function checkedDocument(value: unknown): GoogleDoc {
  if (typeof value !== "object" || value === null) throw new Error("not a Google Docs link: the file should hold an object with a url");
  const given = value as Partial<GoogleDoc>;
  if (given.url !== undefined && given.url !== null && typeof given.url !== "string") throw new Error("not a Google Docs link: url must be a string");
  const url = given.url ?? null;
  return {
    url,
    documentId: url ? documentIdOf(url) : null,
    snapshot: given.snapshot ?? null,
    changes: Array.isArray(given.changes) ? given.changes : [],
    nextChange: typeof given.nextChange === "number" ? given.nextChange : 1,
  };
}

export const paragraphs = (tab: Tab) => tab.blocks.filter((block): block is Paragraph => block.kind === "paragraph");

export function findParagraph(snapshot: Snapshot, id: string): { tab: Tab; paragraph: Paragraph } | null {
  for (const tab of snapshot.tabs) {
    const block = tab.blocks.find((candidate) => candidate.id === id);
    if (block?.kind === "paragraph") return { tab, paragraph: block };
  }
  return null;
}
