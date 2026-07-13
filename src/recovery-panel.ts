// 복구 저널 목록 렌더와 복제 시퀀스 제거(fail-closed 확인 모달) UI를 담당하는 패널 모듈
import { confirmDestructiveRecovery, type OperationJournalEntry, type RecoveryManager } from "./recovery";
import { optionalElement, setText, toast } from "./ui";

export interface RecoveryPanelOptions {
  /** 전역 매니저는 bootstrap에서 늦게 할당되므로 값이 아니라 getter로 주입한다. */
  getManager: () => RecoveryManager | null;
  removeClone: (sourceId: string, cloneId: string) => Promise<void>;
  onActivity: (level: "info" | "success" | "warning", message: string) => void;
  onError: (error: unknown, context: string) => void;
}

interface UxpRecoveryDialogElement extends HTMLDialogElement {
  uxpShowModal?: (options: {
    title: string;
    resize: "none";
    size: { width: number; height: number };
  }) => Promise<unknown>;
}

function recoveryStatusLabel(status: OperationJournalEntry["status"]): string {
  return {
    running: "실행 중",
    committed: "완료",
    failed: "실패",
    "rolling-back": "복구 중",
    "rolled-back": "복구 완료",
    "rollback-failed": "복구 실패",
    interrupted: "중단됨",
  }[status];
}

async function requestRecoveryRollbackConfirmation(entry: OperationJournalEntry): Promise<boolean> {
  const dialog = optionalElement<UxpRecoveryDialogElement>("recovery-confirm-dialog");
  const label = optionalElement<HTMLElement>("recovery-confirm-label");
  const approve = optionalElement<HTMLButtonElement>("recovery-confirm-approve-btn");
  const cancel = optionalElement<HTMLButtonElement>("recovery-confirm-cancel-btn");
  if (!dialog || !label || !approve || !cancel || typeof dialog.uxpShowModal !== "function") {
    return false;
  }

  label.textContent = entry.label;
  const approveHandler = (): void => dialog.close("confirm");
  const cancelHandler = (): void => dialog.close("cancel");
  approve.addEventListener("click", approveHandler);
  cancel.addEventListener("click", cancelHandler);
  try {
    return await confirmDestructiveRecovery(
      dialog.uxpShowModal.bind(dialog),
      {
        title: "ShortFlow Studio · 복제 시퀀스 제거",
        resize: "none",
        size: { width: 420, height: 300 },
      },
    );
  } finally {
    approve.removeEventListener("click", approveHandler);
    cancel.removeEventListener("click", cancelHandler);
  }
}

export function createRecoveryPanel(options: RecoveryPanelOptions): { render(): void } {
  let rollbackPending = false;

  async function rollbackEntry(entry: OperationJournalEntry): Promise<void> {
    const manager = options.getManager();
    if (!manager) return;
    if (rollbackPending) return;
    rollbackPending = true;
    try {
      if (!await requestRecoveryRollbackConfirmation(entry)) {
        options.onActivity("warning", "명시적 확인을 받지 못해 복제 시퀀스 제거를 취소했습니다.");
        return;
      }
      await manager.rollback(entry.operationId, () => options.removeClone(
        entry.clonePolicy.sourceId,
        entry.clonePolicy.cloneId,
      ));
      options.onActivity("success", `복제 시퀀스 복구 완료: ${entry.label}`);
      toast("원본을 유지하고 복제 시퀀스를 제거했습니다.", "success");
    } catch (error) {
      options.onError(error, "복제 시퀀스 복구 실패");
    } finally {
      rollbackPending = false;
      render();
    }
  }

  function render(): void {
    const target = optionalElement<HTMLElement>("recovery-list");
    if (!target) return;
    // Premiere 26.3 UXP can leave stale children behind after replaceChildren().
    // Remove explicitly so preview/selection rerenders never duplicate asset cards.
    while (target.firstChild) target.removeChild(target.firstChild);
    const entries = options.getManager()?.list().sort((left, right) => right.createdAt - left.createdAt) ?? [];
    setText("recovery-count", `${entries.length} / 50`);
    if (entries.length === 0) {
      const empty = document.createElement("p");
      empty.className = "action-note";
      empty.textContent = "기록된 비파괴 작업이 없습니다.";
      target.append(empty);
      return;
    }
    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = `recovery-row is-${entry.status}`;
      const copy = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = `${entry.label} · ${recoveryStatusLabel(entry.status)}`;
      const details = document.createElement("span");
      details.textContent = `${entry.preview.changes.length}개 변경 · 원본 ${entry.originalPreserved ? "보존" : "확인 필요"}${entry.error ? ` · ${entry.error}` : ""}`;
      const guidance = document.createElement("small");
      guidance.textContent = entry.recoveryGuidance;
      copy.append(title, details, guidance);
      row.append(copy);
      if (["committed", "failed", "interrupted", "rollback-failed"].includes(entry.status)) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "danger-button small-button";
        button.textContent = "복제본 제거";
        button.addEventListener("click", () => void rollbackEntry(entry));
        row.append(button);
      }
      target.append(row);
    }
  }

  return { render };
}
