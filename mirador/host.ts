import { pull, push, signInTask } from "../host/tasks.ts";
import { describeDocument } from "../shared/describe.ts";
import { newDocument, type GoogleDoc } from "../shared/document.ts";
import { applyOperation, parseDocument } from "../shared/operations.ts";
import type { AppHost } from "./api.ts";

const host: AppHost<GoogleDoc> = {
  parse: parseDocument,
  serialize: (document) => `${JSON.stringify(document, null, 2)}\n`,
  apply: applyOperation,
  describe: describeDocument,
  create: newDocument,
  tasks: { pull, push, "sign-in": signInTask },
};

export default host;
