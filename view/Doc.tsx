import { memo, useEffect, useMemo, useRef, useState, type FocusEvent } from "react";
import { OBJECT_MARK, type Block, type Change, type Paragraph, type Snapshot } from "../shared/document.ts";
import { editedText, unwritable } from "../shared/write.ts";
import { marksOf, piecesOf, type Mark, type Piece } from "./marks.ts";

const TAGS: Record<string, "h1" | "h2" | "h3" | "h4" | "h5" | "h6"> = { TITLE: "h1", HEADING_1: "h1", HEADING_2: "h2", HEADING_3: "h3", HEADING_4: "h4", HEADING_5: "h5", HEADING_6: "h6" };

interface Props {
  snapshot: Snapshot;
  changes: Change[];
  /** Whether the user can type in the doc now; a touch screen turns it on with Edit. */
  editable: boolean;
  focused: string | null;
  onFocus(id: string | null): void;
  /** Clicking marked text opens what marks it in the sidebar. */
  onOpen(id: string): void;
  /** The user left a paragraph they typed in: its text as they wrote it. Whether it was written. */
  onWrite(block: string, text: string): boolean;
  /** The text of the paragraph the user is typing in, as it is now, or null once they leave it. */
  onTyping(block: string, text: string | null): void;
}

type Shared = Pick<Props, "focused" | "onFocus" | "onOpen">;

function TextPiece({ piece, focused, onFocus, onOpen }: { piece: Extract<Piece, { kind: "text" }> } & Shared) {
  const { run, mark } = piece;
  if (mark?.mine && mark.kind === "deleted") return null;
  const suggestions = run.inserted ?? run.deleted;
  const opened = mark?.id ?? suggestions?.[0];
  const classes = [run.bold && "bold", run.italic && "italic", run.underline && "underline", run.strikethrough && "strike", run.inserted && "their-insertion", run.deleted && "their-deletion", run.object && "object", mark && `mark-${mark.kind}`, (mark?.id === focused || (focused !== null && suggestions?.includes(focused))) && "focused"].filter(Boolean).join(" ");
  const text = run.object ? "▣".repeat(piece.text.length) : piece.text;
  return (
    <span
      className={classes || undefined}
      data-start={piece.start}
      data-mark={mark?.id}
      data-suggestions={suggestions?.join(" ")}
      data-object={run.object ? "" : undefined}
      contentEditable={run.object ? false : undefined}
      title={run.link}
      onClick={opened ? () => onOpen(opened) : undefined}
      onMouseEnter={mark && (() => onFocus(mark.id))}
      onMouseLeave={mark && (() => onFocus(null))}
    >
      {text}
    </span>
  );
}

/** A change's added text: the agent's can't be typed in, the user's own reads as already written. */
function AddedPiece({ mark, text, focused, onOpen }: { mark: Mark; text: string } & Pick<Props, "focused" | "onOpen">) {
  const className = ["added", mark.mine && "mine", mark.id === focused && "focused"].filter(Boolean).join(" ");
  if (mark.mine)
    return (
      <span className={className} data-mark={mark.id} onClick={() => onOpen(mark.id)}>
        {text}
      </span>
    );
  return (
    <ins className={className} data-mark={mark.id} contentEditable={false} onClick={() => onOpen(mark.id)}>
      {text}
    </ins>
  );
}

/** After a line break at the end of a paragraph, the caret has nowhere to go but before it; this gives it a place after it. */
const CARET_HOLDER = "\u200B";

/** The text a paragraph shows as typed: images and chips as their mark, and none of the agent's added text. */
function typedText(paragraph: HTMLElement): string {
  const textOf = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (!(node instanceof HTMLElement)) return "";
    if (node.dataset.object !== undefined) return OBJECT_MARK.repeat(node.textContent?.length ?? 0);
    if (node !== paragraph && !node.isContentEditable) return "";
    return [...node.childNodes].map(textOf).join("");
  };
  return textOf(paragraph).replaceAll(CARET_HOLDER, "");
}

/** Enter as the input it asks for rather than as a key: a phone's keyboard may send no key for it. */
function breakLineOnEnter(event: InputEvent) {
  if (event.inputType !== "insertParagraph" && event.inputType !== "insertLineBreak") return;
  if (!(event.target as Element).closest(".writable")) return;
  event.preventDefault();
  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  if (!range) return;
  range.deleteContents();
  const lineBreak = document.createTextNode(`\n${CARET_HOLDER}`);
  range.insertNode(lineBreak);
  selection!.collapse(lineBreak, lineBreak.length);
}

interface ParagraphProps extends Shared {
  paragraph: Paragraph;
  marks: Mark[];
  /** The paragraph's text with the user's own edits made, as they type on from. */
  written: string;
  editing: boolean;
  /** The user left it with a write the doc hasn't shown yet, so it keeps what they typed until it does. */
  settling: boolean;
  editable: boolean;
  onEditing(block: string): void;
  onLeave(block: string, wrote: boolean): void;
  onWrite: Props["onWrite"];
  onTyping: Props["onTyping"];
}

/** While the user types in a paragraph, and until the doc shows what they wrote, React leaves it alone: the text they typed is in the page, not in its pieces. */
const ParagraphView = memo(
  function ParagraphView({ paragraph, marks, written, editable, focused, onFocus, onOpen, onEditing, onLeave, onWrite, onTyping }: ParagraphProps) {
    const Tag = TAGS[paragraph.style] ?? "p";
    const pieces = piecesOf(paragraph, marks);
    const problem = editable ? unwritable(paragraph) : null;
    const writable = editable && !problem;
    const className = [paragraph.style === "SUBTITLE" && "subtitle", paragraph.bullet && "bullet", writable && "writable"].filter(Boolean).join(" ") || undefined;
    const leave = (event: FocusEvent<HTMLElement>) => {
      onTyping(paragraph.id, null);
      const text = typedText(event.currentTarget);
      onLeave(paragraph.id, text !== written && onWrite(paragraph.id, text));
    };
    return (
      <Tag
        className={className}
        data-block={paragraph.id}
        style={paragraph.bullet && { marginInlineStart: `${1.5 + paragraph.bullet.nesting * 1.5}em` }}
        contentEditable={writable}
        suppressContentEditableWarning
        spellCheck={false}
        title={problem ?? undefined}
        onFocus={() => onEditing(paragraph.id)}
        onBlur={writable ? leave : undefined}
        onInput={writable ? (event) => onTyping(paragraph.id, typedText(event.currentTarget)) : undefined}
      >
        {pieces.map((piece, index) => (piece.kind === "text" ? <TextPiece key={index} piece={piece} focused={focused} onFocus={onFocus} onOpen={onOpen} /> : <AddedPiece key={index} mark={piece.mark} text={piece.text} focused={focused} onOpen={onOpen} />))}
        {paragraph.text === "" && pieces.length === 0 && <br />}
      </Tag>
    );
  },
  (before, after) => (before.editing || before.settling) && (after.editing || after.settling),
);

function BlockView({ block, ...rest }: { block: Block; marks: Map<string, Mark[]>; written: (paragraph: Paragraph) => string; editing: string | null; settling: string[]; editable: boolean; onEditing(block: string): void; onLeave: ParagraphProps["onLeave"]; onWrite: Props["onWrite"]; onTyping: Props["onTyping"] } & Shared) {
  if (block.kind === "table")
    return (
      <table data-block={block.id}>
        <tbody>
          {block.rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, column) => (
                <td key={column}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  const { marks, written, editing, settling, ...shared } = rest;
  return <ParagraphView paragraph={block} marks={marks.get(block.id) ?? []} written={written(block)} editing={editing === block.id} settling={settling.includes(block.id)} {...shared} />;
}

/** What one of the user's own marks changes in the text, as the paragraph shows it. */
const editOfMark = ({ kind, start, end, added }: Mark) => (kind === "point" ? { start: added!.at, end: added!.at, text: added!.text } : { start, end, text: added?.text ?? "" });

/** The doc as Google shows it, with the pending changes and the open threads marked in its text; the user types into its paragraphs. */
export function Doc({ snapshot, changes, editable, focused, onFocus, onOpen, onWrite, onTyping }: Props) {
  const marks = useMemo(() => marksOf(snapshot, changes), [snapshot, changes]);
  const page = useRef<HTMLElement>(null);
  useEffect(() => {
    const article = page.current!;
    article.addEventListener("beforeinput", breakLineOnEnter);
    return () => article.removeEventListener("beforeinput", breakLineOnEnter);
  }, []);
  const [editing, setEditing] = useState<string | null>(null);
  /** Bumped when the user is done with a paragraph, so React draws it afresh rather than on top of what they typed. */
  const [drawn, setDrawn] = useState<Record<string, number>>({});
  const redraw = (blocks: string[]) => setDrawn((counts) => ({ ...counts, ...Object.fromEntries(blocks.map((block) => [block, (counts[block] ?? 0) + 1])) }));
  const [settling, setSettling] = useState<string[]>([]);
  useEffect(() => {
    const settled = settling.filter((block) => block !== editing);
    if (!settled.length) return;
    redraw(settled);
    setSettling((blocks) => blocks.filter((block) => !settled.includes(block)));
  }, [snapshot, changes]);
  const written = (paragraph: Paragraph) => editedText(paragraph.text, (marks.get(paragraph.id) ?? []).filter(({ mine }) => mine).map(editOfMark));
  const leave = (block: string, wrote: boolean) => {
    setEditing(null);
    if (wrote) setSettling((blocks) => [...blocks, block]);
    else redraw([block]);
  };
  return (
    <article className="page" ref={page}>
      {snapshot.tabs.map((tab) => (
        <section key={tab.id} data-tab={tab.id}>
          {snapshot.tabs.length > 1 && <div className="tab-title">{tab.title}</div>}
          {tab.blocks.map((block) => (
            <BlockView key={`${block.id}:${drawn[block.id] ?? 0}`} block={block} marks={marks} written={written} editing={editing} settling={settling} editable={editable} onEditing={setEditing} onLeave={leave} onWrite={onWrite} onTyping={onTyping} focused={focused} onFocus={onFocus} onOpen={onOpen} />
          ))}
        </section>
      ))}
    </article>
  );
}

/** The selected text of one paragraph: a selection over several paragraphs has a part for each. */
export interface SelectedPart {
  block: string;
  quote: string;
  at: number;
}

export interface Selected {
  parts: SelectedPart[];
  /** Where the selection shows, for the box asking what to do with it. */
  rect: DOMRect;
}

/** Where a point of a selection falls in its paragraph's text, from the piece it is in; null in a change's added text. */
function offsetOf(node: Node, offset: number): { block: string; at: number } | null {
  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
  const block = element?.closest<HTMLElement>("[data-block]");
  if (!block || element?.closest("ins")) return null;
  const piece = element?.closest<HTMLElement>("[data-start]");
  if (!piece) return offset === 0 && element === block ? { block: block.dataset.block!, at: 0 } : null;
  const inPiece = node.nodeType === Node.TEXT_NODE ? Math.min(offset, piece.textContent?.length ?? 0) : 0;
  return { block: block.dataset.block!, at: Number(piece.dataset.start) + inPiece };
}

/** The text selected in the doc, as each paragraph's own text, or null for a selection that can't be asked about. */
export function selectionIn(snapshot: Snapshot, selection: Selection | null): Selected | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const start = offsetOf(range.startContainer, range.startOffset);
  const end = offsetOf(range.endContainer, range.endOffset);
  if (!start || !end) return null;
  const blocks = snapshot.tabs.flatMap((tab) => tab.blocks);
  const first = blocks.findIndex((block) => block.id === start.block);
  const last = blocks.findIndex((block) => block.id === end.block);
  if (first === -1 || last < first || (first === last && end.at <= start.at)) return null;
  const parts = blocks
    .slice(first, last + 1)
    .filter((block): block is Paragraph => block.kind === "paragraph")
    .map((paragraph) => {
      const from = paragraph.id === start.block ? start.at : 0;
      const to = paragraph.id === end.block ? end.at : paragraph.text.length;
      return { block: paragraph.id, quote: paragraph.text.slice(from, to), at: from };
    })
    .filter(({ quote }) => quote.trim());
  if (!parts.length || (parts.length === 1 && parts[0].quote.includes(OBJECT_MARK))) return null;
  return { parts, rect: range.getBoundingClientRect() };
}
