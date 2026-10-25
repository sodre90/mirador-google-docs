import { useEffect, useRef, useState } from "react";
import type { AppDocumentState } from "../mirador/api.ts";
import type { Change, GoogleDoc, GoogleSuggestion, Post, Snapshot, Thread } from "../shared/document.ts";
import { changeSummary, pendingDecisionOn } from "../shared/operations.ts";
import { Doc, selectionIn, type Selected } from "./Doc.tsx";

const mirador = () => window.mirador;

function TaskLine({ state }: { state: AppDocumentState<GoogleDoc> }) {
  const { task, problem } = state;
  if (problem) return <p className="problem">The file can't be read: {problem}</p>;
  if (!task) return null;
  if (task.state === "running")
    return (
      <p className="task">
        {task.text ?? task.title}… <button onClick={() => mirador().stopTask()}>Stop</button>
      </p>
    );
  if (task.state === "failed") return <p className="problem">{task.problem}</p>;
  if (task.state === "done") return <p className="task done">{task.summary}</p>;
  return <p className="task">{task.title}: stopped.</p>;
}

function LinkForm() {
  const [url, setUrl] = useState("");
  return (
    <div className="empty">
      <p>No doc yet. Paste a Google Docs address, or ask the agent to open one.</p>
      <div className="row">
        <input aria-label="Google Docs address" placeholder="https://docs.google.com/document/d/…" value={url} onChange={(event) => setUrl(event.target.value)} />
        <button disabled={!url.trim()} onClick={() => mirador().apply({ op: "link", url: url.trim() })}>
          Link
        </button>
      </div>
    </div>
  );
}

function ChangeCard({ change, focused, onFocus }: { change: Change; focused: boolean; onFocus(id: string | null): void }) {
  const by = change.by === "you" ? "You" : "Agent";
  return (
    <li className={["change", change.approved && "approved", focused && "focused", change.note && "stuck"].filter(Boolean).join(" ")} data-change={change.id} onMouseEnter={() => onFocus(change.id)} onMouseLeave={() => onFocus(null)}>
      <div className="who">
        {change.id} · {by}
        {change.approved && <span className="badge">Approved</span>}
      </div>
      <div className="what">{changeSummary(change)}</div>
      {change.note && <div className="note">Can't be sent: {change.note}</div>}
      <div className="row">
        {change.approved ? (
          <button onClick={() => mirador().apply({ op: "unapprove", change: change.id })}>Undo approval</button>
        ) : (
          <button className="primary" onClick={() => mirador().apply({ op: "approve", change: change.id })}>
            Approve
          </button>
        )}
        <button onClick={() => mirador().apply({ op: "drop", change: change.id })}>Drop</button>
      </div>
    </li>
  );
}

/** A comment thread or a suggestion in the doc, as a reply is written to it. */
interface Discussion {
  id: string;
  /** What it is about, for the agent: a comment thread on a quote, or a suggestion's summary. */
  about: string;
  posts: Post[];
  resolvable: boolean;
}

const discussionOfThread = (thread: Thread): Discussion => ({ id: thread.id, about: `comment thread ${thread.id}${thread.quote ? ` on “${thread.quote}”` : ""}`, posts: thread.posts, resolvable: true });

const discussionOfSuggestion = (suggestion: GoogleSuggestion): Discussion => ({ id: suggestion.id, about: `${suggestion.author}'s suggestion ${suggestion.id} (${suggestion.summary})`, posts: suggestion.posts, resolvable: false });

/** What the agent hears when the user asks it to reply to a thread or a suggestion, saying what the reply should get across. */
export function replyRequest(discussion: Discussion, words: string) {
  const posts = discussion.posts.filter(({ content }) => content).map((post) => `- ${post.author}: “${post.content}”`);
  const example = { op: "reply", thread: discussion.id, text: "…", ...(discussion.resolvable && { resolve: false }) };
  return [
    `Write a reply to ${discussion.about}:`,
    ...posts,
    `What the reply should say: ${words.trim()}`,
    `Propose it with apply, e.g. ${JSON.stringify(example)}${discussion.resolvable ? " (resolve: true if it settles the thread)" : ""}; I approve it in the view before it goes to the doc.`,
  ].join("\n");
}

type Replying = { by: "you" | "agent"; text: string } | null;

/** The reply buttons of a thread or a suggestion, and the box for writing one or for telling the agent what to write. */
function ReplyArea({ discussion, actions }: { discussion: Discussion; actions: React.ReactNode }) {
  const [replying, setReplying] = useState<Replying>(null);
  const [asked, setAsked] = useState(false);
  const words = replying?.text.trim() ?? "";
  const reply = (resolve: boolean) => {
    mirador().apply({ op: "reply", thread: discussion.id, text: replying!.text, ...(resolve && { resolve }) });
    setReplying(null);
  };
  const askTheAgent = async () => {
    await mirador().prompt(replyRequest(discussion, replying!.text));
    setReplying(null);
    setAsked(true);
  };
  if (replying === null)
    return (
      <>
        {asked && <div className="quiet">Asked the agent; its reply shows in Pending changes.</div>}
        <div className="row">
          <button onClick={() => setReplying({ by: "you", text: "" })}>Reply</button>
          <button onClick={() => setReplying({ by: "agent", text: "" })}>Ask the agent to reply</button>
          {actions}
        </div>
      </>
    );
  return (
    <div className="reply">
      <textarea
        aria-label={replying.by === "you" ? "Reply" : "What should the reply say?"}
        placeholder={replying.by === "agent" ? "What should the reply say? The agent writes it." : undefined}
        autoFocus
        value={replying.text}
        onChange={(event) => setReplying({ ...replying, text: event.target.value })}
      />
      <div className="row">
        {replying.by === "you" ? (
          <>
            <button className="primary" disabled={!words} onClick={() => reply(false)}>
              Reply
            </button>
            {discussion.resolvable && (
              <button disabled={!words} onClick={() => reply(true)}>
                Reply and resolve
              </button>
            )}
          </>
        ) : (
          <button className="primary" disabled={!words} onClick={askTheAgent}>
            Ask the agent
          </button>
        )}
        <button onClick={() => setReplying(null)}>Cancel</button>
      </div>
    </div>
  );
}

const Posts = ({ posts }: { posts: Post[] }) =>
  posts.map((post, index) => (
    <div key={index} className="post">
      <b>{post.author}</b> {post.content || (post.action === "resolve" ? "resolved it" : post.action === "reopen" ? "reopened it" : "")}
    </div>
  ));

function ThreadCard({ thread, decision, focused, onFocus }: { thread: Thread; decision: Change | undefined; focused: boolean; onFocus(id: string | null): void }) {
  return (
    <li className={["thread", thread.status, focused && "focused"].filter(Boolean).join(" ")} data-thread={thread.id} onMouseEnter={() => onFocus(thread.id)} onMouseLeave={() => onFocus(null)}>
      {thread.quote && <div className="quote">“{thread.quote}”</div>}
      <Posts posts={thread.posts} />
      {thread.status === "resolved" ? (
        <div className="badge">Resolved</div>
      ) : (
        <ReplyArea discussion={discussionOfThread(thread)} actions={decision ? <span className="decided">Resolved in {decision.id}, not sent yet</span> : <button onClick={() => mirador().apply({ op: "resolve", thread: thread.id })}>Resolve</button>} />
      )}
    </li>
  );
}

function SuggestionCard({ suggestion, focused, onFocus }: { suggestion: GoogleSuggestion; focused: boolean; onFocus(id: string | null): void }) {
  const decide = (op: "accept" | "reject") => mirador().apply({ op, suggestion: suggestion.id });
  return (
    <li className={["suggestion", focused && "focused"].filter(Boolean).join(" ")} data-suggestion={suggestion.id} onMouseEnter={() => onFocus(suggestion.id)} onMouseLeave={() => onFocus(null)}>
      <div className="who">{suggestion.author}</div>
      <div className="what">{suggestion.summary}</div>
      <Posts posts={suggestion.posts} />
      <ReplyArea
        discussion={discussionOfSuggestion(suggestion)}
        actions={
          <>
            <button onClick={() => decide("accept")}>Accept</button>
            <button onClick={() => decide("reject")}>Reject</button>
          </>
        }
      />
    </li>
  );
}

/** What the agent hears when the user asks for a change to the text they selected. */
export function rewriteRequest(selected: Omit<Selected, "rect">, words: string) {
  const example = { op: "replace", block: selected.block, quote: selected.quote, at: selected.at, with: "…" };
  return `About “${selected.quote}” in ${selected.block}: ${words.trim()}\nPropose it with apply, e.g. ${JSON.stringify(example)}; I approve it in the view before it goes to the doc.`;
}

function SelectionBox({ selected, onDone }: { selected: Selected; onDone(): void }) {
  const [words, setWords] = useState("");
  const [sent, setSent] = useState(false);
  const box = { top: selected.rect.bottom + window.scrollY + 6, left: Math.max(8, Math.min(selected.rect.left + window.scrollX, window.innerWidth - 340)) };
  const ask = async () => {
    setSent(true);
    await mirador().prompt(rewriteRequest(selected, words));
    onDone();
  };
  const comment = () => {
    mirador().apply({ op: "comment", block: selected.block, quote: selected.quote, at: selected.at, text: words.trim() });
    onDone();
  };
  return (
    <div className="selection-box" style={box} role="dialog" aria-label="Selected text" onMouseDown={(event) => event.stopPropagation()}>
      <div className="quote">“{selected.quote.length > 80 ? `${selected.quote.slice(0, 80)}…` : selected.quote}”</div>
      <textarea
        aria-label="What should change here?"
        placeholder="What should change here? Or write a comment."
        autoFocus
        value={words}
        onChange={(event) => setWords(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onDone();
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && words.trim()) void ask();
        }}
      />
      <div className="row">
        <button className="primary" disabled={!words.trim() || sent} onClick={ask}>
          Ask the agent
        </button>
        <button disabled={!words.trim()} onClick={comment}>
          Comment
        </button>
        <button onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}

function Sidebar({ document, focused, onFocus }: { document: GoogleDoc & { snapshot: Snapshot }; focused: string | null; onFocus(id: string | null): void }) {
  const approved = document.changes.filter((change) => change.approved).length;
  const waiting = document.changes.length - approved;
  const { snapshot } = document;
  const undecided = snapshot.suggestions.filter((suggestion) => !pendingDecisionOn(document.changes, suggestion.id));
  return (
    <aside className="sidebar">
      <section>
        <h3>Pending changes</h3>
        {document.changes.length === 0 ? (
          <p className="quiet">None yet. Select text in the doc to ask for a change, or ask the agent in the chat.</p>
        ) : (
          <>
            <div className="row">
              {waiting > 0 && <button onClick={() => mirador().apply({ op: "approve-all" })}>Approve all</button>}
              <button className="primary" disabled={approved === 0} onClick={() => mirador().run("push")}>
                Send to Google Docs{approved ? ` (${approved})` : ""}
              </button>
            </div>
            <ul>
              {document.changes.map((change) => (
                <ChangeCard key={change.id} change={change} focused={focused === change.id} onFocus={onFocus} />
              ))}
            </ul>
          </>
        )}
      </section>
      <section>
        <h3>Comments</h3>
        {snapshot.threads.length === 0 ? (
          <p className="quiet">No comments. Select text to write one.</p>
        ) : (
          <ul>
            {snapshot.threads.map((thread) => (
              <ThreadCard key={thread.id} thread={thread} decision={pendingDecisionOn(document.changes, thread.id)} focused={focused === thread.id} onFocus={onFocus} />
            ))}
          </ul>
        )}
      </section>
      {undecided.length > 0 && (
        <section>
          <h3>Suggestions in the doc</h3>
          <ul>
            {undecided.map((suggestion) => (
              <SuggestionCard key={suggestion.id} suggestion={suggestion} focused={focused === suggestion.id} onFocus={onFocus} />
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}

export function App({ state }: { state: AppDocumentState<GoogleDoc> }) {
  const document = state.document;
  const [focused, setFocused] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const docArea = useRef<HTMLDivElement>(null);
  const running = state.task?.state === "running";

  useEffect(() => {
    const noted = document.snapshot;
    if (!noted) return;
    const onMouseUp = (event: MouseEvent) => {
      if (!docArea.current?.contains(event.target as Node)) return;
      const found = selectionIn(noted, window.getSelection());
      if (found) setSelected(found);
    };
    const onMouseDown = () => setSelected(null);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [document.snapshot]);

  return (
    <div className="app">
      <header>
        <div className="title">
          <h2>{document.snapshot?.title ?? "Google Docs"}</h2>
          {document.snapshot && (
            <span className="quiet">
              {document.snapshot.account} · read {new Date(document.snapshot.pulledAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
        </div>
        <div className="row">
          {document.url && (
            <button disabled={running} onClick={() => mirador().run("pull")}>
              {document.snapshot ? "Read again" : "Read the doc"}
            </button>
          )}
          <button disabled={running} onClick={() => mirador().run("sign-in")}>
            Sign in a Google account
          </button>
        </div>
      </header>
      <TaskLine state={state} />
      {!document.url ? (
        <LinkForm />
      ) : !document.snapshot ? (
        <p className="empty">Linked to {document.url}. Read the doc to see it here.</p>
      ) : (
        <div className="body">
          <div className="doc" ref={docArea}>
            <Doc snapshot={document.snapshot} changes={document.changes} focused={focused} onFocus={setFocused} />
          </div>
          <Sidebar document={{ ...document, snapshot: document.snapshot }} focused={focused} onFocus={setFocused} />
        </div>
      )}
      {selected && (
        <SelectionBox
          selected={selected}
          onDone={() => {
            setSelected(null);
            window.getSelection()?.removeAllRanges();
          }}
        />
      )}
    </div>
  );
}
