import React from "react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchJob } from "../../src/domain/workbench.ts";
import { WorkbenchController } from "../../src/client/controller.ts";
import { ContentNavigation } from "../../src/client/content-navigation.tsx";
import { ContentLibrarySidebar } from "../../src/client/content-library.tsx";
import { CreateArticle, WorkbenchPanel } from "../../src/client/views.tsx";

const hooks = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  dependencies: [] as Array<readonly unknown[] | undefined>,
  stateIndex: 0,
  values: new Map<number, unknown>(),
  setters: [] as ReturnType<typeof vi.fn>[],
  persist: false,
  refIndex: 0,
  refs: [] as Array<{ current: unknown }>,
}));

// Drive the components' actual lifecycle callbacks without introducing a DOM
// package. Native media/layout behavior has a separate browser acceptance pass.
vi.mock("react", async original => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void), dependencies?: readonly unknown[]) => { hooks.effects.push(effect); hooks.dependencies.push(dependencies); },
    useRef: (value: unknown) => {
      const index = hooks.refIndex++;
      return hooks.persist ? hooks.refs[index] ??= { current: value } : { current: value };
    },
    useState: (initial: unknown) => {
      const index = hooks.stateIndex++;
      const value = hooks.values.has(index) ? hooks.values.get(index) : typeof initial === "function" ? initial() : initial;
      if (hooks.persist) hooks.values.set(index, value);
      const setter = vi.fn((next: unknown) => { if (hooks.persist) hooks.values.set(index, typeof next === "function" ? next(hooks.values.get(index)) : next); });
      hooks.setters[index] = setter;
      return [value, setter];
    },
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  };
});
vi.mock("react-dom", async original => ({ ...await original<typeof import("react-dom")>(), createPortal: (children: ReactNode) => children }));

const job: WorkbenchJob = {
  jobId: "owned-job", generationId: "generation-test", contentRef: "wmc:11111111-1111-4111-8111-111111111111",
  intentId: "owned-intent", inputDigest: "sha256:input", action: "create_content", sideEffect: "local_write", status: "queued",
  progress: { current: 0 }, safeMessage: "Queued", createdAt: "2026-09-08T00:00:00Z", retryable: false, artifactRefs: [],
};
const mounted: Array<() => void> = [];
const mountEffects = (): void => { for (const effect of hooks.effects.splice(0)) { const cleanup = effect(); if (cleanup) mounted.push(cleanup); } };
const unmount = (): void => { for (const cleanup of mounted.splice(0).reverse()) cleanup(); };
const resetRender = (): void => { hooks.effects = []; hooks.dependencies = []; hooks.stateIndex = 0; hooks.values.clear(); hooks.setters = []; hooks.persist = false; hooks.refIndex = 0; hooks.refs = []; };
const settle = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

function findElement(node: ReactNode, predicate: (element: ReactElement<Record<string, unknown>>) => boolean): ReactElement<Record<string, unknown>> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) { const result = findElement(child, predicate); if (result) return result; }
    return;
  }
  if (!React.isValidElement<Record<string, unknown>>(node)) return;
  if (predicate(node)) return node;
  return findElement(node.props.children as ReactNode, predicate);
}

beforeEach(() => {
  resetRender(); vi.useFakeTimers();
  vi.stubGlobal("document", { activeElement: null });
  vi.stubGlobal("HTMLElement", class {});
});
afterEach(() => { unmount(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("content composition ownership", () => {
  it.each([true, false])("unmounting a panel (embedded=%s) does not close its replacement", embedded => {
    const controller = new WorkbenchController(() => undefined); controller.open();
    const close = vi.spyOn(controller, "close");
    WorkbenchPanel({ controller, embedded }); mountEffects();
    unmount();
    expect(close).not.toHaveBeenCalled();
    expect(controller.getSnapshot().open).toBe(true);
    controller.dispose();
  });

  it("only the navigation owner closes on final unload, including degraded fallback", () => {
    const controller = new WorkbenchController(() => undefined); controller.open();
    const close = vi.spyOn(controller, "close");
    hooks.values.set(2, true); // The same owner also renders the degraded fallback.
    ContentNavigation({ controller }); mountEffects();
    expect(close).not.toHaveBeenCalled();
    unmount();
    expect(close).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().open).toBe(false);
  });

  it("keeps an open creation dialog when another session contributes a creation job", () => {
    const controller = new WorkbenchController(() => undefined); controller.open();
    const state = { ...controller.getSnapshot(), snapshot: {
      schemaVersion: "wemedia.workbench/v1" as const, generationId: "generation-test", revision: 1,
      settings: { roots: [], hasWriteRoot: true, hasDataDir: true, approvalAvailable: true, issues: [] },
      capabilities: [], jobs: [{ ...job, jobId: "foreign-job", intentId: "foreign-intent" }], supportedChannels: ["wechat" as const],
    } };
    vi.spyOn(controller, "getSnapshot").mockReturnValue(state);
    const navigate = vi.spyOn(controller, "navigate");
    hooks.values.set(4, true); // Creation dialog already open before this snapshot.
    ContentNavigation({ controller }); mountEffects();
    expect(hooks.setters[4]).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("creation submission acknowledgement", () => {
  function dialog(result: Promise<WorkbenchJob | null>) {
    const controller = new WorkbenchController(() => undefined);
    vi.spyOn(controller, "confirmCreation").mockReturnValue(result);
    const onCreated = vi.fn();
    const state = { ...controller.getSnapshot(), creation: {
      input: { title: "Owned draft", sourceUrl: "", kind: "article" as const },
      preview: { intent: {
        intentId: "owned-intent", generationId: "generation-test", contentRef: job.contentRef, action: "create_content",
        sideEffect: "local_write" as const, targetSummary: "Owned draft", inputDigest: "sha256:input", expectedChanges: [],
        blockingGateCodes: [], expiresAt: "2099-01-01T00:00:00Z", approved: false,
      }, summary: [] },
    } };
    const tree = CreateArticle({ controller, state, open: true, onClose: vi.fn(), onCreated });
    mountEffects();
    const confirm = findElement(tree, element => element.props.children === "确认创建本地文章")!;
    return { onCreated, click: confirm.props.onClick as () => void };
  }

  it("reports only the exact successfully acknowledged submission", async () => {
    const { click, onCreated } = dialog(Promise.resolve(job));
    click(); await settle();
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(job);
  });

  it("keeps the dialog open when the controller handled a failed or skipped submission", async () => {
    const { click, onCreated } = dialog(Promise.resolve(null));
    click(); await settle();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("does not navigate a replacement view after the submitting dialog unmounted", async () => {
    let finish!: (job: WorkbenchJob) => void;
    const pending = new Promise<WorkbenchJob>(resolve => { finish = resolve; });
    const { click, onCreated } = dialog(pending);
    click(); unmount(); finish(job); await settle();
    expect(onCreated).not.toHaveBeenCalled();
  });
});

describe("mobile creation focus ownership", () => {
  function navigation(narrow = true) {
    hooks.persist = true;
    vi.stubGlobal("window", { matchMedia: () => ({ matches: narrow }) });
    const controller = new WorkbenchController(() => undefined); controller.open();
    const originalSnapshot = controller.getSnapshot;
    vi.spyOn(controller, "getSnapshot").mockImplementation(() => ({ ...originalSnapshot(), snapshot: {
      schemaVersion: "wemedia.workbench/v1", generationId: "generation-test", revision: 1,
      settings: { roots: [], hasWriteRoot: true, hasDataDir: true, approvalAvailable: true, issues: [] },
      capabilities: [], jobs: [], supportedChannels: ["wechat"],
    } }));
    const surface = { setLibraryOpen: vi.fn() };
    hooks.values.set(1, surface);
    const toolbar = { focus: vi.fn(() => { Object.assign(document, { activeElement: toolbar }); }) };
    const back = { focus: vi.fn(() => { Object.assign(document, { activeElement: back }); }) };
    const render = () => {
      hooks.effects = []; hooks.dependencies = []; hooks.stateIndex = 0; hooks.refIndex = 0;
      const tree = ContentNavigation({ controller });
      const bind = (className: string, button: typeof toolbar) => {
        const element = findElement(tree, element => element.props.className === className);
        expect(element, `Rendered focus owner ${className}`).toBeDefined();
        const ref = (element as unknown as { ref: { current: unknown } }).ref;
        ref.current = { querySelector: () => button };
      };
      bind("wm-content-library-trigger", toolbar); bind("wm-content-mobile-library", back);
      // Pick the actual surface/mobile-focus effect, not the first hook: the
      // independent content-picker Modal also owns a focus effect and refs.
      const index = hooks.dependencies.findIndex(deps => deps?.length === 4 && deps[0] === surface);
      expect(index).toBeGreaterThanOrEqual(0);
      const focus = hooks.effects[index]!;
      return { tree, focus };
    };
    const create = (tree: ReactNode) => {
      const sidebar = findElement(tree, element => element.type === ContentLibrarySidebar)!;
      (sidebar.props.onCreateArticle as () => void)();
    };
    if (narrow) {
      // Enter the mobile library through its real control rather than relying
      // on the numeric useState position, which changes as dialogs are added.
      const initial = render();
      const browse = findElement(initial.tree, element => element.props.children === "选择内容")!;
      (browse.props.onClick as () => void)(); render().focus();
      expect(surface.setLibraryOpen).toHaveBeenLastCalledWith(true);
      toolbar.focus.mockClear(); back.focus.mockClear();
    }
    return { controller, surface, toolbar, back, render, create };
  }

  it.each(["onClose", "onCreated"] as const)("keeps creation focus inside the dialog and restores visible focus after %s", completion => {
    const nav = navigation();
    let view = nav.render(); view.focus(); nav.create(view.tree);
    view = nav.render();
    const dialog = findElement(view.tree, element => element.type === CreateArticle)!;
    expect(dialog.props.open).toBe(true);
    // The child dialog focuses its input before the parent's passive effect.
    const dialogInput = {} as Element;
    Object.assign(document, { activeElement: dialogInput });
    view.focus();
    expect(document.activeElement).toBe(dialogInput);
    expect(nav.toolbar.focus).not.toHaveBeenCalled();
    expect(nav.surface.setLibraryOpen).toHaveBeenLastCalledWith(false);

    (dialog.props[completion] as () => void)();
    view = nav.render();
    expect(findElement(view.tree, element => element.type === CreateArticle)!.props.open).toBe(false);
    // Closing a modal can restore its original trigger in the hidden library.
    // The composition must then choose the visible toolbar instead.
    Object.assign(document, { activeElement: null });
    view.focus();
    expect(document.activeElement).toBe(nav.toolbar);
    expect(nav.toolbar.focus).toHaveBeenCalledTimes(1);
    expect(nav.back.focus).not.toHaveBeenCalled();
    if (completion === "onCreated") expect(nav.controller.getSnapshot().view).toBe("jobs");
    nav.controller.dispose();
  });

  it("consumes the skipped library focus without replaying it when the dialog disappears", () => {
    const nav = navigation();
    let view = nav.render(); nav.create(view.tree);
    view = nav.render(); view.focus();
    hooks.values.set(4, false); // Parent teardown/closure without a focus request.
    nav.render().focus();
    expect(nav.toolbar.focus).not.toHaveBeenCalled();
    nav.controller.dispose();
  });

  it.each(["desktop", "closed workbench"])("does not focus a hidden toolbar after creation in %s", mode => {
    const nav = navigation(mode !== "desktop");
    let view = nav.render(); nav.create(view.tree);
    view = nav.render(); view.focus();
    const dialog = findElement(view.tree, element => element.type === CreateArticle)!;
    (dialog.props.onClose as () => void)();
    if (mode === "closed workbench") nav.controller.close();
    nav.render().focus();
    expect(nav.toolbar.focus).not.toHaveBeenCalled();
    nav.controller.dispose();
  });
});
