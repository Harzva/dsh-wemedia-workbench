/** Presentation-only hardening of Host's already validated, data-image preview. */
export function inertPreview(html: string): string {
  // Template parsing stays detached/inert. Never insert article markup in the shell DOM.
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const node of template.content.querySelectorAll("a,area")) {
    node.removeAttribute("href");
    node.removeAttribute("xlink:href");
    node.removeAttribute("target");
    node.setAttribute("tabindex", "-1");
  }
  for (const node of template.content.querySelectorAll("script,iframe,object,embed,form,input,button,select,textarea,base,link")) node.remove();
  for (const node of template.content.querySelectorAll("meta[http-equiv]")) {
    if (node.getAttribute("http-equiv")?.toLowerCase() === "refresh") node.remove();
  }
  const csp = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; base-uri 'none'; form-action 'none'";
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">${template.innerHTML}`;
}
