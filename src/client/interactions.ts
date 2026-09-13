import { useEffect } from "react";
import type { RefObject } from "react";
import { terminalJob, type ClientState, type WorkbenchController } from "./controller.ts";

/** Queries only the owned dialog. DSH's Modal owns its portal, mask and Escape. */
export function useDialogFocus(ref: RefObject<HTMLElement>, open: boolean, trigger?: RefObject<HTMLElement>): void {
  useEffect(() => {
    const element = ref.current;
    if (!open || !element) return;
    // A disabled asynchronous trigger can lose focus before its dialog opens.
    const previous = document.activeElement === document.body ? trigger?.current ?? document.activeElement : document.activeElement;
    const dialog = element.closest<HTMLElement>('[role="dialog"]') ?? element;
    const focusable = (): HTMLElement[] => [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]')].filter(node => node.getClientRects().length > 0);
    (element.querySelector<HTMLElement>('[data-initial-focus="true"]') ?? focusable()[0] ?? element).focus();
    const keydown = (event: KeyboardEvent): void => {
      if (event.key !== "Tab") return;
      const nodes = focusable();
      const first = nodes[0]; const last = nodes.at(-1);
      if (!first || !last) { event.preventDefault(); element.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    dialog.addEventListener("keydown", keydown);
    return () => { dialog.removeEventListener("keydown", keydown); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [open, ref, trigger]);
}

export interface JobStatusVisibility {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/** Finite, view-owned read loop; cleanup stops observation, not Host execution. */
export function startJobStatusTracking(refreshStatus: () => Promise<void>, visibility: JobStatusVisibility = document): () => void {
  let stopped = false; let running = false; let polls = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clearTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const schedule = (): void => {
    if (!stopped && !running && !visibility.hidden && polls < 200 && timer === undefined) {
      timer = setTimeout(() => { timer = undefined; void tick(); }, 1500);
    }
  };
  const tick = async (): Promise<void> => {
    if (stopped || running || visibility.hidden) return;
    running = true; polls += 1;
    try { await refreshStatus(); }
    catch { /* The controller owns error presentation; contain unexpected read rejections. */ }
    finally { running = false; schedule(); }
  };
  const onVisibility = (): void => { clearTimer(); schedule(); };
  visibility.addEventListener("visibilitychange", onVisibility);
  schedule();
  return () => {
    if (stopped) return;
    stopped = true;
    clearTimer();
    visibility.removeEventListener("visibilitychange", onVisibility);
  };
}

/** Never retries a write or changes Host execution. */
export function useJobStatusTracking(controller: WorkbenchController, state: ClientState): void {
  const active = state.snapshot?.jobs.some(job => !terminalJob(job)) ?? false;
  useEffect(() => {
    if (!state.open || !state.connected || !active) return;
    return startJobStatusTracking(() => controller.refreshStatus());
  }, [controller, state.open, state.connected, active]);
}
