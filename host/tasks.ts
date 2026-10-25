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
    let { snapshot: fresh, token } = await read(document, signal);
    const firstPlan = planPush(document, fresh);
    let plan = firstPlan;
    const problems = { ...plan.problems };
    const sent: string[] = [];
    let failure: string | null = null;
    /** Sends one batch; once something went, a failure stops the rest but the task still records what went. */
    const send = async (what: string, body: { requests: unknown[]; writeControl?: unknown }, changes: string[]) => {
      if (!body.requests.length || failure) return;
      progress(null, what);
      try {
        await batchUpdate(token, document.documentId!, body, signal);
        sent.push(...changes);
      } catch (error) {
        if (!sent.length) throw error;
        failure = (error as Error).message;
      }
    };
    await send("Sending comments", { requests: plan.commentRequests }, plan.commentChanges);
    if (plan.directRequests.length) {
      await send("Sending your edits", { requests: plan.directRequests, writeControl: { targetRevisionId: fresh.revisionId } }, plan.directChanges);
      if (!failure) {
        progress(null, "Reading the doc again");
        try {
          ({ snapshot: fresh } = await read(document, signal));
          plan = planPush({ ...document, changes: document.changes.filter(({ id }) => !sent.includes(id) && !problems[id]) }, fresh);
          Object.assign(problems, plan.problems);
        } catch (error) {
          failure = (error as Error).message;
        }
      }
    }
    const direct = sent.filter((id) => firstPlan.directChanges.includes(id));
    await send("Sending suggestions", { requests: plan.suggestionRequests, writeControl: { writeMode: "SUGGEST", targetRevisionId: fresh.revisionId } }, plan.suggestionChanges);
    await send("Accepting and rejecting suggestions", { requests: plan.decisionRequests }, plan.decisionChanges);
    await apply({ op: "sent", changes: sent, problems });
    progress(null, "Reading the doc again");
    const unread = await read({ ...document, snapshot: fresh }, signal).then(
      ({ snapshot }) => apply({ op: "pulled", snapshot }).then(() => null),
      (error: Error) => `Reading it again failed (${error.message}): read it again before sending more.`,
    );
    const kept = Object.keys(problems);
    const suggested = sent.filter((id) => plan.suggestionChanges.includes(id));
    return [
      `Sent ${sent.length ? sent.join(", ") : "nothing"}${direct.length ? `; ${direct.join(", ")} ${direct.length === 1 ? "is" : "are"} in the doc` : ""}${suggested.length ? `; ${direct.length ? `${suggested.join(", ")} ${suggested.length === 1 ? "is a suggestion" : "are suggestions"}` : "the edits are suggestions in the doc now"}` : ""}.`,
      failure && `The rest wasn't sent: ${failure.replace(/\.?$/, ".")}`,
      kept.length ? `${kept.join(", ")} stayed pending: ${kept.map((id) => `${id}: ${problems[id]}`).join(" ")}` : null,
      unread,
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
