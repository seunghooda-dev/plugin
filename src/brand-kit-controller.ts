import {
  BrandKitLibrary,
  DEFAULT_BRAND_KIT,
  createDefaultBrandKitAdapter,
  type BrandKit,
  type BrandKitInput,
  type BrandMogrtPreset,
} from "./brand-kit";
import { bind, checkedOf, clearChildren, element, numberOf, setChecked, setText, setValue, valueOf } from "./ui";

interface UxpFile {
  name?: string;
  nativePath?: string;
  read(options?: { format?: unknown }): Promise<unknown>;
  write(data: string, options?: { format?: unknown }): Promise<unknown>;
}

interface UxpLocalFileSystem {
  getFileForOpening(options?: { types?: string[]; allowMultiple?: boolean }): Promise<UxpFile | UxpFile[] | null>;
  getFileForSaving(name: string, options?: { types?: string[] }): Promise<UxpFile | null>;
  createPersistentToken(entry: UxpFile): Promise<string>;
}

export interface BrandKitControllerOptions {
  library?: BrandKitLibrary;
  onActivity?: (message: string) => void;
  onError?: (error: unknown, context: string) => void;
  onApply?: (kit: BrandKit) => void | Promise<void>;
  getMogrtPreset?: () => BrandMogrtPreset;
}

function localFileSystem(): { fs: UxpLocalFileSystem; utf8: unknown } {
  const uxp = require("uxp") as any;
  const fs = uxp?.storage?.localFileSystem as UxpLocalFileSystem | undefined;
  if (!fs) throw new Error("UXP 파일 시스템을 사용할 수 없습니다.");
  return { fs, utf8: uxp?.storage?.formats?.utf8 };
}

function firstFile(value: UxpFile | UxpFile[] | null): UxpFile | null {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function isTtsModel(value: string): value is BrandKit["tts"]["model"] {
  return value === "gpt-4o-mini-tts" || value === "tts-1-hd" || value === "tts-1";
}

function textFromRead(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  if (ArrayBuffer.isView(value)) return new TextDecoder().decode(value as ArrayBufferView);
  throw new Error("브랜드 키트 JSON 파일을 텍스트로 읽지 못했습니다.");
}

export class BrandKitController {
  private readonly library: BrandKitLibrary;
  private logo = { token: "", name: "" };
  private initialized = false;

  constructor(private readonly options: BrandKitControllerOptions = {}) {
    this.library = options.library ?? new BrandKitLibrary(createDefaultBrandKitAdapter());
  }

  get activeKit(): BrandKit | null { return this.library.activeKit; }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    this.bindEvents();
    await this.library.load();
    if (this.library.kits.length === 0) await this.library.create(DEFAULT_BRAND_KIT);
    this.render();
  }

  private bindEvents(): void {
    bind("brand-kit-select", "change", () => this.guard(async () => {
      const kit = await this.library.setActive(valueOf("brand-kit-select") || null);
      if (kit) this.loadControls(kit);
      this.render();
    }, "브랜드 키트 선택 실패"));
    bind("brand-kit-new-btn", "click", () => this.guard(() => this.create(), "브랜드 키트 생성 실패"));
    bind("brand-kit-save-btn", "click", () => this.guard(() => this.save(), "브랜드 키트 저장 실패"));
    bind("brand-kit-duplicate-btn", "click", () => this.guard(() => this.duplicate(), "브랜드 키트 복제 실패"));
    bind("brand-kit-delete-btn", "click", () => this.guard(() => this.remove(), "브랜드 키트 삭제 실패"));
    bind("brand-kit-apply-btn", "click", () => this.guard(() => this.apply(), "브랜드 키트 적용 실패"));
    bind("brand-kit-import-btn", "click", () => this.guard(() => this.importJson(), "브랜드 키트 가져오기 실패"));
    bind("brand-kit-export-btn", "click", () => this.guard(() => this.exportJson(), "브랜드 키트 내보내기 실패"));
    bind("brand-logo-btn", "click", () => this.guard(() => this.chooseLogo(), "브랜드 로고 선택 실패"));
  }

  private async guard(task: () => void | Promise<void>, context: string): Promise<void> {
    try { await task(); } catch (error) { this.options.onError?.(error, context); }
  }

  private render(): void {
    const select = element<HTMLSelectElement>("brand-kit-select");
    clearChildren(select);
    for (const kit of this.library.kits) {
      const option = document.createElement("option");
      option.value = kit.id;
      option.textContent = kit.name;
      option.selected = kit.id === this.library.activeKitId;
      select.append(option);
    }
    const active = this.library.activeKit ?? this.library.kits[0] ?? null;
    if (active && active.id !== this.library.activeKitId) void this.library.setActive(active.id);
    if (active) this.loadControls(active);
    setText("brand-kit-count", `${this.library.kits.length} / 20`);
    element<HTMLButtonElement>("brand-kit-delete-btn").disabled = this.library.kits.length <= 1;
    element<HTMLButtonElement>("brand-kit-duplicate-btn").disabled = !active;
    element<HTMLButtonElement>("brand-kit-apply-btn").disabled = !active;
  }

  private loadControls(kit: BrandKit): void {
    setValue("brand-kit-select", kit.id);
    setValue("brand-name-input", kit.name);
    setValue("brand-font-input", kit.font.family);
    setValue("brand-font-weight-input", kit.font.weight);
    setValue("brand-primary-color", kit.colors.primary);
    setValue("brand-secondary-color", kit.colors.secondary);
    setValue("brand-accent-color", kit.colors.accent);
    setValue("brand-caption-max-input", kit.caption.maxChars);
    setValue("brand-caption-position-select", kit.caption.position);
    setChecked("brand-caption-shadow-checkbox", kit.caption.shadow);
    setChecked("brand-caption-highlight-checkbox", kit.caption.highlight);
    setValue("brand-thumb-layout-select", kit.thumbnail.layout);
    setValue("brand-thumb-background-color", kit.thumbnail.backgroundColor);
    setValue("brand-thumb-text-color", kit.thumbnail.textColor);
    setValue("brand-thumb-brightness-input", kit.thumbnail.brightness);
    setValue("brand-thumb-contrast-input", kit.thumbnail.contrast);
    setValue("brand-thumb-saturation-input", kit.thumbnail.saturation);
    setValue("brand-thumb-shadow-input", kit.thumbnail.shadow);
    setValue("brand-thumb-glow-input", kit.thumbnail.glow);
    setValue("brand-thumb-shadow-color", kit.thumbnail.shadowColor);
    setValue("brand-thumb-glow-color", kit.thumbnail.glowColor);
    setValue("brand-tts-model-select", kit.tts.model);
    setValue("brand-tts-voice-input", kit.tts.voice);
    setValue("brand-tts-speed-input", kit.tts.speed);
    this.logo = { ...kit.logo };
    setText("brand-logo-name", kit.logo.name || "선택되지 않음", kit.logo.name);
    setText("brand-active-name", kit.name);
  }

  private input(): BrandKitInput {
    const model = valueOf("brand-tts-model-select");
    const mogrt = this.options.getMogrtPreset?.() ?? { token: "", name: "", track: 2 };
    return {
      name: valueOf("brand-name-input"),
      font: {
        family: valueOf("brand-font-input"),
        weight: numberOf("brand-font-weight-input", 700),
        fallback: "Arial, sans-serif",
      },
      colors: {
        primary: valueOf("brand-primary-color"),
        secondary: valueOf("brand-secondary-color"),
        accent: valueOf("brand-accent-color"),
      },
      logo: this.logo,
      caption: {
        maxChars: numberOf("brand-caption-max-input", 24),
        position: valueOf("brand-caption-position-select"),
        shadow: checkedOf("brand-caption-shadow-checkbox"),
        highlight: checkedOf("brand-caption-highlight-checkbox"),
      },
      thumbnail: {
        layout: valueOf("brand-thumb-layout-select"),
        backgroundColor: valueOf("brand-thumb-background-color"),
        textColor: valueOf("brand-thumb-text-color"),
        brightness: numberOf("brand-thumb-brightness-input", 100),
        contrast: numberOf("brand-thumb-contrast-input", 100),
        saturation: numberOf("brand-thumb-saturation-input", 100),
        shadow: numberOf("brand-thumb-shadow-input", 0),
        glow: numberOf("brand-thumb-glow-input", 0),
        shadowColor: valueOf("brand-thumb-shadow-color"),
        glowColor: valueOf("brand-thumb-glow-color"),
      },
      tts: {
        model: isTtsModel(model) ? model : "gpt-4o-mini-tts",
        voice: valueOf("brand-tts-voice-input"),
        speed: numberOf("brand-tts-speed-input", 1),
      },
      mogrt,
    };
  }

  private async create(): Promise<void> {
    const kit = await this.library.create({ name: `브랜드 키트 ${this.library.kits.length + 1}` });
    await this.library.setActive(kit.id);
    this.render();
    this.options.onActivity?.(`브랜드 키트를 만들었습니다: ${kit.name}`);
  }

  private async save(): Promise<void> {
    const active = this.library.activeKit;
    if (!active) throw new Error("저장할 브랜드 키트를 선택해 주세요.");
    const updated = await this.library.update(active.id, this.input());
    this.render();
    this.options.onActivity?.(`브랜드 키트를 저장했습니다: ${updated.name}`);
  }

  private async duplicate(): Promise<void> {
    const active = this.library.activeKit;
    if (!active) throw new Error("복제할 브랜드 키트를 선택해 주세요.");
    const duplicate = await this.library.duplicate(active.id);
    await this.library.setActive(duplicate.id);
    this.render();
    this.options.onActivity?.(`브랜드 키트를 복제했습니다: ${duplicate.name}`);
  }

  private async remove(): Promise<void> {
    const active = this.library.activeKit;
    if (!active) return;
    if (this.library.kits.length <= 1) throw new Error("최소 한 개의 브랜드 키트는 유지해야 합니다.");
    await this.library.remove(active.id);
    await this.library.setActive(this.library.kits[0]?.id ?? null);
    this.render();
    this.options.onActivity?.(`브랜드 키트를 삭제했습니다: ${active.name}`);
  }

  private async apply(): Promise<void> {
    await this.save();
    const active = this.library.activeKit;
    if (!active) throw new Error("적용할 브랜드 키트가 없습니다.");
    await this.options.onApply?.(active);
    this.options.onActivity?.(`브랜드 키트를 현재 작업에 적용했습니다: ${active.name}`);
  }

  private async chooseLogo(): Promise<void> {
    const { fs } = localFileSystem();
    const file = firstFile(await fs.getFileForOpening({ types: ["png", "jpg", "jpeg", "webp"], allowMultiple: false }));
    if (!file) return;
    this.logo = { token: await fs.createPersistentToken(file), name: String(file.name ?? "브랜드 로고") };
    setText("brand-logo-name", this.logo.name, file.nativePath ?? this.logo.name);
  }

  private async exportJson(): Promise<void> {
    const active = this.library.activeKit;
    if (!active) throw new Error("내보낼 브랜드 키트를 선택해 주세요.");
    const { fs, utf8 } = localFileSystem();
    const file = await fs.getFileForSaving(`${active.name.replace(/[^\p{L}\p{N}._-]+/gu, "_")}_ShortFlow.json`, { types: ["json"] });
    if (!file) return;
    await file.write(this.library.exportJSON([active.id]), { format: utf8 });
    this.options.onActivity?.(`브랜드 키트 JSON을 저장했습니다: ${String(file.name ?? active.name)}`);
  }

  private async importJson(): Promise<void> {
    const { fs, utf8 } = localFileSystem();
    const file = firstFile(await fs.getFileForOpening({ types: ["json"], allowMultiple: false }));
    if (!file) return;
    const imported = await this.library.importJSON(textFromRead(await file.read({ format: utf8 })), { preserveIds: false });
    const first = imported[0];
    if (first) await this.library.setActive(first.id);
    this.render();
    this.options.onActivity?.(`브랜드 키트 ${imported.length}개를 가져왔습니다. 파일 권한 토큰은 보안을 위해 제외됩니다.`);
  }
}

