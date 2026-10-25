import { useMemo } from "react";
import { OBJECT_MARK, type Block, type Change, type Paragraph, type Snapshot } from "../shared/document.ts";
import { marksOf, piecesOf, type Mark, type Piece } from "./marks.ts";

const TAGS: Record<string, "h1" | "h2" | "h3" | "h4" | "h5" | "h6"> = { TITLE: "h1", HEADING_1: "h1", HEADING_2: "h2", HEADING_3: "h3", HEADING_4: "h4", HEADING_5: "h5", HEADING_6: "h6" };

interface Props {
  snapshot: Snapshot;
  changes: Change[];
  focused: string | null;
  onFocus(id: string | null): void;
  /** Clicking marked text opens what marks it in the sidebar. */
  onOpen(id: string): void;
}

function TextPiece({ piece, focused, onFocus, onOpen }: { piece: Extract<Piece, { kind: "text" }> } & Pick<Props, "focused" | "onFocus" | "onOpen">) {
  const { run, mark } = piece;
  const suggestions = run.inserted ?? run.deleted;
  const opened = mark?.id ?? suggestions?.[0];
  const classes = [run.bold && "bold", run.italic && "italic", run.underline && "underline", run.strikethrough && "strike", run.inserted && "their-insertion", run.deleted && "their-deletion", run.object && "object", mark && `mark-${mark.kind}`, (mark?.id === focused || (focused !== null && suggestions?.includes(focused))) && "focused"].filter(Boolean).join(" ");
  const text = run.object ? "▣".repeat(piece.text.length) : piece.text;
  return (
    <span className={classes || undefined} data-start={piece.start} data-mark={mark?.id} data-suggestions={suggestions?.join(" ")} title={run.link} onClick={opened ? () => onOpen(opened) : undefined} onMouseEnter={mark && (() => onFocus(mark.id))} onMouseLeave={mark && (() => onFocus(null))}>
      {text}
    </span>
  );
}

function AddedPiece({ mark, text, focused }: { mark: Mark; text: string; focused: string | null }) {
  return (
    <ins className={mark.id === focused ? "added focused" : "added"} data-mark={mark.id} contentEditable={false}>
      {text}
    </ins>
  );
}

function ParagraphView({ paragraph, marks, focused, onFocus, onOpen }: { paragraph: Paragraph; marks: Mark[] } & Pick<Props, "focused" | "onFocus" | "onOpen">) {
  const Tag = TAGS[paragraph.style] ?? "p";
  const pieces = piecesOf(paragraph, marks);
  const className = [paragraph.style === "SUBTITLE" && "subtitle", paragraph.bullet && "bullet"].filter(Boolean).join(" ") || undefined;
  return (
    <Tag className={className} data-block={paragraph.id} style={paragraph.bullet && { marginInlineStart: `${1.5 + paragraph.bullet.nesting * 1.5}em` }}>
      {pieces.map((piece, index) => (piece.kind === "text" ? <TextPiece key={index} piece={piece} focused={focused} onFocus={onFocus} onOpen={onOpen} /> : <AddedPiece key={index} mark={piece.mark} text={piece.text} focused={focused} />))}
      {paragraph.text === "" && pieces.length === 0 && <br />}
    </Tag>
  );
}

function BlockView({ block, marks, focused, onFocus, onOpen }: { block: Block; marks: Map<string, Mark[]> } & Pick<Props, "focused" | "onFocus" | "onOpen">) {
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
  return <ParagraphView paragraph={block} marks={marks.get(block.id) ?? []} focused={focused} onFocus={onFocus} onOpen={onOpen} />;
}

/** The doc as Google shows it, with the pending changes and the open threads marked in its text. */
export function Doc({ snapshot, changes, focused, onFocus, onOpen }: Props) {
  const marks = useMemo(() => marksOf(snapshot, changes), [snapshot, changes]);
  return (
    <article className="page">
      {snapshot.tabs.map((tab) => (
        <section key={tab.id} data-tab={tab.id}>
          {snapshot.tabs.length > 1 && <div className="tab-title">{tab.title}</div>}
          {tab.blocks.map((block) => (
            <BlockView key={block.id} block={block} marks={marks} focused={focused} onFocus={onFocus} onOpen={onOpen} />
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
