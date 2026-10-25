/**
 * Mirador's app plugin API, version 4, as this plugin uses it. Mirador doesn't publish these types yet, so this is a copy
 * of its shared/apps.ts and of the `window.mirador` bridge in its shared/canvas-document.ts.
 */

/** What the host module exports. Mirador calls it in its own process, and shows what a call throws to whoever made the change. */
export interface AppHost<Document = unknown> {
  parse(text: string): Document;
  serialize(document: Document): string;
  /** API 4 passes the author, so an operation can be kept for the user alone. */
  apply(document: Document, operation: unknown, author: AppAuthor): { document: Document; inverse: unknown; summary: string; touched?: string[] };
  describe(document: Document): string;
  /** The document for a file the app edits, both relative to the workspace; null for the app's own document. Mirador ignores it before app_open took edited files. */
  documentFor?(file: string): string | null;
  /** `openedFile`, relative to the document's folder, is the file app_open was given for the document through documentFor. */
  create?(openedFile?: string): Document;
  tasks?: Record<string, AppTask<Document>>;
}

/** Runs outside the queue of operations, one task at a time for each document. */
export interface AppTask<Document = unknown> {
  title: string;
  /** Resolves to a summary of what it did, for whoever ran it. */
  run(context: AppTaskContext<Document>): Promise<string>;
}

export interface AppTaskContext<Document = unknown> {
  /** The document as it was when the task started. */
  document: Document;
  /** The absolute path of a file in the folder of the document, or below it, which may not exist yet. */
  file(path: string): string;
  documentFolder: string;
  workspaceFolder: string;
  pluginFolder: string;
  author: AppAuthor;
  apply(operation: unknown): Promise<AppChange>;
  /** How far along it is, from 0 to 1, or null when it can't tell. */
  progress(done: number | null, text?: string): void;
  /** Aborted when the user stops the task, the app closes or Mirador stops. */
  signal: AbortSignal;
}

export interface AppTaskState {
  name: string;
  title: string;
  runId: number;
  state: "running" | "done" | "failed" | "stopped";
  author: AppAuthor;
  done: number | null;
  text: string | null;
  summary: string | null;
  problem: string | null;
  startedAt: number;
  endedAt: number | null;
}

export type AppAuthor =
  | { kind: "agent"; conversationId: string; turnSeq: number | null }
  | { kind: "you" }
  | { kind: "outside" };

export interface AppChange {
  seq: number;
  author: AppAuthor;
  summary: string;
  touched: string[];
  at: number;
}

/** What the view gets on every change. */
export interface AppDocumentState<Document = unknown> {
  workspaceId: string;
  app: string;
  document: Document;
  lastChange: AppChange | null;
  /** Why the file isn't shown as it is now: it stopped parsing after an edit made outside Mirador. */
  problem: string | null;
  task: AppTaskState | null;
}

/** `window.mirador` in the view's frame. */
export interface MiradorBridge<Document = unknown> {
  onState(listener: (state: AppDocumentState<Document>) => void): () => void;
  apply(operation: unknown): void;
  /** Sends the user's words, with up to 4 pictures, to the agent of the conversation the view is open in. */
  prompt(text: string, options?: { images?: Blob[] }): Promise<void>;
  readFile(path: string): Promise<Blob>;
  /** An address a video or img element streams a file next to the document from; it changes when the file does. */
  mediaUrl(path: string): Promise<string>;
  run(task: string): void;
  stopTask(): void;
  storage: Storage;
}

declare global {
  interface Window {
    mirador: MiradorBridge;
  }
}
