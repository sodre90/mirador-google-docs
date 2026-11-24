import { describe, expect, test } from "bun:test";
import type { TextRun } from "../shared/document.ts";
import { darkColorOf, docColorOf, lookCss, runLook } from "../view/look.ts";
import { styledRun } from "../view/marks.ts";

const run = (style: Partial<TextRun> = {}): TextRun => ({ text: "Heading", start: 0, ...style });

describe("the doc's look in the view", () => {
  test("a doc colour keeps its hue on the dark page, black reads as white, and greys keep their order", () => {
    expect(docColorOf("#ff550d")).toBe("light-dark(#ff550d, #ff8856)");
    expect(darkColorOf("#000000")).toBe("#ffffff");
    expect(darkColorOf("#666666")).toBe("#b8b8b8");
    expect(darkColorOf("#0b57d0")).toBe("#6da3f7");
    expect(darkColorOf("#ffffff")).toBe("#ffffff");
  });

  test("a run inherits its named style's flags and type, and switches them off with its own", () => {
    const heading = { bold: true, italic: true, color: "#ff550d", fontSize: 23, fontWeight: 500 };
    expect(runLook(run(), heading)).toEqual({ bold: true, italic: true, fontSize: 23, fontWeight: 500 });
    expect(runLook(run({ italic: false, fontSize: 10 }), heading)).toEqual({ bold: true, italic: false, fontSize: 10, fontWeight: 500 });
    expect(runLook(run({ color: "#0b57d0" }), heading).color).toBe("#0b57d0");
    expect(runLook(run({ color: "#0b57d0", inserted: ["suggest.a"] }), heading).color).toBeUndefined();
  });

  test("text that isn't bold gets a normal weight, even where its paragraph is bold and the doc gives no weight", () => {
    expect(lookCss({ bold: true, fontWeight: 500 }).fontWeight).toBe(700);
    expect(lookCss({ fontWeight: 500 }).fontWeight).toBe(500);
    expect(lookCss({ bold: false }).fontWeight).toBe(400);
    expect(lookCss({}).fontWeight).toBeUndefined();
    expect(lookCss(runLook(styledRun(run(), { bold: false }), { bold: true })).fontWeight).toBe(400);
    expect(lookCss({ fontSize: 11, fontFamily: "Arial", color: "#000000" })).toEqual({ fontSize: "11pt", fontFamily: '"Arial", sans-serif', color: "light-dark(#000000, #ffffff)" });
  });
});
