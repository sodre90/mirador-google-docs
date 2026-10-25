import type { AppTask, AppTaskContext } from "../mirador/api.ts";
import { snapshotOf } from "../shared/convert.ts";
import type { GoogleDoc, Snapshot } from "../shared/document.ts";
import { countOf } from "../shared/operations.ts";
import { planPush } from "../shared/push.ts";
import { batchUpdate, getDocument, GoogleError, signedInAccounts, signIn, SignInNeeded, tokenFor } from "./google.ts";

const NOBODY_SIGNED_IN = "No Google account is signed in yet: the user signs one in with Sign in a Google account in the view.";

/** Reads the doc with the account that read it last, or else with each signed-in account until one may. */
async function read(document: GoogleDoc, signal: AbortSignal): Promise<{ snapshot: Snapshot; token: string }> {
  if (!document.documentId) throw new Error('No doc is linked yet: apply { "op": "link", "url": "<the doc\'s address>" } first.');
  const accounts = await signedInAccounts();
  if (!accounts.length) throw new SignInNeeded(NOBODY_SIGNED_IN);
  const last = document.snapshot?.account;
  const ordered = last && accounts.includes(last) ? [last, ...accounts.filter((account) => account !== last)] : accounts;
  const refusals: string[] = [];
  for (const account of ordered) {
    let token;
    try {
      token = await tokenFor(account);
    } catch (error) {
      refusals.push((error as Error).message);
      continue;
    }
    try {
      return { snapshot: snapshotOf(await getDocument(token, document.documentId, signal), account, Date.now()), token };
    } catch (error) {
      if (!(error instanceof GoogleError) || ![401, 403, 404].includes(error.status)) throw error;
      refusals.push(`${account} can't open it (${error.status}).`);
    }
  }
  throw new Error(`None of the signed-in accounts could read ${document.url}: ${refusals.join(" ")} Sign in an account that can open the doc.`);
}

export const pull: AppTask<GoogleDoc> = {
  title: "Read the doc from Google Docs",
  async run({ document, apply, progress, signal }: AppTaskContext<GoogleDoc>) {
    progress(null, "Reading the doc");
    const { snapshot } = await read(document, signal);
    await apply({ op: "pulled", snapshot });
    const blocks = snapshot.tabs.reduce((sum, tab) => sum + tab.blocks.length, 0);
    return `Read “${snapshot.title}” as ${snapshot.account}: ${countOf(blocks, "block")}, ${countOf(snapshot.threads.length, "comment thread")}, ${countOf(snapshot.suggestions.length, "open suggestion")}.`;
  },
};

export const push: AppTask<GoogleDoc> = {
  title: "Send the approved changes to Google Docs",
  async run({ document, author, apply, progress, signal }: AppTaskContext<GoogleDoc>) {
    if (author.kind !== "you") throw new Error("Only the user sends changes to Google Docs, with Send in the view. Ask them to look at the pending changes.");
    if (!document.changes.some(({ approved }) => approved)) throw new Error("Nothing is approved yet: approve the changes to send first.");
    progress(null, "Reading the doc again");
    const { snapshot: fresh, token } = await read(document, signal);
    const plan = planPush(document, fresh);
    const sent: string[] = [];
    let failure: string | null = null;
    if (plan.commentRequests.length) {
      progress(null, "Sending comments");
      await batchUpdate(token, document.documentId!, { requests: plan.commentRequests }, signal);
      sent.push(...plan.commentChanges);
    }
    if (plan.suggestionRequests.length) {
      progress(null, "Sending suggestions");
      try {
        await batchUpdate(token, document.documentId!, { requests: plan.suggestionRequests, writeControl: { writeMode: "SUGGEST", targetRevisionId: fresh.revisionId } }, signal);
        sent.push(...plan.suggestionChanges);
      } catch (error) {
        if (!sent.length) throw error;
        failure = (error as Error).message;
      }
    }
    await apply({ op: "sent", changes: sent, problems: plan.problems });
    progress(null, "Reading the doc again");
    await apply({ op: "pulled", snapshot: (await read({ ...document, snapshot: fresh }, signal)).snapshot });
    const kept = Object.keys(plan.problems);
    return [
      `Sent ${sent.length ? sent.join(", ") : "nothing"}${plan.suggestionChanges.length && !failure ? "; the edits are suggestions in the doc now" : ""}.`,
      failure && `The edits weren't sent: ${failure}`,
      kept.length ? `${kept.join(", ")} stayed pending: ${kept.map((id) => `${id}: ${plan.problems[id]}`).join(" ")}` : null,
    ]
      .filter(Boolean)
      .join(" ");
  },
};

export const signInTask: AppTask<GoogleDoc> = {
  title: "Sign in a Google account",
  async run({ progress, signal }: AppTaskContext<GoogleDoc>) {
    progress(null, "Waiting for the sign-in in the browser");
    await signIn(signal);
    return `Signed in: ${(await signedInAccounts()).join(", ")}.`;
  },
};
