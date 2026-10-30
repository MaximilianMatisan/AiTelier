// A2UI v0.9.1 renderer for the Basic Catalog components the AiTelier agent
// emits: Text, Image, Card, Button, Column, Row, List, Tabs, Icon, Divider.
//
//   renderSurface(result.a2ui.messages, mountElement)
//
// The agent describes the interface; this only draws it. Text is always set
// as text, never as HTML. Images load only from http(s) or this server, and
// the only action honoured is openUrl to an http(s) address. A component
// this renderer does not know is shown as a visible placeholder.

const ICONS = { check: "✓", close: "✕", error: "✕", warning: "!", info: "i", star: "★", favorite: "♥" };
const TEXT_TAGS = { h1: "h2", h2: "h3", h3: "h4", h4: "h5", h5: "h6", caption: "small", body: "p" };

const safeUrl = (value) => {
  try {
    const url = new URL(value, location.href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** Literal strings, or a {path} binding resolved against the data model. */
function resolve(value, model) {
  if (value && typeof value === "object") {
    if ("literalString" in value) return value.literalString;
    if ("path" in value)
      return value.path
        .split("/")
        .filter(Boolean)
        .reduce((node, key) => (node == null ? node : node[key]), model);
  }
  return value;
}

export function renderSurface(messages, mount) {
  const components = new Map();
  let theme = {};
  let model = {};
  for (const message of messages) {
    if (message.createSurface) theme = message.createSurface.theme ?? {};
    if (message.updateComponents) for (const c of message.updateComponents.components) components.set(c.id, c);
    if (message.updateDataModel?.path === "/") model = message.updateDataModel.value ?? {};
  }
  if (theme.primaryColor) mount.style.setProperty("--a2ui-primary", theme.primaryColor);

  const seen = new Set();
  const build = (id) => {
    const c = components.get(id);
    if (!c) return el("div", "a2ui-unknown", `missing component "${id}"`);
    if (seen.has(id)) return el("div", "a2ui-unknown", `cycle at "${id}"`);
    seen.add(id);
    const node = draw(c);
    seen.delete(id);
    node.dataset.a2uiId = id;
    return node;
  };
  const children = (node, ids = []) => {
    for (const id of ids) node.append(build(id));
    return node;
  };

  function draw(c) {
    switch (c.component) {
      case "Text":
        return el(TEXT_TAGS[c.variant] ?? "p", `a2ui-text a2ui-text-${c.variant ?? "body"}`, resolve(c.text, model));
      case "Image": {
        const src = safeUrl(resolve(c.url, model));
        if (!src) return el("div", "a2ui-unknown", "image without a usable address");
        const img = el("img", `a2ui-image a2ui-image-${c.variant ?? "default"}`);
        img.src = src;
        img.alt = resolve(c.description, model) ?? "";
        img.loading = "lazy";
        img.style.objectFit = c.fit ?? "cover";
        img.addEventListener("error", () => img.replaceWith(el("div", "a2ui-image-missing", img.alt || "image unavailable")));
        return img;
      }
      case "Card":
        return children(el("div", "a2ui-card"), [c.child]);
      case "Column":
        return children(el("div", `a2ui-column a2ui-align-${c.align ?? "stretch"}`), c.children);
      case "Row":
        return children(el("div", `a2ui-row a2ui-align-${c.align ?? "center"}`), c.children);
      case "List":
        return children(el("div", `a2ui-list a2ui-list-${c.direction ?? "vertical"}`), c.children);
      case "Divider":
        return el("hr", "a2ui-divider");
      case "Icon":
        return el("span", `a2ui-icon a2ui-icon-${c.name}`, ICONS[c.name] ?? "•");
      case "Button": {
        const button = children(el("button", `a2ui-button a2ui-button-${c.variant ?? "primary"}`), [c.child]);
        button.type = "button";
        const call = c.action?.functionCall;
        const url = call?.call === "openUrl" ? safeUrl(resolve(call.args?.url, model)) : null;
        if (url) button.addEventListener("click", () => window.open(url, "_blank", "noopener,noreferrer"));
        else button.disabled = true;
        return button;
      }
      case "Tabs": {
        const wrap = el("div", "a2ui-tabs");
        const bar = el("div", "a2ui-tabbar");
        bar.setAttribute("role", "tablist");
        const panels = el("div", "a2ui-tabpanels");
        (c.tabs ?? []).forEach((tab, i) => {
          const button = el("button", "a2ui-tab", resolve(tab.title, model));
          button.type = "button";
          button.setAttribute("role", "tab");
          const panel = children(el("div", "a2ui-tabpanel"), [tab.child]);
          panel.setAttribute("role", "tabpanel");
          const select = () => {
            bar.querySelectorAll(".a2ui-tab").forEach((b) => b.setAttribute("aria-selected", "false"));
            panels.querySelectorAll(".a2ui-tabpanel").forEach((p) => (p.hidden = true));
            button.setAttribute("aria-selected", "true");
            panel.hidden = false;
          };
          button.addEventListener("click", select);
          bar.append(button);
          panels.append(panel);
          if (i === 0) queueMicrotask(select);
        });
        wrap.append(bar, panels);
        return wrap;
      }
      default:
        return el("div", "a2ui-unknown", `unsupported component ${c.component}`);
    }
  }

  mount.replaceChildren(build(components.has("root") ? "root" : [...components.keys()][0]));
}
