import { z } from "zod";
import { decodeWorkbenchRequest } from "../domain/workbenchRequest.ts";
import { isJsonObject, isJsonValue } from "../domain/json.ts";
import type { WorkbenchAnswer } from "../domain/workbench.ts";

// The same semantic decoder is used at RPC and Tool boundaries. Zod carries
// the strict Typert codec, while business errors remain canonical values.
export const requestSchema = z.json().transform((value, context) => {
  try { return decodeWorkbenchRequest(value); }
  catch { context.addIssue({ code: "custom", message: "Invalid workbench request" }); return z.NEVER; }
});
export const answerSchema = z.json().transform((value, context): WorkbenchAnswer => {
  if (isJsonObject(value) && value.ok === true && isJsonObject(value.value) && isJsonValue(value.value) && Number.isSafeInteger(value.revision)) return { ok: true, value: value.value, revision: Number(value.revision) };
  if (isJsonObject(value) && value.ok === false && isJsonObject(value.error) && typeof value.error.code === "string" && typeof value.error.safeMessage === "string" && typeof value.error.retryable === "boolean") return { ok: false, error: { code: value.error.code, safeMessage: value.error.safeMessage, retryable: value.error.retryable } };
  context.addIssue({ code: "custom", message: "Invalid workbench answer" }); return z.NEVER;
});
export const taskRequestSchema = z.object({ intentId: z.string().min(1).max(200) }).strict();
export const taskAnswerSchema = z.object({ ok: z.boolean(), prompt: z.string().max(8000), code: z.string().max(100) }).strict();
