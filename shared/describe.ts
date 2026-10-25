import { OBJECT_MARK, type Block, type GoogleDoc, type Paragraph, type Snapshot } from "./document.ts";
import { changeSummary, OPERATIONS_HELP } from "./operations.ts";

const STYLE_NAMES: Record<string, string> = { TITLE: "Title", SUBTITLE: "Subtitle", HEADING_1: "Heading 1", HEADING_2: "Heading 2", HEADING_3: "Heading 3", HEADING_4: "Heading 4", HEADING_5: "Heading 5", HEADING_6: "Heading 6" };

/** A paragraph's text with Google's own suggestions marked: [+inserted+] and [-deleted-]. */
function markedText(paragraph: Paragraph) {
  return paragraph.runs
    .map((run) => {
      const text = run.object ? "[object]" : run.text;
      if (run.inserted) return `[+${text}+]`;
      if (run.deleted) return `[-${text}-]`;
      return text;
    })
    .join("");
}

function blockLine(block: Block) {
  if (block.kind === "table") return `${block.id} [table, read only] ${block.rows.map((row) => row.join(" | ")).join(" / ")}`;
  const style = STYLE_NAMES[block.style];
  const bullet = block.bullet ? `${"  ".repeat(block.bullet.nesting)}• ` : "";
  return `${block.id} ${style ? `[${style}] ` : ""}${bullet}${markedText(block)}`;
}

function snapshotText(snapshot: Snapshot) {
  const read = new Date(snapshot.pulledAt).toISOString().replace("T", " ").slice(0, 16);
  const hasMarks = snapshot.tabs.some((tab) => tab.blocks.some((block) => block.kind === "paragraph" && block.runs.some((run) => run.inserted || run.deleted)));
  const hasObjects = snapshot.tabs.some((tab) => tab.blocks.some((block) => block.kind === "paragraph" && block.text.includes(OBJECT_MARK)));
  const notes = [
    hasMarks && "Text in [+…+] and [-…-] is the doc's open suggestions; a quote includes their text but not the brackets.",
    hasObjects && `[object] is an image or chip; in a quote it is the character ${JSON.stringify(OBJECT_MARK)}.`,
  ].filter(Boolean);
  const tabs = snapshot.tabs.map((tab) => [snapshot.tabs.length > 1 ? `Tab “${tab.title}”:` : null, ...tab.blocks.map(blockLine)].filter(Boolean).join("\n"));
  const threads = snapshot.threads.length
    ? [
        "Comment threads:",
        ...snapshot.threads.map((thread) => `- ${thread.id} (${thread.status}) on “${thread.quote}”: ${thread.posts.map((post) => (post.action && !post.content ? `${post.author} ${post.action}d it` : `${post.author}: “${post.content}”`)).join("; ")}`),
      ].join("\n")
    : "No comment threads.";
  const suggestions = snapshot.suggestions.length
    ? ["Suggestions in the doc:", ...snapshot.suggestions.map((suggestion) => `- ${suggestion.id} by ${suggestion.author}: ${suggestion.summary}${suggestion.posts.length ? `; ${suggestion.posts.map((post) => `${post.author}: “${post.content}”`).join("; ")}` : ""}`)].join("\n")
    : null;
  return [`“${snapshot.title}”, read ${read} UTC as ${snapshot.account}.`, ...notes, ...tabs, threads, suggestions].filter(Boolean).join("\n\n");
}

export function describeDocument(document: GoogleDoc): string {
  if (!document.url) return `No doc is linked yet. Apply { "op": "link", "url": "https://docs.google.com/document/d/<id>/edit" }, then run the task "pull".`;
  if (!document.snapshot) return `Linked to ${document.url}, not read yet: run the task "pull".`;
  const changes = document.changes.length
    ? [
        "Pending changes:",
        ...document.changes.map((change) => `- ${change.id} by ${change.by === "you" ? "the user" : "you, the agent"}, ${change.approved ? "approved" : "waiting for approval"}: ${changeSummary(change)}${change.note ? ` (can't be sent: ${change.note})` : ""}`),
      ].join("\n")
    : "No pending changes.";
  return [`Google Doc ${document.url}`, snapshotText(document.snapshot), changes, OPERATIONS_HELP].join("\n\n");
}
