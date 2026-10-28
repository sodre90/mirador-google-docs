# Google Docs for Mirador

A Mirador app plugin (plugin API 4) for editing Google Docs with the agent. The doc shows in a canvas tab as a doc. The agent proposes changes there, you approve each one, and only you send them to Google Docs, where they arrive as suggestions.

## What it does

- **The agent opens a doc:** it writes a link file such as `notes/launch-plan.gdoc` (or applies `{ "op": "link", "url": "…" }`), opens the app on it and runs the task `pull`. `app_state` gives the doc as text: paragraphs with ids such as `p12`, headings, bulleted and numbered lists, the bold, italic, underlined, struck-through and linked text of each paragraph, tables (read only), the suggestions in the doc and the comment threads.
- **The agent proposes changes** anchored by a quote of the paragraph's text: `replace`, `insert`, `delete`, a new `comment`, a `reply` to a thread or a suggestion, `resolve`, `accept` or `reject` a suggestion. They show in the doc, struck through and in green, and wait under **To send** beside it.
- **The agent changes styles** too: `format` makes a quote bold, italic, underlined or struck through, or not, and adds or takes off a link; `paragraph` makes a paragraph a heading, title, subtitle or normal text, and a bulleted or numbered list item, or none. The doc shows them as made, with a purple dotted underline or a purple bar beside the paragraph. A nested list item can't change its kind yet. Collaborators' own suggestions of style show with the same marks and have cards under Suggestions.
- **You type in the doc** as in Docs. When you leave a paragraph, what you typed there becomes one change, in place of your earlier edits in that paragraph; your own edits show as already made, in blue. Enter starts a new paragraph. Typing on an empty line writes there. Typing isn't possible in a paragraph with open suggestions (accept or reject them first), over an image or chip, over text the agent has a pending change on, or over text with a pending change of style. A line under the paragraph says what leaving it will send, or why it can't be sent.
- **One change per stretch of text:** a text edit or a format touching text another pending one changes is refused when it's made, for the agent and for you, so Send never has two suggestions on the same words. A paragraph takes one pending change of its style or list.
- **You select text**, across paragraphs too, and either ask the agent to change it (it hears the quotes, where they are and your words) or comment on it (within one paragraph).
- **The sidebar** has tabs for To send, Comments and Suggestions, with one-line cards that open on click and scroll the doc to their text; clicking marked text in the doc opens its card. The stepper under the list opens each pending change in turn, with Approve and Drop beside its text in the doc. On the desktop, J and K step through the changes, A approves the open one and D drops it; the keys do nothing while you type. In a narrow canvas panel the sidebar is one slim bar with the counts and Send; a count opens its list as a sheet, and its handle folds it again.
- **The ⋮ menu** holds Read again, Sign in a Google account, the account the doc was read as, and the **My edits go in directly** switch.
- **You approve** each change, or all of them, and press **Send to Google Docs**. The plugin reads the doc again and finds each quote anew, so collaborators' edits in the meantime don't matter. It sends comments and replies first, then the edits in one batch as suggestions (`writeMode: SUGGEST`, `targetRevisionId`): the changes of style, then the text edits from the end of the doc back. Paragraphs next to each other that become the same kind of list go as one list. Accepting and rejecting suggestions go last. With **My edits go in directly** on, your own edits are sent first as ordinary edits; the plugin then reads the doc again and places the agent's as suggestions. A change whose text it can't find any more stays pending, with a note.
- **On a phone or a tablet**, as in Mirador's phone app, the doc reads edge to edge. The pencil button turns on typing, and ✓ turns it off. Select text by a long press to ask the agent or comment: the box sits along the bottom, clear of the keyboard and the selection handles, as does the line saying what typing will send. The sidebar is the slim bar; tap a count, or marked text, to open its list as a sheet. Tried on Android; not yet on an iPhone.

**The `.gdoc` file holds the doc's whole text**, its comments and the account that read it, next to your other files. In a workspace under git, add `*.gdoc` to its `.gitignore` before opening a work doc, so it can't be committed by accident.

The agent can't approve or send: `apply` refuses `approve` from anyone but you (plugin API 4 tells a plugin who made a change), and the `push` task refuses to run for the agent.

## Signing in

**Sign in a Google account** runs `gcloud auth login --enable-gdrive-access` with its own config folder, `~/.mirador/google-docs/gcloud`, apart from your own gcloud sign-in. It needs the Google Cloud CLI, and no OAuth client of your own. Sign in as many accounts as you like: a pull tries each until one can open the doc. Suggestions and comments show in Docs as the signed-in account's.

## Developing

```bash
bun install
bun run typecheck
bun run test          # unit tests, with a fake gcloud and a fake Docs API
scripts/e2e.sh        # in a Mirador test host, from the Mirador checkout in MIRADOR_DIR (default ../visualized-claude-sessions)
bun run build         # dist/view.js, which Mirador serves
```

`GOOGLE_DOCS_API_URL`, `GOOGLE_DOCS_GCLOUD` and `GOOGLE_DOCS_GCLOUD_CONFIG` point the host code at another Docs API, gcloud program or gcloud config folder.
