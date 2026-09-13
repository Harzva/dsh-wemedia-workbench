import { failure, success } from "../domain/errors.ts";
import type { DomainResult } from "../domain/errors.ts";
import type { Notification, Notifier } from "../ports/notifier.ts";

export const noOpNotifier: Notifier = { notify: async () => success(undefined) };

/** Notifications are optional, bounded follow-ups and never business outcomes. */
export class IsolatedNotifier implements Notifier {
  private readonly timeoutMs: number;
  constructor(private readonly delegate?: Notifier, timeoutMs = 250) {
    this.timeoutMs = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(1000, timeoutMs)) : 250;
  }
  async notify(notification: Notification, signal: AbortSignal): Promise<DomainResult<void>> {
    if (signal.aborted) return failure("SCHEMA_INVALID_VALUE", "notification cancelled");
    if (!this.delegate) return noOpNotifier.notify(notification, signal);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void = () => undefined;
    const interrupted = new Promise<DomainResult<void>>(resolveInterrupted => {
      onAbort = () => { controller.abort(); resolveInterrupted(failure("SCHEMA_INVALID_VALUE", "notification cancelled")); };
      signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => { controller.abort(); resolveInterrupted(failure("SCHEMA_INVALID_VALUE", "notification timed out")); }, this.timeoutMs);
      timer.unref?.();
    });
    try {
      const delivery = Promise.resolve().then(() => controller.signal.aborted ? failure("SCHEMA_INVALID_VALUE", "notification cancelled") : this.delegate!.notify(notification, controller.signal)).then(result => result.ok ? success(undefined) : failure("SCHEMA_INVALID_VALUE", "notification could not be delivered"), () => failure("SCHEMA_INVALID_VALUE", "notification could not be delivered"));
      return await Promise.race([delivery, interrupted]);
    } catch { return failure("SCHEMA_INVALID_VALUE", "notification could not be delivered"); }
    finally { if (timer !== undefined) clearTimeout(timer); signal.removeEventListener("abort", onAbort); }
  }
}
