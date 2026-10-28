import { OBJECT_MARK, type Block, type GoogleSuggestion, type Paragraph, type Post, type Snapshot, type Tab, type TextRun, type Thread } from "./document.ts";

/** The parts of Google's documents.get reply this plugin reads. */
interface GoogleTextStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  link?: { url?: string };
}

interface GoogleParagraphElement {
  startIndex?: number;
  endIndex: number;
  textRun?: { content: string; textStyle?: GoogleTextStyle; suggestedInsertionIds?: string[]; suggestedDeletionIds?: string[]; suggestedTextStyleChanges?: Record<string, unknown> };
  suggestedInsertionIds?: string[];
  suggestedDeletionIds?: string[];
}

interface GoogleStructuralElement {
  startIndex?: number;
  endIndex: number;
  paragraph?: {
    elements: GoogleParagraphElement[];
    paragraphStyle?: { namedStyleType?: string };
    bullet?: { listId?: string; nestingLevel?: number };
    suggestedParagraphStyleChanges?: Record<string, unknown>;
    suggestedBulletChanges?: Record<string, unknown>;
  };
  table?: { tableRows: { tableCells: { content: GoogleStructuralElement[] }[] }[] };
}

interface GoogleList {
  listProperties?: { nestingLevels?: { glyphType?: string }[] };
}

interface GoogleTab {
  tabProperties: { tabId: string; title?: string };
  documentTab?: { body?: { content?: GoogleStructuralElement[] }; lists?: Record<string, GoogleList> };
  childTabs?: GoogleTab[];
}

interface GooglePost {
  content?: string;
  author?: { displayName?: string };
  createTime?: string;
  commentAction?: string;
}

export interface GoogleDocument {
  title: string;
  revisionId: string;
  tabs?: GoogleTab[];
  comments?: { commentId: string; plainTextQuote?: string; status?: string; headPost: GooglePost; replies?: GooglePost[] }[];
  suggestions?: { suggestionId: string; summaryText?: string; status?: string; headPost?: GooglePost; replies?: GooglePost[] }[];
}

/** The query documents.get takes for a pull: every tab, suggestions inline, and the comment threads. */
export const PULL_QUERY = "includeTabsContent=true&suggestionsViewMode=SUGGESTIONS_INLINE&commentsViewMode=COMMENTS_VIEW_MODE_INCLUDED";

const allTabs = (tabs: GoogleTab[]): GoogleTab[] => tabs.flatMap((tab) => [tab, ...allTabs(tab.childTabs ?? [])]);

function styleOf(style: GoogleTextStyle | undefined): Partial<TextRun> {
  if (!style) return {};
  return {
    ...(style.bold && { bold: true as const }),
    ...(style.italic && { italic: true as const }),
    ...(style.underline && { underline: true as const }),
    ...(style.strikethrough && { strikethrough: true as const }),
    ...(style.link?.url && { link: style.link.url }),
  };
}

function runOf(element: GoogleParagraphElement, paragraphStart: number): TextRun {
  const start = (element.startIndex ?? paragraphStart) - paragraphStart;
  const inserted = element.textRun?.suggestedInsertionIds ?? element.suggestedInsertionIds;
  const deleted = element.textRun?.suggestedDeletionIds ?? element.suggestedDeletionIds;
  const restyled = Object.keys(element.textRun?.suggestedTextStyleChanges ?? {}).filter((id) => !inserted?.includes(id) && !deleted?.includes(id));
  const suggested = { ...(inserted?.length && { inserted }), ...(deleted?.length && { deleted }), ...(restyled.length && { restyled }) };
  if (element.textRun) return { text: element.textRun.content, start, ...styleOf(element.textRun.textStyle), ...suggested };
  return { text: OBJECT_MARK.repeat(element.endIndex - (element.startIndex ?? paragraphStart)), start, object: true, ...suggested };
}

const withoutFinalNewline = (runs: TextRun[]) => {
  const last = runs.at(-1);
  if (!last?.text.endsWith("\n")) return runs;
  return last.text === "\n" ? runs.slice(0, -1) : [...runs.slice(0, -1), { ...last, text: last.text.slice(0, -1) }];
};

const plainText = (content: GoogleStructuralElement[]): string =>
  content
    .map((element) => (element.paragraph ? element.paragraph.elements.map((part) => part.textRun?.content ?? "").join("").replace(/\n$/, "") : element.table ? "[table]" : ""))
    .filter(Boolean)
    .join(" ");

const NOT_NUMBERED = new Set([undefined, "GLYPH_TYPE_UNSPECIFIED", "NONE"]);

/** Whether a list counts its items at this level, as 1, a or i, rather than marking them with a bullet. */
const isNumbered = (lists: Record<string, GoogleList>, bullet: { listId?: string; nestingLevel?: number }) =>
  !NOT_NUMBERED.has(lists[bullet.listId ?? ""]?.listProperties?.nestingLevels?.[bullet.nestingLevel ?? 0]?.glyphType);

/** The suggestions changing a paragraph's style or bullet, but not those that add the paragraph itself, which its text shows. */
function restyledParagraph(paragraph: NonNullable<GoogleStructuralElement["paragraph"]>, runs: TextRun[]) {
  const inserted = new Set(runs.flatMap((run) => run.inserted ?? []));
  return [...new Set([...Object.keys(paragraph.suggestedParagraphStyleChanges ?? {}), ...Object.keys(paragraph.suggestedBulletChanges ?? {})])].filter((id) => !inserted.has(id));
}

/** Numbers paragraphs p1, p2, … and tables t1, t2, … through the whole doc, so an id names one block in any tab. */
function blocksOf(content: GoogleStructuralElement[], counters: { paragraphs: number; tables: number }, lists: Record<string, GoogleList>): Block[] {
  return content.flatMap((element): Block[] => {
    if (element.paragraph) {
      const startIndex = element.startIndex ?? 0;
      const runs = withoutFinalNewline(element.paragraph.elements.map((part) => runOf(part, startIndex)));
      const { bullet } = element.paragraph;
      const restyled = restyledParagraph(element.paragraph, runs);
      const paragraph: Paragraph = {
        kind: "paragraph",
        id: `p${++counters.paragraphs}`,
        style: element.paragraph.paragraphStyle?.namedStyleType ?? "NORMAL_TEXT",
        ...(bullet && { bullet: { nesting: bullet.nestingLevel ?? 0, ...(isNumbered(lists, bullet) && { numbered: true as const }) } }),
        ...(restyled.length && { restyled }),
        startIndex,
        text: runs.map((run) => run.text).join(""),
        runs,
      };
      return [paragraph];
    }
    if (element.table) {
      return [{ kind: "table", id: `t${++counters.tables}`, rows: element.table.tableRows.map((row) => row.tableCells.map((cell) => plainText(cell.content))) }];
    }
    return [];
  });
}

function postOf(post: GooglePost): Post {
  const action = post.commentAction === "RESOLVE" ? "resolve" : post.commentAction === "REOPEN" ? "reopen" : undefined;
  return { author: post.author?.displayName ?? "Someone", content: post.content ?? "", at: post.createTime ?? "", ...(action && { action }) };
}

/** Style suggestions in the text that the doc's list of suggestions leaves out, so each still has a card to accept or reject it from. */
function unlistedStyleSuggestions(tabs: Tab[], listed: GoogleSuggestion[]): GoogleSuggestion[] {
  const paragraphs = tabs.flatMap((tab) => tab.blocks.filter((block): block is Paragraph => block.kind === "paragraph"));
  const ids = new Set(paragraphs.flatMap((paragraph) => [...(paragraph.restyled ?? []), ...paragraph.runs.flatMap((run) => run.restyled ?? [])]));
  return [...ids].filter((id) => !listed.some((suggestion) => suggestion.id === id)).map((id) => ({ id, summary: "A change of style", author: "Someone", posts: [] }));
}

export function snapshotOf(document: GoogleDocument, account: string, pulledAt: number): Snapshot {
  const counters = { paragraphs: 0, tables: 0 };
  const tabs: Tab[] = allTabs(document.tabs ?? []).map((tab) => ({
    id: tab.tabProperties.tabId,
    title: tab.tabProperties.title ?? "Tab",
    blocks: blocksOf(tab.documentTab?.body?.content ?? [], counters, tab.documentTab?.lists ?? {}),
  }));
  const threads: Thread[] = (document.comments ?? []).map((comment) => ({
    id: comment.commentId,
    quote: comment.plainTextQuote ?? "",
    status: comment.status === "RESOLVED" ? "resolved" : "open",
    posts: [comment.headPost, ...(comment.replies ?? [])].map(postOf),
  }));
  const suggestions: GoogleSuggestion[] = (document.suggestions ?? [])
    .filter((suggestion) => (suggestion.status ?? "OPEN") === "OPEN")
    .map((suggestion) => ({
      id: suggestion.suggestionId,
      summary: suggestion.summaryText ?? "",
      author: suggestion.headPost?.author?.displayName ?? "Someone",
      posts: (suggestion.replies ?? []).map(postOf),
    }));
  return { title: document.title, revisionId: document.revisionId, account, pulledAt, tabs, threads, suggestions: [...suggestions, ...unlistedStyleSuggestions(tabs, suggestions)] };
}
