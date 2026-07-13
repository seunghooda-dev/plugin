import {
  MAX_IMAGE_INPUTS,
  MAX_REFERENCE_PROMPT_ITEMS,
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
  onSelectionChange?: (selectedReferenceIds: readonly string[]) => void;
  enrichPromptProvider?: (prompt: string) => Promise<string>;
  /**
   * 프롬프트로 이미지를 생성해 디스크에 쓴 뒤 그 파일 엔트리를 돌려주는 포트.
   * 반환값은 신뢰하지 않으며 `addEntries`가 다시 검증한다(index.ts가 AI 호출·파일 쓰기를 주입).
   */
  generatedImageProvider?: (prompt: string, size: string) => Promise<ReferenceFileEntry>;
  /** 프롬프트로 영상을 생성해 디스크에 쓴 뒤 그 파일 엔트리를 돌려주는 포트(반환값 재검증). */
  generatedVideoProvider?: (prompt: string, seconds: string) => Promise<ReferenceFileEntry>;
  /** Injectable for tests; defaults to the UXP-backed library. */
  library?: ReferenceLibrary;
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

function tagsText(tags: readonly string[]): string {
  return tags.join(", ");
}

/**
 * 레퍼런스 보드의 DOM 수명과 UXP persistent-token 라이브러리를 연결합니다.
 * 파일 바이너리는 AI 실행 시에만 읽고, 카드에는 UXP가 제공한 URL만 사용합니다.
 */
export class ReferenceController {
  private readonly library: ReferenceLibrary;
  private readonly selectedReferenceIds = new Set<string>();
  private stagedEntries: ReferenceFileEntry[] = [];
  private dragFromIndex = -1;

  constructor(private readonly options: ReferenceControllerOptions = {}) {
    this.library = options.library ?? new ReferenceLibrary(createDefaultReferenceAdapter());
  }

  async initialize(): Promise<void> {
    this.bindEvents();
    await this.library.load();
    this.render();
  }

  get items(): readonly ReferenceItem[] {
    return this.library.items;
  }

  get selectedIds(): readonly string[] {
    return [...this.selectedReferenceIds];
  }

  async getSelectedImageInputs(): Promise<ReferenceImageInput[]> {
    const imageIds = this.items
      .filter((item) => item.type === "image" && this.selectedReferenceIds.has(item.id))
      .map((item) => item.id);
    return this.library.getImageInputs(imageIds);
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
    bind("reference-gen-btn", "click", () => this.guard(
      () => this.generateReferenceImage(),
      "AI 이미지 생성 실패",
    ));
    bind("reference-video-btn", "click", () => this.guard(
      () => this.generateReferenceVideo(),
      "AI 영상 생성 실패",
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
    const additions = await this.library.addEntries(entries, notes, {
      source: valueOf("reference-source-input"),
      tags: valueOf("reference-tags-input"),
    });
    this.stagedEntries = [];
    element<HTMLTextAreaElement>("reference-notes-input").value = "";
    element<HTMLInputElement>("reference-source-input").value = "";
    element<HTMLInputElement>("reference-tags-input").value = "";
    this.updateStagedUI();
    this.render();
    this.options.onActivity?.(`${additions.length}개 레퍼런스를 보드에 추가했습니다.`);
  }

  private async generateReferenceImage(): Promise<void> {
    if (!this.options.generatedImageProvider) {
      throw new Error("이미지 생성 콜백이 연결되지 않았습니다. index.ts에서 generatedImageProvider를 주입해 주세요.");
    }
    // UXP <select>/<textarea>는 사용자가 건드리기 전 .value가 undefined일 수 있어 방어적으로 읽는다.
    const prompt = (element<HTMLTextAreaElement>("reference-gen-prompt-input").value ?? "").trim();
    if (!prompt) {
      throw new Error("생성할 이미지를 설명하는 프롬프트를 입력해 주세요.");
    }
    const size = (element<HTMLSelectElement>("reference-gen-size-select").value ?? "").trim() || "1024x1024";
    const button = element<HTMLButtonElement>("reference-gen-btn");
    button.disabled = true;
    try {
      // 포트 반환값은 신뢰하지 않는다 — addEntries가 파일 엔트리·형식·중복을 다시 검증한다.
      const entry = await this.options.generatedImageProvider(prompt, size);
      const additions = await this.library.addEntries([entry], `[AI 생성] ${prompt}`, {
        source: "AI 생성 (gpt-image-2)",
        tags: "ai-생성",
      });
      element<HTMLTextAreaElement>("reference-gen-prompt-input").value = "";
      this.render();
      this.options.onActivity?.(`AI 이미지 ${additions.length}개를 레퍼런스로 추가했습니다.`);
    } finally {
      button.disabled = false;
    }
  }

  private async generateReferenceVideo(): Promise<void> {
    if (!this.options.generatedVideoProvider) {
      throw new Error("영상 생성 콜백이 연결되지 않았습니다. index.ts에서 generatedVideoProvider를 주입해 주세요.");
    }
    const prompt = (element<HTMLTextAreaElement>("reference-gen-prompt-input").value ?? "").trim();
    if (!prompt) {
      throw new Error("생성할 영상을 설명하는 프롬프트를 입력해 주세요.");
    }
    const seconds = (element<HTMLSelectElement>("reference-video-seconds-select").value ?? "").trim() || "8";
    const button = element<HTMLButtonElement>("reference-video-btn");
    button.disabled = true;
    try {
      this.options.onActivity?.("AI 영상 생성을 시작했습니다. 수 분이 걸릴 수 있습니다…");
      const entry = await this.options.generatedVideoProvider(prompt, seconds);
      const additions = await this.library.addEntries([entry], `[AI 생성] ${prompt}`, {
        source: "AI 생성 (Sora)",
        tags: "ai-생성, 영상",
      });
      element<HTMLTextAreaElement>("reference-gen-prompt-input").value = "";
      this.render();
      this.options.onActivity?.(`AI 영상 ${additions.length}개를 레퍼런스로 추가했습니다.`);
    } finally {
      button.disabled = false;
    }
  }

  private setReferenceSelected(item: ReferenceItem, checked: boolean): void {
    if (checked && !this.selectedReferenceIds.has(item.id)) {
      if (this.selectedReferenceIds.size >= MAX_REFERENCE_PROMPT_ITEMS) {
        throw new Error(`AI 참고 레퍼런스는 최대 ${MAX_REFERENCE_PROMPT_ITEMS}개까지 선택할 수 있습니다.`);
      }
      const selectedImageCount = this.items
        .filter((candidate) => candidate.type === "image" && this.selectedReferenceIds.has(candidate.id))
        .length;
      if (item.type === "image" && selectedImageCount >= MAX_IMAGE_INPUTS) {
        throw new Error(`AI 입력 레퍼런스는 최대 ${MAX_IMAGE_INPUTS}개까지 선택할 수 있습니다.`);
      }
      this.selectedReferenceIds.add(item.id);
    } else if (!checked) {
      this.selectedReferenceIds.delete(item.id);
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

    const meta = document.createElement("small");
    meta.className = "reference-meta";
    meta.textContent = [
      item.source ? `출처: ${item.source}` : "",
      item.tags.length > 0 ? `태그: ${tagsText(item.tags)}` : "",
    ].filter(Boolean).join(" · ");
    if (meta.textContent) copy.append(meta);

    const source = document.createElement("input");
    source.className = "reference-source-editor";
    source.value = item.source;
    source.maxLength = 512;
    source.placeholder = "출처";
    source.setAttribute("aria-label", `${item.name} 출처`);

    const notes = document.createElement("textarea");
    notes.className = "reference-notes-editor";
    notes.value = item.notes;
    notes.maxLength = 1_000;
    notes.rows = 2;
    notes.placeholder = "활용 메모";
    notes.setAttribute("aria-label", `${item.name} 활용 메모`);
    const tags = document.createElement("input");
    tags.className = "reference-tags-editor";
    tags.value = tagsText(item.tags);
    tags.maxLength = 512;
    tags.placeholder = "태그";
    tags.setAttribute("aria-label", `${item.name} 태그`);
    const saveMetadata = () => void this.guard(async () => {
      await this.library.updateMetadata(item.id, {
        notes: notes.value,
        source: source.value,
        tags: tags.value,
      });
      this.render();
      this.options.onActivity?.(`${item.name} 메타데이터를 저장했습니다.`);
    }, "레퍼런스 메타데이터 저장 실패");
    notes.addEventListener("change", saveMetadata);
    source.addEventListener("change", saveMetadata);
    tags.addEventListener("change", saveMetadata);

    const enrichRow = document.createElement("div");
    enrichRow.className = "reference-enrich-row";
    const enrichBtn = document.createElement("button");
    enrichBtn.type = "button";
    enrichBtn.className = "reference-enrich-btn";
    enrichBtn.textContent = "AI 보강";
    enrichBtn.disabled = !this.options.enrichPromptProvider;
    enrichBtn.setAttribute("aria-label", `${item.name} 활용 메모 AI 보강`);
    enrichBtn.addEventListener("click", () => void this.guard(async () => {
      const provider = this.options.enrichPromptProvider;
      if (!provider) return;
      if (!notes.value.trim()) throw new Error("보강할 활용 메모를 먼저 입력해 주세요.");
      enrichBtn.disabled = true;
      let enriched: string;
      try {
        enriched = await provider(notes.value);
      } finally {
        enrichBtn.disabled = false;
      }
      enrichRow.querySelector(".reference-enrich-preview")?.remove();
      const preview = document.createElement("div");
      preview.className = "reference-enrich-preview";
      const previewText = document.createElement("p");
      previewText.textContent = enriched;
      const applyBtn = document.createElement("button");
      applyBtn.type = "button";
      applyBtn.className = "reference-enrich-apply-btn";
      applyBtn.textContent = "적용";
      applyBtn.addEventListener("click", () => {
        notes.value = enriched;
        saveMetadata();
      });
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "reference-enrich-cancel-btn";
      cancelBtn.textContent = "취소";
      cancelBtn.addEventListener("click", () => preview.remove());
      preview.append(previewText, applyBtn, cancelBtn);
      enrichRow.append(preview);
    }, "AI 프롬프트 보강 실패"));
    enrichRow.append(enrichBtn);

    const actions = document.createElement("div");
    actions.className = "reference-card-actions";
    if (!item.unavailable) {
      const selectLabel = document.createElement("label");
      selectLabel.className = "reference-ai-select";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = this.selectedReferenceIds.has(item.id);
      checkbox.setAttribute("aria-label", item.type === "image"
        ? `${item.name}을 AI 이미지 입력으로 선택`
        : `${item.name}을 AI 프롬프트 참고로 선택`);
      checkbox.addEventListener("change", () => {
        try {
          this.setReferenceSelected(item, checkbox.checked);
        } catch (error) {
          checkbox.checked = false;
          this.options.onError?.(error, "AI 레퍼런스 선택 실패");
        }
      });
      const labelText = document.createElement("span");
      labelText.textContent = item.type === "image" ? "AI 입력" : "AI 프롬프트";
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
      this.selectedReferenceIds.delete(item.id);
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

    card.append(this.previewFor(item), copy, source, tags, notes, enrichRow, actions);
    return card;
  }

  private render(): void {
    const target = element<HTMLElement>("reference-list");
    const items = this.library.items;
    // Premiere 26.3 UXP can leave stale children behind after replaceChildren().
    while (target.firstChild) target.removeChild(target.firstChild);
    if (items.length === 0) {
      renderEmptyState(target, "등록된 레퍼런스가 없습니다", "이미지 또는 동영상 파일을 선택해 보드에 추가해 주세요.");
      return;
    }
    items.forEach((item, index) => target.append(this.renderCard(item, index)));
  }
}
