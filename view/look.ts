import type { CSSProperties } from "react";
import type { TextLook, TextRun } from "../shared/document.ts";

/** How far the dark page lifts a doc colour toward white, after turning a dark colour light. */
const DARK_LIFT = 0.3;

const hex = (channels: number[]) => `#${channels.map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;

/**
 * A doc colour for the dark page: a dark colour's lightness turned over, keeping its hue and saturation, so black
 * reads as white and greys keep their order; then lifted a little toward white so saturated colours stay readable.
 */
export function darkColorOf(color: string): string {
  const channels = [1, 3, 5].map((at) => parseInt(color.slice(at, at + 2), 16));
  const lightnessTurn = Math.max(0, 255 - Math.max(...channels) - Math.min(...channels));
  return hex(channels.map((channel) => channel + lightnessTurn).map((channel) => channel + (255 - channel) * DARK_LIFT));
}

/** A doc colour as CSS: as Docs gives it on the light page, and readable on the dark one. */
export const docColorOf = (color: string): string => `light-dark(${color}, ${darkColorOf(color)})`;

/** The CSS that shows text as Docs styles it: its size, family and colour, and its weight, bold or as the doc weighs it. */
export function lookCss(look: TextLook | undefined): CSSProperties {
  const weight = look?.bold ? 700 : (look?.fontWeight ?? (look?.bold === false ? 400 : undefined));
  return {
    ...(look?.fontSize !== undefined && { fontSize: `${look.fontSize}pt` }),
    ...(look?.fontFamily !== undefined && { fontFamily: `"${look.fontFamily}", sans-serif` }),
    ...(weight !== undefined && { fontWeight: weight }),
    ...(look?.color !== undefined && { color: docColorOf(look.color) }),
  };
}

/**
 * A run's look over its paragraph's named style: its own type where it sets it, inheriting the rest. The named style's
 * colour stays on the paragraph so that a link, a chip or a suggestion colours it first; a run's own colour is kept,
 * unless the doc's suggestion already colours it.
 */
export function runLook(run: TextRun, base: TextLook | undefined): TextLook {
  const { color: _named, ...inherited } = base ?? {};
  return {
    ...inherited,
    ...(run.bold !== undefined && { bold: run.bold }),
    ...(run.italic !== undefined && { italic: run.italic }),
    ...(run.underline !== undefined && { underline: run.underline }),
    ...(run.strikethrough !== undefined && { strikethrough: run.strikethrough }),
    ...(run.fontSize !== undefined && { fontSize: run.fontSize }),
    ...(run.fontFamily !== undefined && { fontFamily: run.fontFamily }),
    ...(run.fontWeight !== undefined && { fontWeight: run.fontWeight }),
    ...(run.color !== undefined && !(run.inserted || run.deleted) && { color: run.color }),
  };
}
