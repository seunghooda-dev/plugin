// 음악·효과음 자산 브라우저(루트 선택·동기화·검색·폴더 열기·미리듣기·타임라인 삽입·순서 저장) UI를 담당하는 패널 모듈
import {
  ASSET_DRAG_PAYLOAD_MIME,
  AssetLibrary,
  AssetLibraryError,
  applyAssetOrder,
  createAssetDragPayload,
  createDefaultAssetLibraryAdapter,
  filterAssets,
  listAudioAssetCategories,
  normalizeAssetOrder,
  normalizeNativePath,
  readAssetPreviewBytes,
  reorderAssetIds,
  resolveAudioAssetDragTarget,
  type AssetFolderOpenResult,
  type AssetItem,
} from "./asset-library";
import type { AssetRightsRegistry } from "./asset-rights";
import { element, numberOf, optionalElement, renderEmptyState, setText, toast, valueOf } from "./ui";

const ASSET_ORDER_STORAGE_KEY = "shortflow.assetOrder.v1";
const ASSET_REORDER_MIME = "application/x-shortflow-asset-order";

export interface AssetBrowserPanelOptions {
  runBusy: <T>(message: string, task: () => Promise<T>) => Promise<T>;
  onActivity: (level: "info" | "success" | "warning", message: string) => void;
  onError: (error: unknown, context: string) => void;
  /** 활동 로그 문자열용 오류 포맷터 — index.ts가 src/premiere.ts의 errorMessage를 주입한다. */
  formatError: (error: unknown) => string;
  /** 자산 루트 이름은 index.ts가 소유한 settings에 남으므로 getter/setter/persist로 주입한다. */
  getAssetRootName: () => string;
  setAssetRootName: (name: string) => void;
  persistSettings: () => void;
  /** 권리 레지스트리는 최종 QC·TTS 자동 기록과 공유되므로 index.ts 소유를 유지한다. */
  ensureRightsRegistry: () => AssetRightsRegistry;
  renderRights: (asset: AssetItem | null) => void;
  /** Premiere 타임라인 삽입 — src/premiere.ts의 importAndInsertAsset을 index.ts가 주입한다. */
  insertToTimeline: (nativePath: string, options: {
    videoTrackIndex: number;
    audioTrackIndex: number;
    displayName: string;
  }) => Promise<void>;
  /** 인라인 오디오 미지원 시 Premiere 소스 모니터 미리듣기 — Host 호출은 index.ts에 남는다. */
  previewInSourceMonitor: (asset: AssetItem) => Promise<boolean>;
}

function loadAssetOrder(): string[] {
  try {
    return normalizeAssetOrder(JSON.parse(localStorage.getItem(ASSET_ORDER_STORAGE_KEY) ?? "[]"));
  } catch {
    return [];
  }
}

function audioMimeType(asset: AssetItem): string {
  switch (asset.extension) {
    case ".aac": return "audio/aac";
    case ".aif":
    case ".aiff": return "audio/aiff";
    case ".flac": return "audio/flac";
    case ".m4a": return "audio/mp4";
    case ".mp3": return "audio/mpeg";
    case ".ogg": return "audio/ogg";
    case ".wav": return "audio/wav";
    case ".wma": return "audio/x-ms-wma";
    default: return "audio/*";
  }
}

async function assetBytes(asset: AssetItem): Promise<Uint8Array> {
  const uxpRoot = require("uxp") as any;
  return readAssetPreviewBytes(asset, uxpRoot?.storage?.formats?.binary);
}

function setAssetRootUI(name: string, enabled: boolean): void {
  setText("asset-root-name", name || "선택되지 않음", name);
  const open = optionalElement<HTMLButtonElement>("open-asset-root-btn");
  if (open) open.disabled = !enabled;
  const categoryOpen = optionalElement<HTMLButtonElement>("open-asset-category-btn");
  if (categoryOpen) categoryOpen.disabled = !enabled;
}

export function createAssetBrowserPanel(options: AssetBrowserPanelOptions): {
  initialize(): Promise<void>;
  render(): void;
  sync(): Promise<void>;
  chooseRoot(): Promise<void>;
  openRoot(): Promise<void>;
  openCategory(): Promise<void>;
  setupDropZone(): void;
  clearPreview(): void;
  getAssets(): readonly AssetItem[];
  getSelectedAssetId(): string;
  getSelectedAsset(): AssetItem | null;
  openAssetFile(asset: AssetItem): Promise<void>;
} {
  let assets: AssetItem[] = [];
  let assetOrder: string[] = [];
  let assetPreviewUrl = "";
  let selectedAssetId = "";
  let assetLibrary: AssetLibrary | null = null;

  function ensureLibrary(): AssetLibrary {
    if (!assetLibrary) {
      assetLibrary = new AssetLibrary(createDefaultAssetLibraryAdapter({ allowFolderLaunch: true }));
    }
    return assetLibrary;
  }

  function saveAssetOrder(): void {
    assetOrder = normalizeAssetOrder(assetOrder, assets.map((asset) => asset.normalizedPath));
    try {
      localStorage.setItem(ASSET_ORDER_STORAGE_KEY, JSON.stringify(assetOrder));
    } catch (error) {
      options.onActivity("warning", `자산 순서 저장 실패: ${options.formatError(error)}`);
    }
  }

  async function initialize(): Promise<void> {
    assetOrder = loadAssetOrder();
    try {
      await options.ensureRightsRegistry().load();
      const library = ensureLibrary();
      const root = await library.restoreRoot();
      if (root) {
        options.setAssetRootName(String(root.name ?? options.getAssetRootName()));
        setAssetRootUI(options.getAssetRootName(), true);
      }
    } catch (error) {
      if (error instanceof AssetLibraryError && error.code === "TOKEN_EXPIRED") {
        options.setAssetRootName("");
        setAssetRootUI("", false);
        options.persistSettings();
        options.onActivity("warning", error.message);
        return;
      }
      options.onActivity("warning", `자산 라이브러리 복원 실패: ${options.formatError(error)}`);
    }
  }

  async function chooseRoot(): Promise<void> {
    const root = await options.runBusy("자산 라이브러리 폴더를 준비하고 있습니다…", () => ensureLibrary().selectRoot());
    options.setAssetRootName(String(root.name ?? "자산 라이브러리"));
    setAssetRootUI(options.getAssetRootName(), true);
    options.persistSettings();
    options.onActivity("success", `자산 루트 선택: ${options.getAssetRootName()}`);
    await sync();
  }

  async function reportAssetFolderOpen(result: AssetFolderOpenResult, label: string): Promise<void> {
    if (result.mode === "system-folder") {
      options.onActivity("info", `시스템 파일 탐색기에서 ${label} 폴더를 열었습니다.`);
      return;
    }
    if (result.selection) {
      const normalizedPath = normalizeNativePath(result.selection.nativePath);
      let selected = assets.find((asset) => asset.kind === "audio" && asset.normalizedPath === normalizedPath);
      if (!selected) {
        await sync();
        selected = assets.find((asset) => asset.kind === "audio" && asset.normalizedPath === normalizedPath);
      }
      if (!selected) {
        options.onActivity("warning", `${label} 폴더에서 선택한 오디오가 동기화 목록에 없습니다: ${result.selection.name}`);
        toast("라이브러리 폴더 안의 오디오를 선택한 뒤 다시 동기화해 주세요.", "warning");
        return;
      }
      selectedAssetId = selected.id;
      render();
      options.renderRights(selected);
      const list = optionalElement<HTMLElement>("asset-list");
      const selectedCard = Array.from(list?.children ?? []).find((child) =>
        (child as HTMLElement).dataset.assetId === selected?.id,
      ) as HTMLElement | undefined;
      selectedCard?.focus();
      options.onActivity("info", `${label} 폴더 파일 선택기에서 오디오를 선택했습니다: ${selected.name}`);
      toast("선택한 오디오를 목록에서 선택했습니다. 미리듣거나 타임라인에 삽입할 수 있습니다.", "success");
      return;
    }
    options.onActivity("info", `${label} 폴더 찾아보기를 취소했습니다.`);
  }

  async function openRoot(): Promise<void> {
    await reportAssetFolderOpen(await ensureLibrary().openRootFolder(), "자산 루트");
  }

  async function openCategory(): Promise<void> {
    const category = optionalElement<HTMLSelectElement>("asset-category-select")?.value ?? "all";
    if (category === "all") {
      await openRoot();
      return;
    }
    await reportAssetFolderOpen(await ensureLibrary().openRelativeFolder(category), category);
  }

  function filteredAudioAssets(): AssetItem[] {
    const query = valueOf("asset-search-input");
    const filter = valueOf("asset-type-select");
    const category = optionalElement<HTMLSelectElement>("asset-category-select")?.value ?? "all";
    const visible = filterAssets(assets, { query, kind: "audio" }).filter((asset) => {
      const folder = asset.folderPath.toLocaleLowerCase();
      if (filter === "music") return folder === "music" || folder.startsWith("music/");
      if (filter === "sfx") return folder === "sfx" || folder.startsWith("sfx/");
      return true;
    }).filter((asset) => {
      if (category === "all") return true;
      const folder = normalizeNativePath(asset.folderPath);
      return folder === category || folder.startsWith(`${category}/`);
    });
    return applyAssetOrder(visible, assetOrder);
  }

  function renderAssetCategories(): void {
    const select = optionalElement<HTMLSelectElement>("asset-category-select");
    if (!select) return;
    const current = select.value || "all";
    const filter = valueOf("asset-type-select");
    const categories = listAudioAssetCategories(assets).filter((category) => {
      if (filter === "music") return category.root === "music";
      if (filter === "sfx") return category.root === "sfx";
      return true;
    });
    select.replaceChildren();
    const all = document.createElement("option");
    all.value = "all";
    all.textContent = "전체 폴더";
    select.append(all);
    for (const category of categories) {
      const option = document.createElement("option");
      option.value = category.id;
      option.textContent = `${category.label} (${category.count})`;
      select.append(option);
    }
    select.disabled = categories.length === 0;
    select.value = categories.some((category) => category.id === current) ? current : "all";
    const openButton = optionalElement<HTMLButtonElement>("open-asset-category-btn");
    if (openButton) openButton.disabled = !options.getAssetRootName();
  }

  function assetFromDragPayload(dataTransfer: DataTransfer | null): AssetItem | null {
    return resolveAudioAssetDragTarget(
      assets,
      dataTransfer?.getData(ASSET_DRAG_PAYLOAD_MIME),
    );
  }

  function render(): void {
    renderAssetCategories();
    const target = element<HTMLElement>("asset-list");
    const visible = filteredAudioAssets();
    if (!visible.length) {
      renderEmptyState(target, "조건에 맞는 음악·효과음이 없습니다", "폴더에 WAV, MP3, AIFF 또는 M4A 파일을 넣고 동기화해 주세요.");
      return;
    }
    target.replaceChildren();
    for (const asset of visible) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = `asset-card draggable-card${asset.id === selectedAssetId ? " is-selected" : ""}`;
      card.draggable = true;
      card.dataset.assetId = asset.id;
      card.setAttribute("role", "listitem");
      card.setAttribute("aria-label", `${asset.name}, 현재 재생 위치에 삽입하려면 두 번 누르세요.`);
      const icon = document.createElement("span");
      icon.className = "asset-kind-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = asset.folderPath.toLocaleLowerCase().startsWith("music") ? "♪" : "SFX";
      const copy = document.createElement("span");
      copy.className = "asset-card-copy";
      const title = document.createElement("strong");
      title.textContent = asset.name;
      const path = document.createElement("small");
      path.textContent = asset.relativePath;
      copy.append(title, path);
      const actions = document.createElement("span");
      actions.className = "asset-card-actions";
      const preview = document.createElement("span");
      preview.className = "asset-preview-action";
      preview.textContent = "미리듣기";
      preview.setAttribute("role", "button");
      preview.setAttribute("tabindex", "0");
      preview.setAttribute("aria-label", `${asset.name} 미리듣기`);
      preview.addEventListener("click", (event) => {
        event.stopPropagation();
        void previewAsset(asset).catch((error) => options.onError(error, "자산 미리듣기 실패"));
      });
      preview.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        void previewAsset(asset).catch((error) => options.onError(error, "자산 미리듣기 실패"));
      });
      const hint = document.createElement("span");
      hint.className = "drag-hint";
      hint.textContent = "↕";
      hint.title = "드래그해서 목록 순서 이동";
      actions.append(preview, hint);
      card.append(icon, copy, actions);
      card.addEventListener("click", () => {
        selectedAssetId = asset.id;
        render();
        options.renderRights(asset);
      });
      card.addEventListener("dblclick", () => void insertAsset(asset));
      card.addEventListener("dragover", (event) => {
        if (!event.dataTransfer?.types.includes(ASSET_REORDER_MIME)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      });
      card.addEventListener("drop", (event) => {
        const draggedId = event.dataTransfer?.getData(ASSET_REORDER_MIME);
        if (!draggedId) return;
        event.preventDefault();
        assetOrder = reorderAssetIds(
          assetOrder,
          visible.map((item) => item.normalizedPath),
          draggedId,
          asset.normalizedPath,
        );
        saveAssetOrder();
        render();
        options.onActivity("success", "음악·효과음 목록 순서를 저장했습니다.");
      });
      card.addEventListener("dragstart", (event) => {
        selectedAssetId = asset.id;
        card.classList.add("is-dragging");
        try {
          event.dataTransfer?.setData(ASSET_DRAG_PAYLOAD_MIME, createAssetDragPayload(asset));
          event.dataTransfer?.setData(ASSET_REORDER_MIME, asset.normalizedPath);
          if (event.dataTransfer) event.dataTransfer.effectAllowed = "copyMove";
        } catch (error) {
          event.preventDefault();
          options.onError(error, "자산 드래그 준비 실패");
        }
      });
      card.addEventListener("dragend", () => card.classList.remove("is-dragging"));
      target.append(card);
    }
  }

  async function sync(): Promise<void> {
    assets = await options.runBusy("음악·효과음 폴더를 동기화하고 있습니다…", () => ensureLibrary().sync());
    assetOrder = normalizeAssetOrder(assetOrder, assets.map((asset) => asset.normalizedPath));
    saveAssetOrder();
    if (selectedAssetId && !assets.some((asset) => asset.id === selectedAssetId)) {
      selectedAssetId = "";
    }
    render();
    options.renderRights(assets.find((asset) => asset.id === selectedAssetId) ?? null);
    const audioCount = assets.filter((asset) => asset.kind === "audio").length;
    const stats = ensureLibrary().lastSyncStats;
    options.onActivity(stats.truncated ? "warning" : "success", `자산 동기화 완료 · 오디오 ${audioCount}개 · 전체 ${assets.length}개${stats.truncated ? " · 안전 제한 도달" : ""}`);
    toast(`음악·효과음 ${audioCount}개를 동기화했습니다.`, stats.truncated ? "warning" : "success");
  }

  function clearPreview(): void {
    const audio = optionalElement<HTMLAudioElement>("asset-audio-preview");
    if (audio) {
      if (typeof audio.pause === "function") audio.pause();
      audio.removeAttribute("src");
      audio.hidden = true;
      if (typeof audio.load === "function") audio.load();
    }
    if (assetPreviewUrl) {
      URL.revokeObjectURL(assetPreviewUrl);
      assetPreviewUrl = "";
    }
  }

  async function previewAsset(asset: AssetItem): Promise<void> {
    const audio = element<HTMLAudioElement>("asset-audio-preview");
    const supportsInlineAudio = typeof audio.pause === "function" &&
      typeof audio.load === "function" &&
      typeof audio.play === "function" &&
      typeof URL.createObjectURL === "function";
    if (!supportsInlineAudio) {
      const autoPlayed = await options.runBusy(
        `${asset.name}을 Premiere 소스 모니터에서 열고 있습니다…`,
        () => options.previewInSourceMonitor(asset),
      );
      selectedAssetId = asset.id;
      render();
      options.renderRights(asset);
      options.onActivity("success", `Premiere 소스 모니터 미리듣기: ${asset.name}${autoPlayed ? " · 재생 시작" : " · 재생 버튼을 눌러 주세요"}`);
      toast(autoPlayed
        ? "Premiere 소스 모니터에서 미리듣기를 시작했습니다."
        : "Premiere 소스 모니터에 열었습니다. 소스 모니터 재생 버튼을 눌러 주세요.", "success");
      return;
    }
    const bytes = await options.runBusy(`${asset.name} 미리듣기를 준비하고 있습니다…`, () => assetBytes(asset));
    clearPreview();
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    assetPreviewUrl = URL.createObjectURL(new Blob([buffer], { type: audioMimeType(asset) }));
    audio.src = assetPreviewUrl;
    audio.hidden = false;
    audio.load();
    await audio.play();
    selectedAssetId = asset.id;
    render();
    options.renderRights(asset);
    options.onActivity("success", `미리듣기: ${asset.name}`);
  }

  async function insertAsset(asset: AssetItem): Promise<void> {
    await options.runBusy(`${asset.name}을(를) 타임라인에 삽입하고 있습니다…`, () => options.insertToTimeline(asset.nativePath, {
      videoTrackIndex: Math.max(0, numberOf("asset-video-track-input", 1) - 1),
      audioTrackIndex: Math.max(0, numberOf("asset-audio-track-input", 2) - 1),
      displayName: asset.name,
    }));
    options.onActivity("success", `자산 삽입: ${asset.name}`);
    toast("현재 재생 위치에 자산을 삽입했습니다.", "success");
  }

  function setupDropZone(): void {
    const zone = optionalElement<HTMLElement>("asset-drop-zone");
    if (!zone) return;
    zone.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      zone.classList.add("is-drag-over");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("is-drag-over"));
    zone.addEventListener("drop", (event) => {
      event.preventDefault();
      zone.classList.remove("is-drag-over");
      const asset = assetFromDragPayload(event.dataTransfer);
      if (!asset) {
        toast("드래그한 자산을 현재 라이브러리에서 검증하지 못했습니다.", "warning");
        return;
      }
      void insertAsset(asset).catch((error) => options.onError(error, "자산 삽입 실패"));
    });
    zone.addEventListener("click", () => {
      const asset = assets.find((candidate) => candidate.id === selectedAssetId);
      if (asset) void insertAsset(asset).catch((error) => options.onError(error, "자산 삽입 실패"));
      else toast("먼저 라이브러리에서 자산을 선택해 주세요.", "warning");
    });
    zone.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") zone.click();
    });
  }

  return {
    initialize,
    render,
    sync,
    chooseRoot,
    openRoot,
    openCategory,
    setupDropZone,
    clearPreview,
    getAssets: () => assets,
    getSelectedAssetId: () => selectedAssetId,
    getSelectedAsset: () => assets.find((candidate) => candidate.id === selectedAssetId) ?? null,
    openAssetFile: (asset) => ensureLibrary().openAssetFile(asset),
  };
}
