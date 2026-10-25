import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** What the fake Docs API was sent: each batchUpdate's body, and which token came with each call. */
export interface FakeGoogle {
  url: string;
  batches: { requests: unknown[]; writeControl?: unknown }[];
  tokens: string[];
  /** The doc each account may read, by account; others get 403. */
  readers: Set<string>;
  document: unknown;
  stop(): void;
}

/** A Docs API that serves one doc to the accounts in `readers`, telling them apart by the fake token gcloud gives each. */
export function fakeGoogle(document: unknown, readers: string[]): FakeGoogle {
  const fake: FakeGoogle = { url: "", batches: [], tokens: [], readers: new Set(readers), document, stop: () => server.stop(true) };
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      fake.tokens.push(token);
      const account = token.replace(/^token-for-/, "");
      if (!fake.readers.has(account)) return Response.json({ error: { message: "The caller does not have permission" } }, { status: 403 });
      const { pathname } = new URL(request.url);
      if (request.method === "GET" && pathname.startsWith("/v1/documents/")) return Response.json(fake.document);
      if (request.method === "POST" && pathname.endsWith(":batchUpdate")) {
        fake.batches.push(await request.json());
        return Response.json({ replies: [], writeControl: { requiredRevisionId: "rev-2" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  fake.url = `http://127.0.0.1:${server.port}`;
  return fake;
}

/**
 * A gcloud that knows the accounts listed in `<folder>/accounts`, one a line, and gives each the token
 * token-for-<account>; an account listed in `<folder>/expired` gets the error gcloud gives when a session ended.
 * `auth login` adds the account in `<folder>/next-sign-in`.
 */
export function fakeGcloud(accounts: string[]) {
  const folder = mkdtempSync(join(tmpdir(), "fake-gcloud-"));
  writeFileSync(join(folder, "accounts"), accounts.map((account) => `${account}\n`).join(""));
  writeFileSync(join(folder, "expired"), "");
  const program = join(folder, "gcloud");
  writeFileSync(
    program,
    `#!/bin/sh
dir='${folder}'
case "$1 $2" in
  "auth list") cat "$dir/accounts" ;;
  "auth print-access-token")
    if grep -qx "$3" "$dir/expired"; then echo "ERROR: (gcloud.auth.print-access-token) Reauthentication failed. cannot prompt during non-interactive execution." >&2; exit 1; fi
    if ! grep -qx "$3" "$dir/accounts"; then echo "ERROR: no credentials for $3" >&2; exit 1; fi
    echo "token-for-$3" ;;
  "auth login") cat "$dir/next-sign-in" >> "$dir/accounts" ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac
`,
  );
  chmodSync(program, 0o755);
  return { folder, program };
}
