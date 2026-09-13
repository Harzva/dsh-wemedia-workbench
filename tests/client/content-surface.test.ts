import { beforeEach, describe, expect, it, vi } from "vitest";
import { attachContentSurface } from "../../src/client/content-surface.ts";

/** Minimal DOM fixture: exercises ownership/lifecycle without adding a browser dependency. */
class TestElement {
  children: TestElement[] = [];
  parentElement: TestElement | null = null;
  attributes = new Map<string, string>();
  className = "";
  textContent = "";
  listeners = new Map<string, Set<(event: Event) => void>>();
  root = false;
  constructor(readonly tagName: string, readonly ownerDocument: TestDocument) {}
  get classList(): { contains(value: string): boolean } { return { contains: value => this.className.split(/\s+/).includes(value) }; }
  get isConnected(): boolean { return this.root || this.parentElement?.isConnected === true; }
  get nextSibling(): TestElement | null {
    if (!this.parentElement) return null;
    return this.parentElement.children[this.parentElement.children.indexOf(this) + 1] ?? null;
  }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  appendChild(child: TestElement): TestElement { child.remove(); this.children.push(child); child.parentElement = this; return child; }
  insertBefore(child: TestElement, before: TestElement | null): TestElement {
    if (!before) return this.appendChild(child);
    child.remove();
    const index = this.children.indexOf(before);
    if (index < 0) throw new Error("not a child");
    this.children.splice(index, 0, child); child.parentElement = this; return child;
  }
  remove(): void {
    if (!this.parentElement) return;
    const children = this.parentElement.children;
    children.splice(children.indexOf(this), 1); this.parentElement = null;
  }
  contains(child: TestElement | null): boolean { return child === this || !!child && this.children.some(item => item.contains(child)); }
  closest(selector: string): TestElement | null {
    if (selector === "button" && this.tagName === "BUTTON") return this;
    const attribute = selector.match(/^\[([^\]]+)\]$/)?.[1];
    if (attribute && this.attributes.has(attribute)) return this;
    return this.parentElement?.closest(selector) ?? null;
  }
  addEventListener(name: string, callback: (event: Event) => void): void {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)?.add(callback);
  }
  removeEventListener(name: string, callback: (event: Event) => void): void { this.listeners.get(name)?.delete(callback); }
  dispatch(name: string, target: TestElement, event = new Event(name, { cancelable: true })): Event {
    Object.defineProperty(event, "target", { value: target, configurable: true });
    for (const callback of this.listeners.get(name) ?? []) callback(event);
    return event;
  }
}

class TestObserver {
  static instances: TestObserver[] = [];
  disconnected = false;
  targets: { element: TestElement; options: MutationObserverInit }[] = [];
  constructor(readonly callback: () => void) { TestObserver.instances.push(this); }
  observe(element: TestElement, options: MutationObserverInit): void { this.targets.push({ element, options }); }
  disconnect(): void { this.disconnected = true; }
  notify(): void { if (!this.disconnected) this.callback(); }
}

class TestDocument {
  defaultView = { MutationObserver: TestObserver };
  createElement(name: string): TestElement { return new TestElement(name.toUpperCase(), this); }
}

function fixture() {
  const doc = new TestDocument();
  const node = (name = "div", className = "", parent?: TestElement): TestElement => {
    const element = doc.createElement(name); element.className = className; parent?.appendChild(element); return element;
  };
  const container = node(); container.root = true;
  const frame = node("div", "pI_x6G_frame", container);
  const sidebar = node("div", "pI_x6G_sidebarCol", frame);
  const nativeCenter = node("div", "pI_x6G_centerCol", frame);
  const details = node("div", "pI_x6G_detailsCol", frame);
  const overlay = node("div", "", frame); overlay.setAttribute("data-shell-overlay", "true");
  const anchor = node("span", "", overlay);
  const sidebarBoundary = node("div", "", sidebar);
  sidebarBoundary.setAttribute("data-slot", "sidebar");
  sidebarBoundary.setAttribute("style", "display: contents;");
  const sidebarRoot = node("div", "hHd-Xa_root", sidebarBoundary);
  const logo = node("div", "hHd-Xa_logoRow", sidebarRoot);
  const brand = node("button", "hHd-Xa_brand", logo);
  const newSession = node("button", "hHd-Xa_newSession", sidebarRoot);
  const region = node("div", "hHd-Xa_regionArea", sidebarRoot);
  const foot = node("div", "hHd-Xa_footArea", sidebarRoot);
  const conversation = node("section", "", nativeCenter);
  const editor = node("textarea", "", conversation);
  editor.textContent = "unsent native draft";
  return { doc, node, container, frame, sidebar, sidebarBoundary, sidebarRoot, logo, brand, newSession, region, foot, nativeCenter, details, overlay, anchor, conversation, editor };
}

const element = (node: TestElement): HTMLElement => node as unknown as HTMLElement;
const fake = (node: HTMLElement): TestElement => node as unknown as TestElement;

beforeEach(() => { TestObserver.instances = []; });

describe("rc.2 content surface DOM ownership", () => {
  it("adds local portal mounts and preserves every native node and draft through open/close/unload", () => {
    const f = fixture(); const other = fixture();
    f.nativeCenter.setAttribute("style", "color: red");
    f.region.setAttribute("inert", "");
    const nativeSidebarChildren = [...f.sidebarRoot.children];
    const nativeFrameChildren = [...f.frame.children];
    const surface = attachContentSurface(element(f.anchor));
    expect(surface).toBeDefined();
    expect(f.sidebarRoot.children.indexOf(fake(surface!.navigation))).toBe(f.sidebarRoot.children.indexOf(f.newSession) - 1);
    expect(f.sidebarRoot.children.indexOf(fake(surface!.library))).toBe(f.sidebarRoot.children.indexOf(f.region) + 1);
    expect(fake(surface!.center).parentElement).toBe(f.nativeCenter);
    expect(f.nativeCenter.children[0]).toBe(f.conversation);
    surface!.setActive(true);
    expect(f.frame.getAttribute("data-wemedia-content-active")).toBe(f.frame.getAttribute("data-wemedia-content-surface"));
    expect(other.frame.attributes.size).toBe(0);
    expect(other.sidebarRoot.children).toHaveLength(4);
    surface!.setActive(false);
    expect(f.frame.getAttribute("data-wemedia-content-active")).toBeNull();
    surface!.dispose(); surface!.dispose();
    expect(f.sidebarRoot.children).toEqual(nativeSidebarChildren);
    expect(f.frame.children).toEqual(nativeFrameChildren);
    expect(f.nativeCenter.children).toEqual([f.conversation]);
    expect(f.editor.textContent).toBe("unsent native draft");
    expect(f.nativeCenter.getAttribute("style")).toBe("color: red");
    expect(f.region.getAttribute("inert")).toBe("");
    expect(f.frame.getAttribute("data-wemedia-content-surface")).toBeNull();
    expect(f.sidebarRoot.listeners.get("click")?.size).toBe(0);
    expect(TestObserver.instances[0]?.disconnected).toBe(true);
  });

  it("owns the narrow library switch without moving native content, and removes it on unload", () => {
    const f = fixture(); const surface = attachContentSurface(element(f.anchor))!;
    const native = [...f.nativeCenter.children];
    surface.setActive(true); surface.setLibraryOpen(true);
    expect(f.frame.getAttribute("data-wemedia-library-open")).toBe(f.frame.getAttribute("data-wemedia-content-surface"));
    expect(f.nativeCenter.children).toEqual(native);
    surface.setLibraryOpen(false); expect(f.frame.getAttribute("data-wemedia-library-open")).toBeNull();
    surface.setLibraryOpen(true); surface.dispose();
    expect(f.frame.getAttribute("data-wemedia-library-open")).toBeNull();
    expect(f.editor.textContent).toBe("unsent native draft");
  });

  it("restores a previous mobile attribute without overwriting a newer owner's value", () => {
    const f = fixture(); f.frame.setAttribute("data-wemedia-library-open", "previous");
    const surface = attachContentSurface(element(f.anchor))!;
    surface.setLibraryOpen(true); surface.setLibraryOpen(false);
    expect(f.frame.getAttribute("data-wemedia-library-open")).toBe("previous");
    surface.setLibraryOpen(true); f.frame.setAttribute("data-wemedia-library-open", "another owner"); surface.dispose();
    expect(f.frame.getAttribute("data-wemedia-library-open")).toBe("another owner");
  });

  it.each(["unknown class", "column order", "duplicate region", "duplicate boundary", "changed boundary seat", "changed boundary display", "missing boundary", "wrong anchor", "disconnected"])("fails closed for %s without touching the app", reason => {
    const f = fixture();
    if (reason === "unknown class") f.sidebarRoot.className = "future_root";
    if (reason === "column order") f.frame.insertBefore(f.details, f.nativeCenter);
    if (reason === "duplicate region") f.node("div", "hHd-Xa_regionArea", f.sidebarRoot);
    if (reason === "duplicate boundary") f.node("div", "", f.sidebar).setAttribute("data-slot", "sidebar");
    if (reason === "changed boundary seat") f.sidebarBoundary.setAttribute("data-slot", "future-sidebar");
    if (reason === "changed boundary display") f.sidebarBoundary.setAttribute("style", "display: block;");
    if (reason === "missing boundary") f.sidebar.appendChild(f.sidebarRoot);
    if (reason === "wrong anchor") f.sidebarRoot.appendChild(f.anchor);
    if (reason === "disconnected") f.frame.remove();
    const before = [...f.sidebarRoot.children]; const frameChildren = [...f.frame.children];
    expect(attachContentSurface(element(f.anchor))).toBeUndefined();
    expect(f.sidebarRoot.children).toEqual(before);
    expect(f.frame.children).toEqual(frameChildren);
    expect(f.frame.attributes.size).toBe(0);
    expect(TestObserver.instances).toHaveLength(0);
  });

  it("restores previous private values only while the adapter still owns them", () => {
    const f = fixture();
    f.frame.setAttribute("data-wemedia-content-surface", "previous surface");
    f.frame.setAttribute("data-wemedia-content-active", "previous active");
    const first = attachContentSurface(element(f.anchor))!;
    first.setActive(true); first.setActive(false);
    expect(f.frame.getAttribute("data-wemedia-content-active")).toBe("previous active");
    first.dispose();
    expect(f.frame.getAttribute("data-wemedia-content-surface")).toBe("previous surface");
    const second = attachContentSurface(element(f.anchor))!;
    second.setActive(true);
    f.frame.setAttribute("data-wemedia-content-surface", "another writer");
    f.frame.setAttribute("data-wemedia-content-active", "another active writer");
    second.dispose();
    expect(f.frame.getAttribute("data-wemedia-content-surface")).toBe("another writer");
    expect(f.frame.getAttribute("data-wemedia-content-active")).toBe("another active writer");
  });

  it("does not attach twice to the same frame and permits remount after disposal", () => {
    const f = fixture(); const first = attachContentSurface(element(f.anchor))!;
    expect(attachContentSurface(element(f.anchor))).toBeUndefined();
    first.dispose();
    const second = attachContentSurface(element(f.anchor));
    expect(second?.isAvailable()).toBe(true);
    second?.dispose();
  });

  it("withdraws once on region replacement and cleans only its own nodes", () => {
    const f = fixture(); const unavailable = vi.fn();
    const surface = attachContentSurface(element(f.anchor), { onUnavailable: unavailable })!;
    surface.setActive(true);
    f.region.remove();
    const replacement = f.node("div", "hHd-Xa_regionArea");
    f.sidebarRoot.insertBefore(replacement, f.foot);
    TestObserver.instances[0]!.notify(); TestObserver.instances[0]!.notify();
    expect(unavailable).toHaveBeenCalledTimes(1);
    expect(surface.isAvailable()).toBe(false);
    expect(replacement.parentElement).toBe(f.sidebarRoot);
    expect(f.frame.getAttribute("data-wemedia-content-active")).toBeNull();
    expect(fake(surface.navigation).parentElement).toBeNull();
    expect(f.nativeCenter.children).toEqual([f.conversation]);
  });

  it("keeps the real Slot boundary untouched and uses it in the scoped visibility rules", () => {
    const f = fixture();
    const surface = attachContentSurface(element(f.anchor))!;
    surface.setActive(true);
    const css = f.frame.children.find(child => child.tagName === "STYLE")!.textContent;
    expect(css).toContain('> .pI_x6G_sidebarCol > [data-slot="sidebar"] > .hHd-Xa_root > .hHd-Xa_newSession');
    expect(css).toContain('> .pI_x6G_sidebarCol > [data-slot="sidebar"] > .hHd-Xa_root > .hHd-Xa_regionArea');
    expect(f.sidebar.children).toEqual([f.sidebarBoundary]);
    expect(f.sidebarBoundary.children).toEqual([f.sidebarRoot]);
    surface.dispose();
    expect(f.sidebarBoundary.getAttribute("style")).toBe("display: contents;");
    expect(f.sidebarBoundary.getAttribute("data-slot")).toBe("sidebar");
  });

  it("withdraws after an attached Slot boundary's contract changes", () => {
    const f = fixture(); const unavailable = vi.fn();
    const surface = attachContentSurface(element(f.anchor), { onUnavailable: unavailable })!;
    surface.setActive(true);
    f.sidebarBoundary.setAttribute("style", "display: block;");
    TestObserver.instances[0]!.notify();
    expect(unavailable).toHaveBeenCalledTimes(1);
    expect(surface.isAvailable()).toBe(false);
    expect(f.sidebarBoundary.getAttribute("style")).toBe("display: block;");
  });

  it("observes the established frame and only its parent's immediate children, including whole-frame removal", () => {
    const f = fixture(); const unavailable = vi.fn();
    const surface = attachContentSurface(element(f.anchor), { onUnavailable: unavailable })!;
    const observer = TestObserver.instances[0]!;
    expect(observer.targets.map(target => [target.element, target.options.subtree])).toEqual([[f.frame, true], [f.sidebarBoundary, undefined], [f.container, undefined]]);
    f.frame.remove(); observer.notify();
    expect(unavailable).toHaveBeenCalledTimes(1);
    expect(surface.isAvailable()).toBe(false);
  });

  it("allows ordinary native conversation rerenders and reports native session controls without intercepting them", () => {
    const f = fixture(); const session = vi.fn(); const unavailable = vi.fn();
    const surface = attachContentSurface(element(f.anchor), { onSessionRequested: session, onUnavailable: unavailable })!;
    f.conversation.remove(); const nextConversation = f.node("section", "", f.nativeCenter);
    TestObserver.instances[0]!.notify();
    expect(surface.isAvailable()).toBe(true);
    expect(unavailable).not.toHaveBeenCalled();
    const brandEvent = f.sidebarRoot.dispatch("click", f.brand);
    const newSessionEvent = f.sidebarRoot.dispatch("click", f.newSession);
    f.sidebarRoot.dispatch("click", f.foot);
    expect(session).toHaveBeenCalledTimes(2);
    expect(session.mock.calls.map(([event]) => event)).toEqual([brandEvent, newSessionEvent]);
    expect(brandEvent.defaultPrevented).toBe(false);
    expect(newSessionEvent.defaultPrevented).toBe(false);
    surface.dispose();
    expect(f.nativeCenter.children).toEqual([nextConversation]);
  });

  it("passes the original native event to the editor so a dirty guard can cancel it", () => {
    const f = fixture();
    const nativeEvent = new Event("click", { cancelable: true });
    const stop = vi.spyOn(nativeEvent, "stopImmediatePropagation");
    const session = vi.fn((event: Event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    });
    const surface = attachContentSurface(element(f.anchor), { onSessionRequested: session })!;
    const delivered = f.sidebarRoot.dispatch("click", f.newSession, nativeEvent);
    expect(delivered).toBe(nativeEvent);
    expect(session).toHaveBeenCalledWith(nativeEvent);
    expect(nativeEvent.defaultPrevented).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    surface.dispose();
  });
});
