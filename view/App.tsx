import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { AppDocumentState } from "../mirador/api.ts";
import type { Change, GoogleDoc, GoogleSuggestion, Post, Snapshot, Thread } from "../shared/document.ts";
import { changeSummary, pendingDecisionOn } from "../shared/operations.ts";
import { writtenChange } from "../shared/write.ts";
import { Doc, selectionIn, type Selected, type SelectedPart } from "./Doc.tsx";

const mirador = () => window.mirador;

/** A phone or a tablet: the doc reads first and types after Edit, and its boxes sit at the bottom, clear of the keyboard and the selection handles. */
const touchScreen = matchMedia("(pointer: coarse)").matches;

/** Whether the view is as narrow as Mirador's canvas panel often is beside the chat, or a phone. */
function useNarrow() {
  const [narrow, setNarrow] = useState(() => matchMedia(NARROW).matches);
  useEffect(() => {
    const query = matchMedia(NARROW);
    const follow = () => setNarrow(query.matches);
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, []);
  return narrow;
}

const NARROW = "(max-width: 900px)";

/** How much of the page the on-screen keyboard covers: Chrome and iOS keep the page's height and shrink only what shows of it. */
function useKeyboardHeight() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!touchScreen || !viewport) return;
    const measure = () => window.document.documentElement.style.setProperty("--keyboard", `${Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)}px`);
    viewport.addEventListener("resize", measure);
    viewport.addEventListener("scroll", measure);
    return () => {
      viewport.removeEventListener("resize", measure);
      viewport.removeEventListener("scroll", measure);
    };
  }, []);
}

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
  if (task.state === "failed" && task.name === "push" && task.author.kind === "agent") return <p className="task">The agent asked to send the changes. Look them over, then press Send.</p>;
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

/** What every card of the sidebar shares: hovering it marks its text in the doc, and clicking it opens it and shows that text. */
interface CardProps {
  focused: boolean;
  open: boolean;
  onFocus(id: string | null): void;
  onOpen(id: string | null): void;
}

const cardClass = (kind: string, { focused, open }: CardProps, ...more: (string | false | undefined)[]) => [kind, focused && "focused", open && "open", ...more].filter(Boolean).join(" ");

const hoverProps = (id: string, { onFocus }: CardProps) => ({ onMouseEnter: () => onFocus(id), onMouseLeave: () => onFocus(null) });

function CardHead({ id, card, children }: { id: string; card: CardProps; children: React.ReactNode }) {
  return (
    <button className="card-head" aria-expanded={card.open} onClick={() => card.onOpen(card.open ? null : id)}>
      {children}
    </button>
  );
}

const goesInDirectly = (document: GoogleDoc, change: Change) => document.directEdits && change.by === "you" && (change.kind === "replace" || change.kind === "insert" || change.kind === "delete");

function ApprovalButtons({ change }: { change: Change }) {
  return (
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
  );
}

function ChangeCard({ change, direct, ...card }: { change: Change; direct: boolean } & CardProps) {
  const by = change.by === "you" ? "You" : "Agent";
  return (
    <li className={cardClass("change", card, change.approved && "approved", change.note && "stuck")} data-change={change.id} {...hoverProps(change.id, card)}>
      <CardHead id={change.id} card={card}>
        <div className="who">
          {change.id} · {by}
          {change.approved && <span className="badge">Approved</span>}
          {direct && <span className="badge direct">Goes in directly</span>}
        </div>
        <div className={card.open ? "what" : "what clamped"}>{changeSummary(change)}</div>
      </CardHead>
      {change.note && <div className="note">Can't be sent: {change.note}</div>}
      <ApprovalButtons change={change} />
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

const repliesNote = (replies: number) => (replies === 0 ? "" : ` · ${replies} ${replies === 1 ? "reply" : "replies"}`);

function ThreadCard({ thread, decision, ...card }: { thread: Thread; decision: Change | undefined } & CardProps) {
  const [first] = thread.posts;
  return (
    <li className={cardClass("thread", card, thread.status)} data-thread={thread.id} {...hoverProps(thread.id, card)}>
      <CardHead id={thread.id} card={card}>
        {thread.quote && <div className="quote one-line">“{thread.quote}”</div>}
        {!card.open && first && (
          <div className="one-line">
            <b>{first.author}</b> {first.content}
            <span className="quiet">{repliesNote(thread.posts.length - 1)}</span>
          </div>
        )}
      </CardHead>
      {card.open && (
        <>
          <Posts posts={thread.posts} />
          {thread.status === "resolved" ? (
            <div className="badge">Resolved</div>
          ) : (
            <ReplyArea discussion={discussionOfThread(thread)} actions={decision ? <span className="decided">Resolved in {decision.id}, not sent yet</span> : <button onClick={() => mirador().apply({ op: "resolve", thread: thread.id })}>Resolve</button>} />
          )}
        </>
      )}
    </li>
  );
}

function SuggestionCard({ suggestion, ...card }: { suggestion: GoogleSuggestion } & CardProps) {
  const decide = (op: "accept" | "reject") => mirador().apply({ op, suggestion: suggestion.id });
  return (
    <li className={cardClass("suggestion", card)} data-suggestion={suggestion.id} {...hoverProps(suggestion.id, card)}>
      <CardHead id={suggestion.id} card={card}>
        <div className="who">
          {suggestion.author}
          <span>{repliesNote(suggestion.posts.length)}</span>
        </div>
        <div className={card.open ? "what" : "what clamped"}>{suggestion.summary}</div>
      </CardHead>
      {card.open && (
        <>
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
        </>
      )}
    </li>
  );
}

const exampleReplace = ({ block, quote, at }: SelectedPart) => JSON.stringify({ op: "replace", block, quote, at, with: "…" });

/** What the agent hears when the user asks for a change to the text they selected. */
export function rewriteRequest(parts: SelectedPart[], words: string) {
  const approval = "I approve it in the view before it goes to the doc.";
  if (parts.length === 1) return `About “${parts[0].quote}” in ${parts[0].block}: ${words.trim()}\nPropose it with apply, e.g. ${exampleReplace(parts[0])}; ${approval}`;
  const first = parts[0];
  const last = parts[parts.length - 1];
  return [
    `About the text from ${first.block} through ${last.block}:`,
    ...parts.map(({ block, quote }) => `- ${block}: “${quote}”`),
    words.trim(),
    `Propose it with apply, one change per paragraph, e.g. ${exampleReplace(first)}; ${approval}`,
  ].join("\n");
}

const shortQuote = (parts: SelectedPart[]) => {
  const text = parts.map(({ quote }) => quote).join(" ¶ ");
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
};

/** One-click asks for what most selections end in. */
const QUICK_REWRITES = [
  { label: "Tighten", words: "Tighten this: say the same in fewer, plainer words." },
  { label: "Fix grammar", words: "Fix the grammar, spelling and punctuation; change nothing else." },
  { label: "More formal", words: "Make this more formal, keeping its meaning." },
  { label: "Shorter", words: "Make this shorter, keeping what matters." },
];

function SelectionBox({ selected, onDone }: { selected: Selected; onDone(): void }) {
  const [asking, setAsking] = useState(false);
  const [words, setWords] = useState("");
  const [sent, setSent] = useState(false);
  const { parts } = selected;
  const oneParagraph = parts.length === 1;
  const box = touchScreen ? undefined : { top: selected.rect.bottom + window.scrollY + 6, left: Math.max(8, Math.min(selected.rect.left + window.scrollX, window.innerWidth - 340)) };
  const askFor = async (request: string) => {
    setSent(true);
    await mirador().prompt(rewriteRequest(parts, request));
    onDone();
  };
  const ask = () => askFor(words);
  const comment = () => {
    const [{ block, quote, at }] = parts;
    mirador().apply({ op: "comment", block, quote, at, text: words.trim() });
    onDone();
  };
  if (!asking)
    return (
      <div className="selection-box compact" style={box} role="dialog" aria-label="Selected text" onPointerDown={(event) => event.stopPropagation()}>
        <div className="row">
          <button onClick={() => setAsking(true)}>Ask the agent…</button>
          <button disabled={!oneParagraph} title={oneParagraph ? undefined : "A comment goes on text in one paragraph."} onClick={() => setAsking(true)}>
            Comment…
          </button>
        </div>
        <div className="row chips">
          {QUICK_REWRITES.map(({ label, words }) => (
            <button key={label} className="chip" disabled={sent} onClick={() => askFor(words)}>
              {label}
            </button>
          ))}
        </div>
      </div>
    );
  return (
    <div className="selection-box" style={box} role="dialog" aria-label="Selected text" onPointerDown={(event) => event.stopPropagation()}>
      <div className="quote">“{shortQuote(parts)}”</div>
      <textarea
        aria-label="What should change here?"
        placeholder={oneParagraph ? "What should change here? Or write a comment." : "What should change here?"}
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
        <button disabled={!words.trim() || !oneParagraph} onClick={comment}>
          Comment
        </button>
        <button onClick={onDone}>Cancel</button>
      </div>
      {!oneParagraph && <div className="quiet">A comment goes on text in one paragraph.</div>}
    </div>
  );
}

/** The change `by` steps from the open one, round the list; from none, the first or the last. */
function steppedTo(changes: Change[], open: string | null, by: number) {
  const at = changes.findIndex(({ id }) => id === open);
  return changes[at === -1 ? (by > 0 ? 0 : changes.length - 1) : (at + by + changes.length) % changes.length]!.id;
}

const typingInAField = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

/** Steps through the pending changes one at a time, opening each and showing its text, as a review does. */
function Stepper({ changes, open, onOpen }: { changes: Change[]; open: string | null; onOpen(id: string): void }) {
  const at = changes.findIndex(({ id }) => id === open);
  const step = (by: number) => onOpen(steppedTo(changes, open, by));
  return (
    <div className="stepper row">
      <button aria-label="Previous change" onClick={() => step(-1)}>
        ‹
      </button>
      <span className="quiet">{at === -1 ? `${changes.length} to review` : `${changes[at]!.id} · ${at + 1} of ${changes.length}`}</span>
      <button aria-label="Next change" onClick={() => step(1)}>
        ›
      </button>
    </div>
  );
}

type AuthorFilter = "all" | Change["by"];

const bothAuthors = (changes: Change[]) => changes.some(({ by }) => by === "agent") && changes.some(({ by }) => by === "you");

/** Narrows To send to the agent's changes or the user's, once it holds both. */
function AuthorFilterRow({ changes, author, onAuthor }: { changes: Change[]; author: AuthorFilter; onAuthor(author: AuthorFilter): void }) {
  if (!bothAuthors(changes)) return null;
  const theAgents = changes.filter(({ by }) => by === "agent").length;
  const options: { id: AuthorFilter; title: string; count: number }[] = [
    { id: "all", title: "All", count: changes.length },
    { id: "agent", title: "Agent", count: theAgents },
    { id: "you", title: "You", count: changes.length - theAgents },
  ];
  return (
    <div className="author-filter row" role="group" aria-label="Show changes by">
      {options.map(({ id, title, count }) => (
        <button key={id} aria-pressed={author === id} onClick={() => onAuthor(id)}>
          {title} <span className="count">{count}</span>
        </button>
      ))}
    </div>
  );
}

type SidebarTab = "changes" | "comments" | "suggestions";

interface SidebarProps {
  document: GoogleDoc & { snapshot: Snapshot };
  focused: string | null;
  open: string | null;
  onFocus(id: string | null): void;
  onOpen(id: string | null): void;
  /** On a phone, or in a narrow panel, the list folds to one bar and opens as a sheet. */
  compact: boolean;
}

function Sidebar({ document, focused, open, onFocus, onOpen, compact }: SidebarProps) {
  const { snapshot, changes } = document;
  const approved = changes.filter((change) => change.approved).length;
  const [chosenAuthor, setAuthor] = useState<AuthorFilter>("all");
  const author = bothAuthors(changes) ? chosenAuthor : "all";
  const shown = author === "all" ? changes : changes.filter(({ by }) => by === author);
  const waitingShown = shown.filter((change) => !change.approved).map(({ id }) => id);
  const approveShown = () => mirador().apply(author === "all" ? { op: "approve-all" } : { op: "approve", changes: waitingShown });
  const openThreads = snapshot.threads.filter((thread) => thread.status !== "resolved");
  const resolvedThreads = snapshot.threads.filter((thread) => thread.status === "resolved");
  const undecided = snapshot.suggestions.filter((suggestion) => !pendingDecisionOn(changes, suggestion.id));
  const [chosen, setChosen] = useState<SidebarTab | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  /** Folded, the list leaves the doc the room: its counts and Send stay. */
  const [folded, setFolded] = useState(compact);
  useEffect(() => setFolded(compact), [compact]);
  const stepping = useRef(false);
  const stepTo = (id: string) => {
    stepping.current = id !== open;
    onOpen(id);
  };
  const choose = (id: SidebarTab) => {
    setFolded(compact && tab === id && !folded);
    setChosen(id);
  };
  /** The changes the user has had To send open for; the agent's others are new to them. */
  const [seen, setSeen] = useState(() => new Set(changes.map(({ id }) => id)));
  const tabOf = (id: string): SidebarTab | null =>
    changes.some((change) => change.id === id) ? "changes" : snapshot.threads.some((thread) => thread.id === id) ? "comments" : undecided.some((suggestion) => suggestion.id === id) ? "suggestions" : null;
  useEffect(() => {
    const tab = open && tabOf(open);
    if (tab) setChosen(tab);
    if (tab && !stepping.current && !typingInAParagraph()) setFolded(false);
    stepping.current = false;
    if (open && resolvedThreads.some((thread) => thread.id === open)) setShowResolved(true);
  }, [open]);
  const tab: SidebarTab = chosen ?? (changes.length ? "changes" : openThreads.length || !undecided.length ? "comments" : "suggestions");
  useEffect(() => {
    if (tab === "changes" && changes.some(({ id }) => !seen.has(id))) setSeen(new Set([...seen, ...changes.map(({ id }) => id)]));
  }, [tab, changes]);
  const newFromTheAgent = changes.filter(({ id, by }) => by === "agent" && !seen.has(id)).length;
  const card = (id: string): CardProps => ({ focused: focused === id, open: open === id, onFocus, onOpen });
  const tabs: { id: SidebarTab; title: string; count: number }[] = [
    { id: "changes", title: "To send", count: changes.length },
    { id: "comments", title: "Comments", count: openThreads.length },
    { id: "suggestions", title: "Suggestions", count: undecided.length },
  ];
  const threadCard = (thread: Thread) => <ThreadCard key={thread.id} thread={thread} decision={pendingDecisionOn(changes, thread.id)} {...card(thread.id)} />;
  useEffect(() => {
    const review = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || typingInAField(event.target) || !shown.length) return;
      const opened = changes.find(({ id }) => id === open);
      const key = event.key.toLowerCase();
      if (key === "j" || key === "k") stepTo(steppedTo(shown, open, key === "j" ? 1 : -1));
      else if (key === "a" && opened && !opened.approved) mirador().apply({ op: "approve", change: opened.id });
      else if (key === "d" && opened) mirador().apply({ op: "drop", change: opened.id });
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", review);
    return () => window.removeEventListener("keydown", review);
  });
  const tabList = (
    <div className="tabs" role="tablist">
      {tabs.map(({ id, title, count }) => (
        <button key={id} role="tab" aria-selected={tab === id} aria-expanded={compact ? !folded : undefined} onClick={() => choose(id)}>
          {title} <span className="count">{count}</span>
          {id === "changes" && tab !== "changes" && newFromTheAgent > 0 && <span className="new">{newFromTheAgent} new</span>}
        </button>
      ))}
    </div>
  );
  const sendButton = (
    <button className="primary" disabled={approved === 0} onClick={() => mirador().run("push")}>
      Send{compact ? "" : " to Google Docs"}{approved ? ` (${approved})` : ""}
    </button>
  );
  if (folded)
    return (
      <aside className="sidebar folded">
        {tabList}
        {changes.length > 0 && sendButton}
      </aside>
    );
  return (
    <aside className="sidebar">
      {compact && <button className="handle" aria-label="Fold the list" onClick={() => setFolded(true)} />}
      {tabList}
      <div className="panel" role="tabpanel" aria-label={tabs.find(({ id }) => id === tab)!.title}>
        {tab === "changes" &&
          (changes.length === 0 ? (
            <p className="quiet">Nothing to send yet. Select text in the doc to ask for a change, or ask the agent in the chat.</p>
          ) : (
            <>
            <AuthorFilterRow changes={changes} author={author} onAuthor={setAuthor} />
            <ul>
              {shown.map((change) => (
                <ChangeCard key={change.id} change={change} direct={goesInDirectly(document, change)} {...card(change.id)} />
              ))}
            </ul>
            </>
          ))}
        {tab === "comments" && (
          <>
            {openThreads.length === 0 ? <p className="quiet">No open comments. Select text to write one.</p> : <ul>{openThreads.map(threadCard)}</ul>}
            {resolvedThreads.length > 0 && (
              <button className="link" onClick={() => setShowResolved(!showResolved)}>
                {showResolved ? "Hide resolved" : `Show resolved (${resolvedThreads.length})`}
              </button>
            )}
            {showResolved && <ul>{resolvedThreads.map(threadCard)}</ul>}
          </>
        )}
        {tab === "suggestions" &&
          (undecided.length === 0 ? (
            <p className="quiet">No suggestions waiting in the doc.</p>
          ) : (
            <ul>
              {undecided.map((suggestion) => (
                <SuggestionCard key={suggestion.id} suggestion={suggestion} {...card(suggestion.id)} />
              ))}
            </ul>
          ))}
      </div>
      {changes.length > 0 && (
        <div className="send-bar">
          {shown.length > 0 && <Stepper changes={shown} open={open} onOpen={stepTo} />}
          {!touchScreen && <p className="quiet keys">J and K step through the changes, A approves, D drops</p>}
          <div className="row">
          {waitingShown.length > 0 && <button onClick={approveShown}>{author === "all" ? "Approve all" : `Approve all ${author === "agent" ? "the agent's" : "yours"}`}</button>}
          {sendButton}
          </div>
        </div>
      )}
    </aside>
  );
}

/** What leaving the paragraph the user types in would send, or why it can't be sent. */
interface Draft {
  block: string;
  text: string;
  problem: boolean;
}

function draftOf(document: GoogleDoc, block: string, typed: string): Draft | null {
  try {
    const { body, replaces } = writtenChange(document.snapshot!, document.changes, block, typed);
    if (body) return { block, text: `Will send: ${changeSummary(body)}`, problem: false };
    return replaces.length ? { block, text: "Will take back your edits here.", problem: false } : null;
  } catch (error) {
    return { block, text: (error as Error).message, problem: true };
  }
}

/** Under the paragraph being typed in, so the user sees what they will send before they leave it. */
function DraftLine({ draft, docArea }: { draft: Draft; docArea: RefObject<HTMLDivElement | null> }) {
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const rect = docArea.current?.querySelector(`[data-block="${CSS.escape(draft.block)}"]`)?.getBoundingClientRect();
    const next = rect ? { top: rect.bottom + window.scrollY + 2, left: rect.left + window.scrollX } : null;
    setPlace((now) => (now?.top === next?.top && now?.left === next?.left ? now : next));
  });
  if (!place) return null;
  return (
    <div className={draft.problem ? "draft refused" : "draft"} style={touchScreen ? undefined : place} role="status">
      {draft.text}
    </div>
  );
}

/** The header's actions, which are seldom needed: the doc and the review get the room. */
function MoreMenu({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", closeOutside);
    return () => window.removeEventListener("pointerdown", closeOutside);
  }, [open]);
  return (
    <div className="more" ref={menu}>
      <button aria-label="More" aria-expanded={open} onClick={() => setOpen(!open)}>
        ⋮
      </button>
      {open && (
        <div className="menu" role="menu" onClick={(event) => (event.target as Element).closest("button") && setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}

/** Shift and the arrows select while typing too, and that isn't a question for the agent. */
const typingInAParagraph = () => (window.document.activeElement as HTMLElement | null)?.isContentEditable === true;

/** Approve and Drop beside the text of the change that is open, so a review can stay in the doc. */
function ChangeActions({ change, docArea }: { change: Change; docArea: RefObject<HTMLDivElement | null> }) {
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const marked = docArea.current?.querySelector(`[data-mark="${CSS.escape(change.id)}"]`);
    const rect = marked?.getBoundingClientRect();
    const next = rect ? { top: rect.bottom + window.scrollY + 4, left: Math.max(8, Math.min(rect.left + window.scrollX, window.innerWidth - 280)) } : null;
    setPlace((now) => (now?.top === next?.top && now?.left === next?.left ? now : next));
  });
  if (!place) return null;
  return (
    <div className="change-actions" style={place} role="dialog" aria-label={`Change ${change.id}`} onPointerDown={(event) => event.stopPropagation()}>
      <span className="quiet">
        {change.id} · {change.by === "you" ? "You" : "Agent"}
      </span>
      <ApprovalButtons change={change} />
    </div>
  );
}

export function App({ state }: { state: AppDocumentState<GoogleDoc> }) {
  const document = state.document;
  const [focused, setFocused] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const docArea = useRef<HTMLDivElement>(null);
  const openChange = document.changes.find(({ id }) => id === open);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [typingOn, setTypingOn] = useState(!touchScreen);
  const compact = useNarrow();
  useKeyboardHeight();
  const switchTyping = () => {
    if (typingOn) (window.document.activeElement as HTMLElement | null)?.blur();
    setTypingOn(!typingOn);
  };
  /** A paragraph being typed in isn't drawn again until the user leaves it, so what it calls back with reads the doc as it is now. */
  const latest = useRef(document);
  latest.current = document;
  const typing = (block: string, text: string | null) => setDraft(text === null ? null : draftOf(latest.current, block, text));
  const write = (block: string, text: string) => {
    const document = latest.current;
    try {
      writtenChange(document.snapshot!, document.changes, block, text);
    } catch (error) {
      setNotice((error as Error).message);
      return;
    }
    setNotice(null);
    mirador().apply({ op: "write", block, text });
  };
  const running = state.task?.state === "running";
  const readAt = document.snapshot && new Date(document.snapshot.pulledAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const actions = (
    <>
      {document.url && (
        <button disabled={running} onClick={() => mirador().run("pull")}>
          {document.snapshot ? "Read again" : "Read the doc"}
        </button>
      )}
      <button disabled={running} onClick={() => mirador().run("sign-in")}>
        Sign in a Google account
      </button>
    </>
  );
  const openShowingText = (id: string | null) => {
    setOpen(id);
    setFocused(null);
    if (id) docArea.current?.querySelector(`[data-mark="${CSS.escape(id)}"], [data-suggestions~="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  useEffect(() => {
    const noted = document.snapshot;
    if (!noted) return;
    const offerToAsk = () => {
      const found = selectionIn(noted, window.getSelection());
      if (found) setSelected(found);
    };
    let pressing = false;
    const onPointerDown = () => {
      pressing = true;
      setSelected(null);
    };
    const pressEnded = (event: PointerEvent) => {
      pressing = false;
      if (docArea.current?.contains(event.target as Node)) setTimeout(offerToAsk, 0);
    };
    // A touch screen selects by a long press, which cancels the touch, and by handles the page never hears of.
    const onSelectionChange = () => {
      if (!pressing && !typingInAParagraph()) offerToAsk();
    };
    const onTyping = (event: Event) => {
      if (docArea.current?.contains(event.target as Node)) setSelected(null);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", pressEnded);
    window.addEventListener("pointercancel", pressEnded);
    window.document.addEventListener("selectionchange", onSelectionChange);
    window.addEventListener("input", onTyping);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", pressEnded);
      window.removeEventListener("pointercancel", pressEnded);
      window.document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("input", onTyping);
    };
  }, [document.snapshot]);

  return (
    <div className="app">
      <header>
        <div className="title">
          <h2>{document.snapshot?.title ?? "Google Docs"}</h2>
          {document.snapshot && <span className="quiet">read {readAt}</span>}
        </div>
        <MoreMenu>
          {document.snapshot && <p className="quiet">Read as {document.snapshot.account}</p>}
          {actions}
          {document.snapshot && (
            <label className="switch">
              <input type="checkbox" checked={document.directEdits} onChange={(event) => mirador().apply({ op: "direct-edits", on: event.target.checked })} />
              My edits go in directly, not as suggestions
            </label>
          )}
        </MoreMenu>
      </header>
      {touchScreen && document.snapshot && (
        <button className="pencil" aria-label={typingOn ? "Done" : "Edit"} aria-pressed={typingOn} onClick={switchTyping}>
          {typingOn ? "✓" : "✎"}
        </button>
      )}
      <TaskLine state={state} />
      {notice && (
        <p className="problem">
          {notice} <button onClick={() => setNotice(null)}>OK</button>
        </p>
      )}
      {!document.url ? (
        <LinkForm />
      ) : !document.snapshot ? (
        <p className="empty">Linked to {document.url}. Read the doc to see it here.</p>
      ) : (
        <div className="body">
          <div className="doc" ref={docArea}>
            <Doc snapshot={document.snapshot} changes={document.changes} editable={typingOn} focused={focused ?? open} onFocus={setFocused} onOpen={setOpen} onWrite={write} onTyping={typing} />
          </div>
          <Sidebar document={{ ...document, snapshot: document.snapshot }} focused={focused} open={open} onFocus={setFocused} onOpen={openShowingText} compact={compact} />
        </div>
      )}
      {draft && <DraftLine draft={draft} docArea={docArea} />}
      {openChange && !selected && !draft && <ChangeActions change={openChange} docArea={docArea} />}
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
