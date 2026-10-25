# Google Docs for Mirador

A Mirador app plugin (plugin API 4) for editing Google Docs with the agent. See README.md for what it does and how to run it.

- Bun and TypeScript everywhere, strict; imports carry their `.ts`/`.tsx` extensions. React 19 for the view.
- `bun run typecheck`, `bun run test` and `scripts/e2e.sh` before every commit. The e2e runs in a Mirador test host from
  the Mirador checkout in `MIRADOR_DIR`, with Mirador's Playwright, which runs on Node: no Bun APIs in `e2e/`.
- `shared/` is pure: the document, operations, anchors, the push plan and `describe`. `host/` talks to gcloud and the
  Docs API; `mirador/host.ts` only wires them up.
- Nothing reaches the doc without the user: only they approve (`apply` gets the author) and only they run `push`.
- Never print or log an access token.
- Names over comments: keep comments for a genuine "why" that a name can't carry.
- Every change comes with tests: logic gets unit tests, and what the user sees gets e2e coverage.
- Words the user or the agent reads: plain words and sentence case.
- Commits: authored by the owner only, `perdos <erdos.peter.bme@gmail.com>`, with no AI attribution or trailers. One
  plain sentence saying what the user gets.
- The view runs in Mirador's sandboxed canvas frame: no network, no forms (a `<form>` never submits there), no
  localStorage but `window.mirador.storage`.
