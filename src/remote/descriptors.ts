import type { InvocationDescriptor, RemoteResult, TypertRemoteContribution } from "@deepseek-ai/dsh-typert-protocol";
import type { WorkbenchAnswer, WorkbenchRequest } from "../domain/workbench.ts";
import { requestSchema, answerSchema, taskRequestSchema, taskAnswerSchema } from "./schemas.ts";
export const PACKAGE_NAME = "dsh-wemedia-workbench";
function invocation(method: string, request: { parse(value: unknown): unknown }, result: { parse(value: unknown): unknown }): InvocationDescriptor {
  return { id: `${PACKAGE_NAME}#wemedia/${method}`, service: "wemedia", namespace: "wemedia", method, invocation: { kind: "direct" }, parameters: [{ name: "request", wire: "request", source: "json", codec: { mode: "strict", typeSymbol: `${PACKAGE_NAME}#${method}:request`, schema: request } }], cancellation: { parameter: "signal" }, result: { mode: "strict", typeSymbol: `${PACKAGE_NAME}#${method}:result`, schema: result } };
}
export const INVOCATIONS = [invocation("request", requestSchema, answerSchema), invocation("intentTask", taskRequestSchema, taskAnswerSchema)];
export const TYPERT_REMOTE: TypertRemoteContribution = { package: PACKAGE_NAME, descriptors: INVOCATIONS };
export default TYPERT_REMOTE;
export interface WemediaRemote {
  request(request: WorkbenchRequest, signal?: AbortSignal): Promise<RemoteResult<WorkbenchAnswer>>;
  intentTask(request: { intentId: string }, signal?: AbortSignal): Promise<RemoteResult<{ ok: boolean; prompt: string; code: string }>>;
}
declare module "@deepseek-ai/dsh-typert-protocol" {
  interface TypertRemoteNamespaceMap { wemedia: WemediaRemote }
}
