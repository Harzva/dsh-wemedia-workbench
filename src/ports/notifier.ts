import type { DomainResult } from "../domain/errors.ts";
import type { JsonObject, JsonValue } from "../domain/json.ts";

export interface Notification extends JsonObject {
  kind: "waiting_approval" | "job_completed" | "channel_blocked";
  title: string;
  safeMessage: string;
  payload?: JsonValue;
}

export interface Notifier {
  notify(notification: Notification, signal: AbortSignal): Promise<DomainResult<void>>;
}
