// AI 설정 탭의 연결 상태 배지, API 키 저장(secureStorage), 연결 테스트 UI를 담당하는 패널 모듈
import type { OpenAIImageClient } from "./ai";
import { element, optionalElement, toast } from "./ui";

export interface AiSettingsPanelOptions {
  /** 클라이언트는 index.ts가 소유·재생성(썸네일 AI와 공유)하므로 팩토리로 주입한다. */
  createClient: () => OpenAIImageClient;
  ensureConsent: () => void;
  onActivity: (level: "success" | "warning", message: string) => void;
  onError: (error: unknown, context: string) => void;
}

export function setConnectionStatus(
  id: "ai-status" | "speech-status",
  status: "idle" | "connected" | "error",
  message: string,
): void {
  const target = optionalElement<HTMLElement>(id);
  if (!target) return;
  target.classList.toggle("is-idle", status === "idle");
  target.classList.toggle("is-connected", status === "connected");
  target.classList.toggle("is-error", status === "error");
  target.dataset.status = status;
  const label = target.querySelector<HTMLElement>("span:last-child");
  if (label) label.textContent = message;
}

export function createAiSettingsPanel(options: AiSettingsPanelOptions): {
  initialize(): Promise<void>;
  save(): Promise<void>;
  test(): Promise<void>;
} {
  async function initialize(): Promise<void> {
    try {
      const client = options.createClient();
      const storedKey = await client.getApiKey();
      const input = optionalElement<HTMLInputElement>("ai-api-key-input");
      if (input) input.placeholder = storedKey ? "저장된 API 키 유지" : "API 키 입력";
      const state = storedKey ? "connected" : "idle";
      const message = storedKey ? "API 키 저장됨" : "API 키 필요";
      setConnectionStatus("ai-status", state, message);
      setConnectionStatus("speech-status", state, message);
    } catch (error) {
      setConnectionStatus("ai-status", "error", "AI 설정 오류");
      setConnectionStatus("speech-status", "error", "AI 설정 오류");
      options.onError(error, "AI 설정 초기화 실패");
    }
  }

  async function save(): Promise<void> {
    const client = options.createClient();
    const input = element<HTMLInputElement>("ai-api-key-input");
    if (input.value.trim()) {
      await client.setApiKey(input.value);
      input.value = "";
    }
    const hasKey = Boolean(await client.getApiKey());
    input.placeholder = hasKey ? "저장된 API 키 유지" : "API 키 입력";
    setConnectionStatus("ai-status", hasKey ? "connected" : "idle", hasKey ? "설정 저장됨" : "API 키 필요");
    setConnectionStatus("speech-status", hasKey ? "connected" : "idle", hasKey ? "AI 연결 준비됨" : "AI 설정 필요");
    options.onActivity("success", "AI 연결 설정을 저장했습니다. API 키는 UXP 보안 저장소에만 보관됩니다.");
    toast("AI 설정을 저장했습니다.", "success");
  }

  async function test(): Promise<void> {
    const button = optionalElement<HTMLButtonElement>("ai-test-btn");
    const originalText = button?.textContent?.trim() || "연결 테스트";
    if (button) {
      button.classList.remove("is-success");
      button.disabled = true;
      button.textContent = "확인 중…";
    }
    try {
      options.ensureConsent();
      const client = options.createClient();
      const input = element<HTMLInputElement>("ai-api-key-input");
      if (input.value.trim()) {
        await client.setApiKey(input.value);
        input.value = "";
      }
      setConnectionStatus("ai-status", "idle", "연결 확인 중…");
      await client.testConnection();
      input.placeholder = "저장된 API 키 유지";
      setConnectionStatus("ai-status", "connected", "GPT Image 2 연결됨");
      setConnectionStatus("speech-status", "connected", "AI 연결 준비됨");
      options.onActivity("success", "OpenAI GPT Image 2 연결 테스트를 통과했습니다.");
      toast("AI 연결이 정상입니다.", "success");
      // 버튼에 명확한 완료 표시 후 잠시 뒤 원래대로 복귀.
      if (button) {
        button.classList.add("is-success");
        button.textContent = "✓ 연결 완료";
        setTimeout(() => {
          button.classList.remove("is-success");
          button.textContent = originalText;
        }, 3000);
      }
    } catch (error) {
      if (button) button.textContent = originalText;
      throw error;
    } finally {
      if (button) button.disabled = false;
    }
  }

  return { initialize, save, test };
}
