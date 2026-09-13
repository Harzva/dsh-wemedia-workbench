/**
 * Version-scoped layout adapter for the installed DSH 0.1.1-rc.2 client.
 * This is a DOM compatibility layer, not a first-level navigation Slot.
 * It owns only three portal mounts, one style element, and private attributes;
 * the native sidebar and conversation React trees stay in their original seats.
 */
export interface ContentSurface {
  navigation: HTMLElement;
  library: HTMLElement;
  center: HTMLElement;
  setActive(active: boolean): void;
  setLibraryOpen(open: boolean): void;
  isAvailable(): boolean;
  dispose(): void;
}

export interface ContentSurfaceOptions {
  /** Called once after a previously attached host structure becomes invalid. */
  onUnavailable?: () => void;
  /** Capture-phase native event; callers may cancel it while resolving unsaved edits. */
  onSessionRequested?: (event: Event) => void;
}

// Exact CSS-module tokens observed in the installed rc.2 bundles. Unknown
// versions fail closed rather than guessing a new host's layout from geometry.
const classes = {
  frame: "pI_x6G_frame",
  sidebar: "pI_x6G_sidebarCol",
  center: "pI_x6G_centerCol",
  details: "pI_x6G_detailsCol",
  sidebarRoot: "hHd-Xa_root",
  logo: "hHd-Xa_logoRow",
  brand: "hHd-Xa_brand",
  newSession: "hHd-Xa_newSession",
  region: "hHd-Xa_regionArea",
  foot: "hHd-Xa_footArea",
} as const;
const scopeAttribute = "data-wemedia-content-surface";
const activeAttribute = "data-wemedia-content-active";
const libraryAttribute = "data-wemedia-library-open";
const mountAttribute = "data-wemedia-content-mount";
const attachedFrames = new WeakSet<HTMLElement>();
let nextSurface = 0;

interface HostParts {
  frame: HTMLElement;
  overlay: HTMLElement;
  sidebar: HTMLElement;
  sidebarBoundary: HTMLElement;
  sidebarRoot: HTMLElement;
  logo: HTMLElement;
  newSession: HTMLElement;
  region: HTMLElement;
  foot: HTMLElement;
  center: HTMLElement;
  details: HTMLElement;
}

/** Match only direct children of the exact ancestor established by our anchor. */
function direct(parent: HTMLElement, className: string): HTMLElement | undefined {
  const matches = Array.from(parent.children).filter(child => child.classList.contains(className));
  return matches.length === 1 ? matches[0] as HTMLElement : undefined;
}

function discover(anchor: HTMLElement): HostParts | undefined {
  if (!anchor.isConnected) return;
  const overlay = anchor.closest<HTMLElement>("[data-shell-overlay]");
  const frame = overlay?.parentElement;
  if (!overlay || !frame || !frame.classList.contains(classes.frame)) return;
  const sidebar = direct(frame, classes.sidebar);
  const center = direct(frame, classes.center);
  const details = direct(frame, classes.details);
  if (!sidebar || !center || !details) return;
  // The audited AppFrame fixes the three columns and overlay in this order.
  if (frame.children[0] !== sidebar || frame.children[1] !== center
    || frame.children[2] !== details || frame.children[3] !== overlay) return;
  // The native SlotEntryBoundary contributes this display:contents wrapper;
  // it is part of the renderer contract, not a competing sidebar occupant.
  const boundaries = Array.from(sidebar.children).filter(child => child.getAttribute("data-slot") === "sidebar");
  const sidebarBoundary = boundaries.length === 1 ? boundaries[0] as HTMLElement : undefined;
  if (!sidebarBoundary || sidebarBoundary.tagName !== "DIV"
    || !/(?:^|;)\s*display\s*:\s*contents\s*(?:;|$)/.test(sidebarBoundary.getAttribute("style") ?? "")) return;
  const sidebarRoot = direct(sidebarBoundary, classes.sidebarRoot);
  if (!sidebarRoot) return;
  const logo = direct(sidebarRoot, classes.logo);
  const newSession = direct(sidebarRoot, classes.newSession);
  const region = direct(sidebarRoot, classes.region);
  const foot = direct(sidebarRoot, classes.foot);
  if (!logo || !newSession || !region || !foot || newSession.tagName !== "BUTTON") return;
  const native = Array.from(sidebarRoot.children).filter(child =>
    child === logo || child === newSession || child === region || child === foot);
  if (native[0] !== logo || native[1] !== newSession || native[2] !== region || native[3] !== foot) return;
  return { frame, overlay, sidebar, sidebarBoundary, sidebarRoot, logo, newSession, region, foot, center, details };
}

/** Release only a value we still own; do not overwrite another writer's change. */
function writeAttribute(element: HTMLElement, name: string, value: string): () => void {
  const previous = element.getAttribute(name);
  element.setAttribute(name, value);
  return () => {
    if (element.getAttribute(name) !== value) return;
    if (previous === null) element.removeAttribute(name);
    else element.setAttribute(name, previous);
  };
}

/**
 * Attach beside native rc.2 regions. A missing or changed contract returns
 * undefined without writing anything; callers can keep their additive fallback.
 */
export function attachContentSurface(anchor: HTMLElement, options: ContentSurfaceOptions = {}): ContentSurface | undefined {
  const host = discover(anchor);
  if (!host || attachedFrames.has(host.frame)) return;
  const { frame, sidebarRoot, newSession, region } = host;
  const doc = anchor.ownerDocument;
  const id = `wemedia-content-${++nextSurface}`;
  const scope = `[${scopeAttribute}="${id}"]`;
  const active = `${scope}[${activeAttribute}="${id}"]`;
  const navigation = doc.createElement("div");
  const library = doc.createElement("div");
  const center = doc.createElement("div");
  for (const [element, name] of [[navigation, "navigation"], [library, "library"], [center, "center"]] as const) {
    element.className = `wemedia-content-${name}`;
    element.setAttribute(mountAttribute, name);
  }
  const style = doc.createElement("style");
  style.setAttribute("data-wemedia-content-style", id);
  style.textContent = `
${scope} [${mountAttribute}="navigation"] { display: flex; flex: none; min-width: 0; }
${scope} [${mountAttribute}="library"], ${scope} [${mountAttribute}="center"] { display: none; flex: 1 1 0; min-height: 0; min-width: 0; overflow: hidden; }
${active} > .${classes.sidebar} > [data-slot="sidebar"] > .${classes.sidebarRoot} > .${classes.newSession},
${active} > .${classes.sidebar} > [data-slot="sidebar"] > .${classes.sidebarRoot} > .${classes.region},
${active} > .${classes.center} > :not([${mountAttribute}="center"]) { display: none !important; }
${active} [${mountAttribute}="library"], ${active} [${mountAttribute}="center"] { display: flex; }
${scope}[data-sidebar-collapsed] [${mountAttribute}="navigation"] { flex-direction: column; }
${scope}[data-sidebar-collapsed] [data-wemedia-nav-label] { display: none; }
${scope}[data-sidebar-collapsed] [${mountAttribute}="library"] { display: none; }
@media(max-width:700px) {
  ${active} { grid-template-columns: minmax(0, 1fr) !important; }
  ${active} > .${classes.sidebar}, ${active} > .${classes.details} { display: none !important; }
  ${active} > .${classes.center} { flex: 1 1 0; min-width: 0; width: 100%; }
  ${active}[${libraryAttribute}="${id}"] > .${classes.center} { display: none !important; }
  ${active}[${libraryAttribute}="${id}"] > .${classes.sidebar} { display: flex !important; flex: 1 1 0 !important; width: 100% !important; max-width: none !important; min-width: 0; }
  ${active}[${libraryAttribute}="${id}"] > .${classes.sidebar} > [data-slot="sidebar"] > .${classes.sidebarRoot} { width: 100%; min-width: 0; flex: 1; }
  ${active}[${libraryAttribute}="${id}"] [${mountAttribute}="library"] { display: flex; flex-direction: column; }
  ${active}[${libraryAttribute}="${id}"] [${mountAttribute}="navigation"], ${active}[${libraryAttribute}="${id}"] .wm-content-switch { flex-direction: row; }
  ${active}[${libraryAttribute}="${id}"] [data-wemedia-nav-label] { display: inline; }
}
`;
  let live = true;
  let restoreActive: (() => void) | undefined;
  let restoreLibrary: (() => void) | undefined;
  const restoreScope = writeAttribute(frame, scopeAttribute, id);
  sidebarRoot.insertBefore(navigation, newSession);
  sidebarRoot.insertBefore(library, region.nextSibling);
  host.center.appendChild(center);
  frame.appendChild(style);
  attachedFrames.add(frame);

  const available = (): boolean => {
    if (!live || frame.getAttribute(scopeAttribute) !== id) return false;
    const current = discover(anchor);
    return current !== undefined
      && (Object.keys(host) as (keyof HostParts)[]).every(key => current[key] === host[key])
      && navigation.parentElement === sidebarRoot && library.parentElement === sidebarRoot
      && center.parentElement === host.center && style.parentElement === frame;
  };
  const onSession = (event: Event): void => {
    const target = event.target;
    // Avoid cross-window instanceof checks. The adapter never cancels on its
    // own; the owning editor may cancel this original event for a dirty guard.
    if (!target || !("closest" in target) || typeof target.closest !== "function") return;
    const button = (target as Element).closest("button");
    if (button === newSession || (button?.classList.contains(classes.brand) && host.logo.contains(button))) {
      options.onSessionRequested?.(event);
    }
  };
  sidebarRoot.addEventListener("click", onSession, true);
  const Observer = doc.defaultView?.MutationObserver;
  const observer = Observer ? new Observer(() => {
    if (available()) return;
    dispose();
    options.onUnavailable?.();
  }) : undefined;
  // Scope remains this one proven frame; the immediate parent observation also
  // detects a full frame replacement without watching the document or body tree.
  observer?.observe(frame, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", scopeAttribute] });
  observer?.observe(host.sidebarBoundary, { attributes: true, attributeFilter: ["data-slot", "style"] });
  if (frame.parentElement) observer?.observe(frame.parentElement, { childList: true });

  function dispose(): void {
    if (!live) return;
    live = false;
    observer?.disconnect();
    sidebarRoot.removeEventListener("click", onSession, true);
    restoreActive?.();
    restoreActive = undefined;
    restoreLibrary?.();
    restoreLibrary = undefined;
    restoreScope();
    navigation.remove();
    library.remove();
    center.remove();
    style.remove();
    attachedFrames.delete(frame);
  }

  return {
    navigation, library, center,
    setActive(active): void {
      if (!available()) {
        if (live) { dispose(); options.onUnavailable?.(); }
        return;
      }
      if (active && !restoreActive) restoreActive = writeAttribute(frame, activeAttribute, id);
      else if (!active && restoreActive) { restoreActive(); restoreActive = undefined; }
    },
    setLibraryOpen(open): void {
      if (!available()) return;
      if (open && !restoreLibrary) restoreLibrary = writeAttribute(frame, libraryAttribute, id);
      else if (!open && restoreLibrary) { restoreLibrary(); restoreLibrary = undefined; }
    },
    isAvailable: available,
    dispose,
  };
}
