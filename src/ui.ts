export type LogLevel = "info" | "success" | "warning" | "error";

export function redactUiError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "알 수 없는 오류");
  return raw
    .replace(/(authorization\s*[:=]\s*)bearer\s+[^\s,;"'}]+/giu, "$1Bearer [REDACTED]")
    .replace(/\bbearer\s+[a-z0-9._~+/-]{8,}/giu, "Bearer [REDACTED]")
    .replace(/\b(?:sk|sess)-[a-z0-9_-]{8,}\b/giu, "[REDACTED]")
    .replace(/("?(?:api[_-]?key|password|secret|token)"?\s*[:=]\s*["']?)[^\s,"'}]+/giu, "$1[REDACTED]")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .trim()
    .slice(0, 2_000);
}

export function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) {
    throw new Error(`필수 UI 요소를 찾지 못했습니다: #${id}`);
  }
  return found as T;
}

export function optionalElement<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

export function valueOf(id: string): string {
  const control = element<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(id);
  // UXP는 값이 비거나 사용자가 건드리기 전 <input>/<select>.value로 null을 돌려줄 수 있어,
  // 이후 .trim()/.normalize() 호출이 크래시하지 않도록 항상 문자열을 반환한다.
  return control.value ?? "";
}

export function numberOf(id: string, fallback: number): number {
  // 빈 입력은 Number("")===0이 되어 0으로 잘못 읽히므로 fallback으로 처리한다.
  const raw = valueOf(id).trim();
  if (raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function checkedOf(id: string): boolean {
  return element<HTMLInputElement>(id).checked;
}

export function setText(id: string, text: string, title?: string): void {
  const target = optionalElement<HTMLElement>(id);
  if (!target) return;
  target.textContent = text;
  if (title !== undefined) target.setAttribute("title", title);
}

export function setValue(id: string, value: string | number): void {
  const target = optionalElement<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(id);
  if (target) target.value = String(value);
}

export function setChecked(id: string, checked: boolean): void {
  const target = optionalElement<HTMLInputElement>(id);
  if (target) target.checked = checked;
}

export function bind(
  id: string,
  eventName: string,
  listener: (event: Event) => void | Promise<void>,
): void {
  const target = optionalElement<HTMLElement>(id);
  if (!target) return;
  target.addEventListener(eventName, (event) => {
    try {
      const result = listener(event);
      if (result && typeof result.catch === "function") {
        void result.catch((error: unknown) => console.error(redactUiError(error)));
      }
    } catch (error) {
      console.error(redactUiError(error));
    }
  });
}

let tabsInitialized = false;

function activateWorkflowTab(tab: HTMLButtonElement, focus = false): void {
  const tabs = [...document.querySelectorAll<HTMLButtonElement>(".nav-tab[data-tab]")];
  const panels = [...document.querySelectorAll<HTMLElement>(".workflow-panel[data-panel]")];
  const id = tab.dataset.tab;
  if (!id) return;
  for (const candidate of tabs) {
    const active = candidate === tab;
    candidate.classList.toggle("is-active", active);
    candidate.setAttribute("aria-selected", String(active));
    candidate.tabIndex = active ? 0 : -1;
  }
  for (const panel of panels) {
    const active = panel.dataset.panel === id;
    panel.classList.toggle("is-active", active);
    panel.hidden = !active;
  }
  if (focus) tab.focus();
}

function workflowTabFromEvent(event: Event): HTMLButtonElement | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const tab = target.closest<HTMLButtonElement>(".nav-tab[data-tab]");
  return tab instanceof HTMLButtonElement ? tab : null;
}

export function setupTabs(): void {
  if (tabsInitialized) return;
  tabsInitialized = true;

  document.addEventListener("click", (event) => {
    const tab = workflowTabFromEvent(event);
    if (!tab) return;
    event.preventDefault();
    activateWorkflowTab(tab);
  }, true);

  document.addEventListener("keydown", (event: KeyboardEvent) => {
    const tab = workflowTabFromEvent(event);
    if (!tab || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...document.querySelectorAll<HTMLButtonElement>(".nav-tab[data-tab]")];
    const index = tabs.indexOf(tab);
    let nextIndex = index < 0 ? 0 : index;
    if (event.key === "ArrowLeft") nextIndex = (nextIndex - 1 + tabs.length) % tabs.length;
    if (event.key === "ArrowRight") nextIndex = (nextIndex + 1) % tabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    const next = tabs[nextIndex];
    if (next) activateWorkflowTab(next, true);
  }, true);

  const initial = document.querySelector<HTMLButtonElement>(".nav-tab.is-active[data-tab]")
    ?? document.querySelector<HTMLButtonElement>(".nav-tab[data-tab]");
  if (initial) activateWorkflowTab(initial);
}

function clockText(date = new Date()): string {
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

export class ActivityLog {
  private readonly target: HTMLOListElement | null;

  constructor(id = "log-list") {
    this.target = optionalElement<HTMLOListElement>(id);
  }

  add(level: LogLevel, message: string): void {
    if (!this.target) return;
    const empty = this.target.querySelector(".log-empty");
    empty?.remove();
    const item = document.createElement("li");
    item.className = `log-entry log-${level}`;

    const time = document.createElement("time");
    time.textContent = clockText();
    const badge = document.createElement("span");
    badge.className = "log-level";
    badge.textContent = level.toUpperCase();
    const body = document.createElement("span");
    body.className = "log-message";
    body.textContent = message;
    item.append(time, badge, body);
    this.target.prepend(item);
    while (this.target.children.length > 200) {
      this.target.lastElementChild?.remove();
    }
  }

  clear(): void {
    if (!this.target) return;
    clearChildren(this.target);
    const empty = document.createElement("li");
    empty.className = "log-empty";
    empty.textContent = "기록된 작업이 없습니다.";
    this.target.append(empty);
  }
}

export class BusyState {
  private readonly overlay = optionalElement<HTMLElement>("busy-overlay");
  private readonly message = optionalElement<HTMLElement>("busy-message");
  private depth = 0;

  show(message: string): void {
    this.depth += 1;
    if (this.message) this.message.textContent = message;
    if (this.overlay) this.overlay.hidden = false;
  }

  hide(): void {
    this.depth = Math.max(0, this.depth - 1);
    if (this.overlay && this.depth === 0) this.overlay.hidden = true;
  }

  async during<T>(message: string, task: () => Promise<T>): Promise<T> {
    this.show(message);
    try {
      return await task();
    } finally {
      this.hide();
    }
  }
}

export function toast(message: string, level: LogLevel = "info", timeoutMs = 3200): void {
  const region = optionalElement<HTMLElement>("toast-region");
  if (!region) return;
  const item = document.createElement("div");
  item.className = `toast toast-${level}`;
  item.setAttribute("role", level === "error" ? "alert" : "status");
  item.textContent = message;
  region.append(item);
  setTimeout(() => item.remove(), timeoutMs);
}

// Premiere 26.3 UXP can leave stale children behind after replaceChildren();
// remove explicitly when the host DOM supports it, and fall back for mock DOMs.
export function clearChildren(target: HTMLElement): void {
  if (typeof target.removeChild === "function") {
    while (target.firstChild) target.removeChild(target.firstChild);
    return;
  }
  target.replaceChildren();
}

export function renderEmptyState(target: HTMLElement, title: string, detail = ""): void {
  const wrapper = document.createElement("div");
  wrapper.className = "empty-state compact-empty-state";
  const icon = document.createElement("span");
  icon.className = "empty-state-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "◇";
  const heading = document.createElement("strong");
  heading.textContent = title;
  wrapper.append(icon, heading);
  if (detail) {
    const paragraph = document.createElement("p");
    paragraph.textContent = detail;
    wrapper.append(paragraph);
  }
  // Premiere 26.3 UXP can leave stale children behind after replaceChildren().
  while (target.firstChild) target.removeChild(target.firstChild);
  target.append(wrapper);
}
