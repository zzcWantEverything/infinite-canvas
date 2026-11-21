import { create } from "zustand";

/**
 * 画布云同步状态。
 *
 * 之前 `pushProjectToCloud` 把所有异常 catch 掉，用户完全不知道保存失败了 —— 生成了一堆图，
 * 刷新一看全没了。这里把状态暴露出来：画布右下角会显示「未同步 / 重试」，不再静默。
 */
export type CanvasSyncStatus = "idle" | "saving" | "saved" | "error";

type CanvasSyncState = {
    status: CanvasSyncStatus;
    /** 上次成功保存的时间戳（ms） */
    savedAt: number;
    error: string;
    setSaving: () => void;
    setSaved: (at?: number) => void;
    setError: (message: string) => void;
    reset: () => void;
};

export const useCanvasSyncStore = create<CanvasSyncState>((set) => ({
    status: "idle",
    savedAt: 0,
    error: "",
    setSaving: () => set((state) => (state.status === "saving" ? state : { status: "saving", error: "" })),
    setSaved: (at) => set({ status: "saved", savedAt: at ?? Date.now(), error: "" }),
    setError: (message) => set({ status: "error", error: message }),
    reset: () => set({ status: "idle", savedAt: 0, error: "" }),
}));
