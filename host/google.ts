import { homedir } from "node:os";
import { join } from "node:path";
import { PULL_QUERY, type GoogleDocument } from "../shared/convert.ts";

/**
 * Google sign-in goes through gcloud's own client, which Google lets reach Drive with --enable-gdrive-access, so no
 * OAuth client of our own is needed. It keeps its accounts in a config folder of this plugin's, apart from the owner's
 * own gcloud sign-in.
 */
const gcloudProgram = () => process.env.GOOGLE_DOCS_GCLOUD ?? "gcloud";
export const gcloudConfig = () => process.env.GOOGLE_DOCS_GCLOUD_CONFIG ?? join(homedir(), ".mirador", "google-docs", "gcloud");
const docsApi = () => process.env.GOOGLE_DOCS_API_URL ?? "https://docs.googleapis.com";

export class SignInNeeded extends Error {}

async function gcloud(args: string[], signal?: AbortSignal) {
  let child;
  try {
    child = Bun.spawn([gcloudProgram(), ...args], {
      env: { ...process.env, CLOUDSDK_CONFIG: gcloudConfig(), CLOUDSDK_CORE_DISABLE_PROMPTS: "1" },
      stdout: "pipe",
      stderr: "pipe",
      signal,
    });
  } catch {
    throw new SignInNeeded("gcloud, which this app signs in to Google with, isn't installed or isn't on the PATH: install the Google Cloud CLI.");
  }
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
}

/** gcloud's message, without the lines that only tell a terminal user what to type. */
const reasonOf = (stderr: string) =>
  stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^(To |\$ |gcloud )/.test(line))
    .slice(0, 2)
    .join(" ");

export async function signedInAccounts(): Promise<string[]> {
  const { code, stdout, stderr } = await gcloud(["auth", "list", "--format=value(account)"]);
  if (code !== 0) throw new Error(`gcloud couldn't list the signed-in accounts: ${reasonOf(stderr)}`);
  return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

export async function tokenFor(account: string): Promise<string> {
  const { code, stdout, stderr } = await gcloud(["auth", "print-access-token", account]);
  if (code !== 0) throw new SignInNeeded(`${account}'s Google sign-in has ended or needs confirming (${reasonOf(stderr) || `gcloud exited with ${code}`}). Sign it in again with Sign in a Google account.`);
  return stdout.trim();
}

/** Opens the browser on Google's sign-in, where the owner picks an account; gcloud waits for it on a local port. */
export async function signIn(signal: AbortSignal): Promise<void> {
  const { code, stderr } = await gcloud(["auth", "login", "--enable-gdrive-access", "--no-activate", "--force", "--brief"], signal);
  if (signal.aborted) throw new Error("Stopped before the sign-in ended.");
  if (code !== 0) throw new Error(`The sign-in didn't finish: ${reasonOf(stderr) || `gcloud exited with ${code}`}`);
}

export class GoogleError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<Reply>(token: string, path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<Reply> {
  const response = await fetch(`${docsApi()}${path}`, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${token}`, ...(init.body !== undefined && { "Content-Type": "application/json" }) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
  });
  const reply = (await response.json().catch(() => ({}))) as Reply & { error?: { message?: string } };
  if (!response.ok) throw new GoogleError(response.status, `Google Docs said ${response.status}: ${reply.error?.message ?? response.statusText}`);
  return reply;
}

export const getDocument = (token: string, documentId: string, signal?: AbortSignal) => call<GoogleDocument>(token, `/v1/documents/${encodeURIComponent(documentId)}?${PULL_QUERY}`, { signal });

export const batchUpdate = (token: string, documentId: string, body: { requests: unknown[]; writeControl?: unknown }, signal?: AbortSignal) =>
  call<{ writeControl?: { requiredRevisionId?: string } }>(token, `/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`, { method: "POST", body, signal });
