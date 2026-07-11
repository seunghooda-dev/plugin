import {
  MAX_IMAGE_INPUTS,
  REFERENCE_FILE_TYPES,
  ReferenceLibrary,
  classifyReference,
  createDefaultReferenceAdapter,
  type ReferenceFileEntry,
  type ReferenceImageInput,
  type ReferenceItem,
} from "./references";
import { bind, element, renderEmptyState, valueOf } from "./ui";

export interface ReferenceControllerOptions {
  onActivity?: (message: string) => void;
  onError?: (error: unknown, context: string) => void;
  onSelectionChange?: (selectedImageIds: readonly string[]) => void;
}

function entryName(entry: ReferenceFileEntry): string {
  return String(entry.name ?? entry.nativePath ?? "레퍼런스");
}

function entryKind(entry: ReferenceFileEntry): "image" | "video" | null {
  return classifyReference(String(entry.nativePath ?? entry.name ?? ""));
}

function notesWithCategory(notes: string, category: string): string {
  const clean = notes.trim();
  if (category === "moodboard") return `[무드보드]${clean ? ` ${clean}` : ""}`;
  if (category === "other") return `[기타]${clean ? ` ${clean}` : ""}`;
  return clean;
}

/**
 * 레퍼런스 보드의 DOM 수명과 UXP persistent-token 라이브러리를 연결합니다.
 * 파일 바이너리는 AI 실행 시에만 읽고, 카드에는 UXP가 제공한 URL만 사용합니다.
 */
export class ReferenceController {
  private readonly library = new ReferenceLibrary(createDefaultReferenceAdapter());
  private readonly selectedImageIds = new Set<string>();
  private stagedEntries: ReferenceFileEntry[] = [];
  private dragFromIndex = -1;

  constructor(private readonly options: ReferenceControllerOptions = {}) {}

  async initialize(): Promise<void> {
    this.bindEvents();
    await this.library.load();
    this.render();
  }

  get items(): readonly ReferenceItem[] {
    return this.library.items;
  }

  get selectedIds(): readonly string[] {
    return [...this.selectedImageIds];
  }

  async getSelectedImageInputs(): Promise<ReferenceImageInput[]> {
    return this.library.getImageInputs(this.selectedIds);
  }

  private bindEvents(): void {
    bind("choose-reference-btn", "click", () => this.guard(
      () => this.chooseFiles(),
      "레퍼런스 파일 선택 실패",
    ));
    bind("add-reference-btn", "click", () => this.guard(
      () => this.addStagedFiles(),
      "레퍼런스 추가 실패",
    ));
    bind("reference-type-select", "change", () => this.updateStagedUI());
  }

  private async guard(task: () => Promise<void>, context: string): Promise<void> {
    try {
      await task();
    } catch (error) {
      this.options.onError?.(error, context);
    }
  }

  private async chooseFiles(): Promise<void> {
    const selection = await this.library.adapter.localFileSystem.getFileForOpening({
      allowMultiple: true,
      types: REFERENCE_FILE_TYPES,
    });
    if (!selection) return;

    const requestedType = valueOf("reference-type-select");
    const picked = (Array.isArray(selection) ? selection : [selection]).filter((entry) => {
      const kind = entryKind(entry);
      if (!kind) return false;
      if (requestedType === "image" || requestedType === "video") {
        return kind === requestedType;
      }
      return true;
    });

    if (picked.length === 0) {
      throw new Error(requestedType === "video"
        ? "동영상 레퍼런스 파일을 선택해 주세요."
        : "이미지 레퍼런스 파일을 선택해 주세요.");
    }

    this.stagedEntries = picked;
    this.updateStagedUI();
    this.options.onActivity?.(`${picked.length}개 레퍼런스 파일을 선택했습니다.`);
  }

  private updateStagedUI(): void {
    const button = element<HTMLButtonElement>("add-reference-btn");
    button.disabled = this.stagedEntries.length === 0;
    button.textContent = this.stagedEntries.length > 0
      ? `${this.stagedEntries.length}개 레퍼런스 보드에 추가`
      : "레퍼런스 보드에 추가";
    if (this.stagedEntries.length > 0) {
      button.title = this.stagedEntries.map(entryName).join("\n");
    } else {
      button.removeAttribute("title");
    }
  }

  private async addStagedFiles(): Promise<void> {
    if (this.stagedEntries.length === 0) {
      throw new Error("먼저 레퍼런스 파일을 선택해 주세요.");
    }
    const entries = [...this.stagedEntries];
    const category = valueOf("reference-type-select");
    const notes = notesWithCategory(valueOf("reference-notes-input"), category);
    const additions = await this.library.addEntries(entries, notes);
    this.stagedEntries = [];
    element<HTMLTextAreaElement>("reference-notes-input").value = "";
    this.updateStagedUI();
    this.render();
    this.options.onActivity?.(`${additions.length}개 레퍼런스를 보드에 추가했습니다.`);
  }

  private setImageSelected(id: string, checked: boolean): void {
    if (checked && !this.selectedImageIds.has(id)) {
      if (this.selectedImageIds.size >= MAX_IMAGE_INPUTS) {
        throw new Error(`AI 입력 레퍼런스는 최대 ${MAX_IMAGE_INPUTS}개까지 선택할 수 있습니다.`);
      }
      this.selectedImageIds.add(id);
    } else if (!checked) {
      this.selectedImageIds.delete(id);
    }
    this.options.onSelectionChange?.(this.selectedIds);
  }

  private previewFor(item: ReferenceItem): HTMLElement {
    const preview = document.createElement("div");
    preview.className = "reference-preview";
    if (item.unavailable || !item.url) {
      const unavailable = document.createElement("span");
      unavailable.className = "reference-unavailable";
      unavailable.textContent = "파일 접근 만료";
      preview.append(unavailable);
      return preview;
    }
    if (item.type === "video") {
      const video = document.createElement("video");
      video.src = item.url;
      video.controls = true;
      video.muted = true;
      video.preload = "metadata";
      video.setAttribute("aria-label", `${item.name} 동영상 미리보기`);
      preview.append(video);
    } else {
      const image = document.createElement("img");
      image.src = item.url;
      image.alt = `${item.name} 이미지 레퍼런스`;
      image.loading = "lazy";
      preview.append(image);
    }
    return preview;
  }

  private renderCard(item: ReferenceItem, index: number): HTMLElement {
    const card = document.createElement("article");
    card.className = "reference-card draggable-card";
    card.setAttribute("role", "listitem");
    card.draggable = true;
    card.dataset.referenceIndex = String(index);
    if (item.unavailable) card.classList.add("is-unavailable");

    const copy = document.createElement("div");
    copy.className = "reference-card-copy";
    const title = document.createElement("strong");
    title.textContent = item.name;
    title.title = item.nativePath;
    const kind = document.createElement("small");
    kind.textContent = item.type === "image" ? "AI 이미지 레퍼런스" : "AI 동영상 레퍼런스";
    copy.append(title, kind);

    const notes = document.createElement("textarea");
    notes.className = "reference-notes-editor";
    notes.value = item.notes;
    notes.maxLength = 1_000;
    notes.rows = 2;
    notes.placeholder = "활용 메모";
    notes.setAttribute("aria-label", `${item.name} 활용 메모`);
    notes.addEventListener("change", () => void this.guard(async () => {
      await this.library.updateNotes(item.id, notes.value);
      this.options.onActivity?.(`${item.name} 메모를 저장했습니다.`);
    }, "레퍼런스 메모 저장 실패"));

    const actions = document.createElement("div");
    actions.className = "reference-card-actions";
    if (item.type === "image" && !item.unavailable) {
      const selectLabel = document.createElement("label");
      selectLabel.className = "reference-ai-select";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = this.selectedImageIds.has(item.id);
      checkbox.setAttribute("aria-label", `${item.name}을 AI 입력으로 선택`);
      checkbox.addEventListener("change", () => {
        try {
          this.setImageSelected(item.id, checkbox.checked);
        } catch (error) {
          checkbox.checked = false;
          this.options.onError?.(error, "AI 레퍼런스 선택 실패");
        }
      });
      const labelText = document.createElement("span");
      labelText.textContent = "AI 입력";
      selectLabel.append(checkbox, labelText);
      actions.append(selectLabel);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "reference-remove-btn";
    remove.textContent = "삭제";
    remove.setAttribute("aria-label", `${item.name} 레퍼런스 삭제`);
    remove.addEventListener("click", () => void this.guard(async () => {
      await this.library.remove(item.id);
      this.selectedImageIds.delete(item.id);
      this.options.onSelectionChange?.(this.selectedIds);
      this.render();
      this.options.onActivity?.(`${item.name} 레퍼런스를 삭제했습니다.`);
    }, "레퍼런스 삭제 실패"));
    actions.append(remove);

    card.addEventListener("dragstart", (event) => {
      this.dragFromIndex = index;
      event.dataTransfer?.setData("text/shortflow-reference-index", String(index));
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    });
    card.addEventListener("drop", (event) => {
      event.preventDefault();
      const raw = event.dataTransfer?.getData("text/shortflow-reference-index");
      const from = raw ? Number(raw) : this.dragFromIndex;
      if (!Number.isInteger(from) || from === index) return;
      void this.guard(async () => {
        await this.library.reorder(from, index);
        this.render();
      }, "레퍼런스 순서 변경 실패");
    });
    card.addEventListener("dragend", () => { this.dragFromIndex = -1; });

    card.append(this.previewFor(item), copy, notes, actions);
    return card;
  }

  private render(): void {
    const target = element<HTMLElement>("reference-list");
    const items = this.library.items;
    target.replaceChildren();
    if (items.length === 0) {
      renderEmptyState(target, "등록된 레퍼런스가 없습니다", "이미지 또는 동영상 파일을 선택해 보드에 추가해 주세요.");
      return;
    }
    items.forEach((item, index) => target.append(this.renderCard(item, index)));
  }
}

