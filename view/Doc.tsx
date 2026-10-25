import { useMemo } from "react";
import { OBJECT_MARK, type Block, type Change, type Paragraph, type Snapshot } from "../shared/document.ts";
import { marksOf, piecesOf, type Mark, type Piece } from "./marks.ts";

const TAGS: Record<string, "h1" | "h2" | "h3" | "h4" | "h5" | "h6"> = { TITLE: "h1", HEADING_1: "h1", HEADING_2: "h2", HEADING_3: "h3", HEADING_4: "h4", HEADING_5: "h5", HEADING_6: "h6" };

interface Props {
  snapshot: Snapshot;
  changes: Change[];
  focused: string | null;
  onFocus(id: string | null): void;
}

function TextPiece({ piece, focused, onFocus }: { piece: Extract<Piece, { kind: "text" }>; focused: string | null; onFocus: Props["onFocus"] }) {
  const { run, mark } = piece;
  const classes = [run.bold && "bold", run.italic && "italic", run.underline && "underline", run.strikethrough && "strike", run.inserted && "their-insertion", run.deleted && "their-deletion", run.object && "object", mark && `mark-${mark.kind}`, (mark?.id === focused || (focused !== null && (run.inserted ?? run.deleted)?.includes(focused))) && "focused"].filter(Boolean).join(" ");
  const text = run.object ? "▣".repeat(piece.text.length) : piece.text;
  return (
    <span className={classes || undefined} data-start={piece.start} data-mark={mark?.id} title={run.link} onMouseEnter={mark && (() => onFocus(mark.id))} onMouseLeave={mark && (() => onFocus(null))}>
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

function ParagraphView({ paragraph, marks, focused, onFocus }: { paragraph: Paragraph; marks: Mark[] } & Pick<Props, "focused" | "onFocus">) {
  const Tag = TAGS[paragraph.style] ?? "p";
  const pieces = piecesOf(paragraph, marks);
  const className = [paragraph.style === "SUBTITLE" && "subtitle", paragraph.bullet && "bullet"].filter(Boolean).join(" ") || undefined;
  return (
    <Tag className={className} data-block={paragraph.id} style={paragraph.bullet && { marginInlineStart: `${1.5 + paragraph.bullet.nesting * 1.5}em` }}>
      {pieces.map((piece, index) => (piece.kind === "text" ? <TextPiece key={index} piece={piece} focused={focused} onFocus={onFocus} /> : <AddedPiece key={index} mark={piece.mark} text={piece.text} focused={focused} />))}
      {paragraph.text === "" && pieces.length === 0 && <br />}
    </Tag>
  );
}

function BlockView({ block, marks, focused, onFocus }: { block: Block; marks: Map<string, Mark[]> } & Pick<Props, "focused" | "onFocus">) {
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
  return <ParagraphView paragraph={block} marks={marks.get(block.id) ?? []} focused={focused} onFocus={onFocus} />;
}

/** The doc as Google shows it, with the pending changes and the open threads marked in its text. */
export function Doc({ snapshot, changes, focused, onFocus }: Props) {
  const marks = useMemo(() => marksOf(snapshot, changes), [snapshot, changes]);
  return (
    <article className="page">
      {snapshot.tabs.map((tab) => (
        <section key={tab.id} data-tab={tab.id}>
          {snapshot.tabs.length > 1 && <div className="tab-title">{tab.title}</div>}
          {tab.blocks.map((block) => (
            <BlockView key={block.id} block={block} marks={marks} focused={focused} onFocus={onFocus} />
          ))}
        </section>
      ))}
    </article>
  );
}

export interface Selected {
  block: string;
  quote: string;
  at: number;
  /** Where the selection shows, for the box asking what to do with it. */
  rect: DOMRect;
}

/** Where a point of a selection falls in its paragraph's text, from the piece it is in; null in a change's added text. */
function offsetOf(node: Node, offset: number): { block: string; at: number } | null {
  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
  const piece = element?.closest<HTMLElement>("[data-start]");
  const block = element?.closest<HTMLElement>("[data-block]");
  if (!piece || !block || element?.closest("ins")) return null;
  const inPiece = node.nodeType === Node.TEXT_NODE ? Math.min(offset, piece.textContent?.length ?? 0) : 0;
  return { block: block.dataset.block!, at: Number(piece.dataset.start) + inPiece };
}

/** The text selected in one paragraph of the doc, as the paragraph's own text, or null for any other selection. */
export function selectionIn(snapshot: Snapshot, selection: Selection | null): Selected | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const start = offsetOf(range.startContainer, range.startOffset);
  const end = offsetOf(range.endContainer, range.endOffset);
  if (!start || !end || start.block !== end.block || end.at <= start.at) return null;
  const paragraph = snapshot.tabs.flatMap((tab) => tab.blocks).find((block): block is Paragraph => block.id === start.block && block.kind === "paragraph");
  if (!paragraph) return null;
  const quote = paragraph.text.slice(start.at, end.at);
  if (!quote.trim() || quote.includes(OBJECT_MARK)) return null;
  return { block: start.block, quote, at: start.at, rect: range.getBoundingClientRect() };
}
