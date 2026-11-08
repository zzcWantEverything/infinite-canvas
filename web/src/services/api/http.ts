import axios from "axios";

import i18n from "@/i18n";

const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

declare module "axios" {
    interface AxiosRequestConfig {
        /** 该请求依赖登录态：401 时触发登录过期处理。 */
        requiresAuth?: boolean;
    }
}

export type ApiErrorKind = "timeout" | "network" | "auth" | "http" | "payload";

/** 统一后的请求错误：message 已经是可直接展示的文案，并带上状态码与错误类型。 */
export class ApiError extends Error {
    readonly kind: ApiErrorKind;
    readonly status?: number;

    constructor(message: string, kind: ApiErrorKind, status?: number) {
        super(message);
        this.name = "ApiError";
        this.kind = kind;
        this.status = status;
    }
}

/** 从后端的各种错误结构里取出可读文案：msg / message / error.message / detail / 序列化 JSON / HTML 错误页。 */
export function readApiErrorMessage(value: unknown): string {
    if (!value) return "";
    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value);
            const inner = readApiErrorMessage(parsed) || value;
            // 空的 "{}" 视为没有可用文案。
            if (inner === value && typeof parsed === "object" && Object.keys(parsed).length === 0) return "";
            return inner;
        } catch {
            if (/<[a-z][\s\S]*>/i.test(value)) return apiText("htmlError", { preview: `${value.slice(0, 80)}...` });
            return value;
        }
    }
    if (typeof value !== "object") return "";
    const payload = value as { msg?: unknown; message?: unknown; error?: unknown; detail?: unknown };
    const errorMsg = typeof payload.error === "string" ? payload.error : (payload.error as { message?: unknown })?.message;
    return readApiErrorMessage(payload.msg) || readApiErrorMessage(payload.message) || readApiErrorMessage(errorMsg) || readApiErrorMessage(payload.detail) || "";
}

/** HTTP 状态码兜底文案。 */
export function readStatusError(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return apiText("authenticationFailed");
    if (status === 429) return apiText("rateLimited");
    if (status === 404) return apiText("notFound");
    if (status === 502) return apiText("badGateway");
    if (status === 503) return apiText("serviceBusy");
    return status ? apiText("httpFailed", { status }) : fallback;
}

/** 把任意异常收敛成 ApiError。取消的请求不在这里处理，由调用方按取消语义判断。 */
export function toApiError(error: unknown, fallback = apiText("requestFailed")): ApiError {
    if (error instanceof ApiError) return error;
    if (axios.isAxiosError(error)) {
        if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") return new ApiError(apiText("requestTimeout"), "timeout");
        if (!error.response) return new ApiError(apiText("networkFailed"), "network");
        const status = error.response.status;
        const apiMessage = readApiErrorMessage(error.response.data);
        if (apiMessage) return new ApiError(apiMessage, status === 401 ? "auth" : "http", status);
        return new ApiError(readStatusError(status, "") || error.message || fallback, status === 401 ? "auth" : "http", status);
    }
    if (error instanceof DOMException && error.name === "AbortError") return new ApiError(apiText("requestCanceled"), "payload");
    if (error instanceof Error) return new ApiError(readApiErrorMessage(error.message) || error.message || fallback, "payload");
    return new ApiError(fallback, "payload");
}

/** 兼容各业务模块的旧调用：返回可直接展示的文案。 */
export function readAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return apiText("requestCanceled");
    if (error instanceof DOMException && error.name === "AbortError") return apiText("requestCanceled");
    if (error instanceof ApiError) return error.message;
    if (axios.isAxiosError(error)) return toApiError(error, fallback).message;
    return error instanceof Error ? readApiErrorMessage(error.message) || error.message : fallback;
}

let errorNotifier: ((text: string) => void) | null = null;
let lastReport = { text: "", at: 0 };

/** 由 App 层把 antd message 注入进来，保证非 React 的请求层也能提示用户。 */
export function setApiErrorNotifier(notifier: ((text: string) => void) | null) {
    errorNotifier = notifier;
}

/** 提示一条请求错误；相同文案在短时间内只提示一次，避免并发请求刷屏。 */
export function notifyApiError(text: string) {
    if (!text) return;
    const now = Date.now();
    if (text === lastReport.text && now - lastReport.at < 2000) return;
    lastReport = { text, at: now };
    errorNotifier?.(text);
}

export function reportApiError(error: unknown, fallback?: string) {
    notifyApiError((error instanceof ApiError ? error : toApiError(error, fallback)).message);
}

let unauthorizedHandler: (() => void) | null = null;

/** 登录态失效回调，由 session 层注册。 */
export function setUnauthorizedHandler(handler: (() => void) | null) {
    unauthorizedHandler = handler;
}

/** 业务层发现登录态不可用时主动触发（例如 200 + success:false 的未登录响应）。 */
export function signalUnauthorized() {
    unauthorizedHandler?.();
}

/** 没有被业务层 catch 的请求错误也要提示，避免用户点了没反应。 */
export function installApiErrorReporting() {
    window.addEventListener("unhandledrejection", (event) => {
        if (event.reason instanceof ApiError) notifyApiError(event.reason.message);
    });
}

// 全局收敛所有 axios 请求的错误；取消的请求保持原样，交给业务层判断是否静默。
axios.interceptors.response.use(
    (response) => response,
    (error) => {
        if (axios.isCancel(error)) return Promise.reject(error);
        const apiError = toApiError(error);
        if (apiError.status === 401 && axios.isAxiosError(error) && error.config?.requiresAuth) unauthorizedHandler?.();
        return Promise.reject(apiError);
    },
);
