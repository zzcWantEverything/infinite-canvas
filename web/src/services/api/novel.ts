import axios from "axios";
import { saveAs } from "file-saver";

import { readApiErrorMessage, readAxiosError } from "./http";

export type NovelFormat = "txt" | "epub" | "pdf" | "bulk_txt";

export type NovelEngineStatus = {
    available: boolean;
    version?: string;
    prewarm_ready: boolean;
    prewarm_in_progress: boolean;
    prewarm_error?: string;
    message?: string;
    is_admin: boolean;
};

export type NovelSearchItem = {
    title: string;
    author: string;
    book_id: string;
};

export type NovelPreview = {
    book_id?: string;
    resolved_book_id?: string;
    book_name?: string;
    original_book_name?: string;
    author?: string;
    chapter_count?: number;
    finished?: boolean | null;
    word_count?: number;
    score?: number | null;
    read_count_text?: string;
    read_count?: number | string;
    description?: string;
    tags?: string[];
    first_chapter_title?: string;
    last_chapter_title?: string;
    category?: string;
    detail_cover_url?: string;
    cover_url?: string;
    cover_proxy_url?: string;
};

export type NovelOption = {
    label: string;
    value: string;
};

export type NovelTaskState = "queued" | "running" | "done" | "partial" | "failed" | "canceled";

export type NovelTaskItem = {
    id: number;
    engine_job_id: string;
    book_id: string;
    title: string;
    author: string;
    format: NovelFormat;
    range_start: number;
    range_end: number;
    state: NovelTaskState;
    saved_chapters: number;
    chapter_total: number;
    message: string;
    output_rel_path: string;
    output_kind: string;
    output_name: string;
    output_size: number;
    can_download: boolean;
    book_name_options?: NovelOption[];
    format_options?: NovelOption[];
    created_at: number;
    updated_at: number;
};

export type CreateNovelJobPayload = {
    book_id: string;
    title?: string;
    author?: string;
    format: NovelFormat;
    range_start?: number;
    range_end?: number;
};

export type AdminNovelStatus = {
    available: boolean;
    version?: string;
    prewarm_in_progress?: boolean;
    prewarm_error?: string;
    save_dir?: string;
    bind_addr?: string;
    locked?: boolean;
    docker_build?: boolean;
    global_active_jobs: number;
    message?: string;
};

export type AdminNovelConfig = {
    novel_format: NovelFormat;
    ask_format_after_download: boolean;
    max_workers: number;
    request_timeout: number;
    max_retries: number;
    min_wait_time: number;
    max_wait_time: number;
    use_official_api: boolean;
    auto_clear_dump: boolean;
    first_line_indent_em: number;
    enable_segment_comments: boolean;
    segment_comments_top_n: number;
};

function authHeaders(token: string) {
    return { Authorization: `Bearer ${token.trim()}` };
}

async function unwrap<T>(request: Promise<{ data: { success?: boolean; message?: string; data?: T } }>, fallback: string): Promise<T> {
    const response = await request.catch((error: unknown) => {
        throw new Error(readAxiosError(error, fallback));
    });
    const body = response.data;
    if (!body?.success) throw new Error(body?.message || fallback);
    return body.data as T;
}

const ALLOWED_SHORTLINK_HOSTS = new Set(["changdunovel.com", "www.changdunovel.com", "fanqienovel.com", "www.fanqienovel.com", "fqnovel.com", "www.fqnovel.com"]);

/** Extracts numeric book ID or validated official shortlink from user input. */
export function parseNovelBookInput(input: string): string {
    const trimmed = (input || "").trim();
    if (!trimmed) return "";
    if (/^\d{4,25}$/.test(trimmed)) return trimmed;

    const urlMatch = trimmed.match(/https?:\/\/\S+/i);
    const target = (urlMatch ? urlMatch[0] : trimmed).replace(/[.,;!?)'"】》」]+$/g, "");
    try {
        const parsed = new URL(target);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
        const qsBookId = (parsed.searchParams.get("book_id") || parsed.searchParams.get("bookId") || "").trim();
        if (/^\d{4,25}$/.test(qsBookId)) return qsBookId;
        const pageMatch = parsed.pathname.match(/\/page\/(\d{4,25})/);
        if (pageMatch?.[1]) return pageMatch[1];
        if (ALLOWED_SHORTLINK_HOSTS.has(parsed.hostname.toLowerCase()) && /^\/t\/[A-Za-z0-9_-]+\/?$/.test(parsed.pathname)) {
            return target;
        }
    } catch {
        return "";
    }
    return "";
}

export async function getNovelStatus(token: string, signal?: AbortSignal): Promise<NovelEngineStatus> {
    return unwrap<NovelEngineStatus>(
        axios.get("/api/user/novel/status", { headers: authHeaders(token), requiresAuth: true, signal, timeout: 15000 }),
        "获取番茄小说引擎状态失败",
    );
}

export async function searchNovels(token: string, query: string, signal?: AbortSignal): Promise<NovelSearchItem[]> {
    const data = await unwrap<{ items?: NovelSearchItem[] }>(
        axios.get("/api/user/novel/search", { params: { q: query }, headers: authHeaders(token), requiresAuth: true, signal, timeout: 25000 }),
        "搜索番茄小说失败",
    );
    return Array.isArray(data?.items) ? data.items : [];
}

export async function previewNovel(token: string, bookId: string, signal?: AbortSignal): Promise<NovelPreview> {
    return unwrap<NovelPreview>(
        axios.get("/api/user/novel/preview", { params: { book_id: bookId }, headers: authHeaders(token), requiresAuth: true, signal, timeout: 25000 }),
        "加载书籍详情失败",
    );
}

export async function cleanupNovelPreview(token: string, bookId: string): Promise<void> {
    await axios
        .post("/api/user/novel/preview/cleanup", { book_id: bookId }, { headers: authHeaders(token), requiresAuth: true, timeout: 8000 })
        .catch(() => {});
}

export async function fetchNovelCoverBlobUrl(token: string, preview: NovelPreview, signal?: AbortSignal): Promise<string | null> {
    const proxyUrl = preview.cover_proxy_url || (/^\d{4,25}$/.test(preview.resolved_book_id || preview.book_id || "") ? `/api/user/novel/cover?book_id=${encodeURIComponent(preview.resolved_book_id || preview.book_id || "")}` : "");
    if (!proxyUrl) return null;
    try {
        const res = await axios.get<Blob>(proxyUrl, {
            headers: authHeaders(token),
            requiresAuth: true,
            responseType: "blob",
            signal,
            timeout: 15000,
        });
        if (!res.data || res.data.size === 0) return null;
        return URL.createObjectURL(res.data);
    } catch {
        return null;
    }
}

export async function listNovelJobs(token: string, signal?: AbortSignal): Promise<NovelTaskItem[]> {
    const data = await unwrap<NovelTaskItem[]>(
        axios.get("/api/user/novel/jobs", { headers: authHeaders(token), requiresAuth: true, signal, timeout: 20000 }),
        "读取下载任务失败",
    );
    return Array.isArray(data) ? data : [];
}

export async function createNovelJob(token: string, payload: CreateNovelJobPayload): Promise<NovelTaskItem> {
    return unwrap<NovelTaskItem>(
        axios.post("/api/user/novel/jobs", payload, { headers: authHeaders(token), requiresAuth: true, timeout: 25000 }),
        "创建下载任务失败",
    );
}

export async function cancelNovelJob(token: string, id: number): Promise<void> {
    await unwrap<void>(
        axios.post(`/api/user/novel/jobs/${id}/cancel`, {}, { headers: authHeaders(token), requiresAuth: true, timeout: 15000 }),
        "取消下载任务失败",
    );
}

export async function submitNovelJobFormat(token: string, id: number, format: NovelFormat): Promise<NovelTaskItem> {
    return unwrap<NovelTaskItem>(
        axios.post(`/api/user/novel/jobs/${id}/format`, { format }, { headers: authHeaders(token), requiresAuth: true, timeout: 20000 }),
        "提交导出格式失败",
    );
}

export async function deleteNovelJob(token: string, id: number): Promise<void> {
    await unwrap<void>(
        axios.delete(`/api/user/novel/jobs/${id}`, { headers: authHeaders(token), requiresAuth: true, timeout: 15000 }),
        "删除下载任务失败",
    );
}

function parseContentDispositionFilename(headerValue: string | undefined): string {
    if (!headerValue) return "";
    const utfMatch = headerValue.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
    if (utfMatch?.[1]) {
        try {
            return decodeURIComponent(utfMatch[1].trim().replace(/^"|"$/g, ""));
        } catch {
            // fall through
        }
    }
    const plainMatch = headerValue.match(/filename\s*=\s*"?([^";]+)"?/i);
    return plainMatch?.[1]?.trim() || "";
}

export async function downloadNovelFile(token: string, id: number, fallbackName: string, onProgress?: (percent: number) => void): Promise<void> {
    let response;
    try {
        response = await axios.get<Blob>(`/api/user/novel/jobs/${id}/download`, {
            headers: authHeaders(token),
            requiresAuth: true,
            responseType: "blob",
            timeout: 120000,
            onDownloadProgress: (evt) => {
                if (onProgress && evt.total && evt.total > 0) {
                    onProgress(Math.min(100, Math.round((evt.loaded / evt.total) * 100)));
                }
            },
        });
    } catch (error: unknown) {
        if (axios.isAxiosError(error) && error.response?.data instanceof Blob) {
            const rawText = await error.response.data.text().catch(() => "");
            const parsedMsg = readApiErrorMessage(rawText);
            if (parsedMsg) throw new Error(parsedMsg);
        }
        throw new Error(readAxiosError(error, "下载小说文件失败"));
    }
    const headerFilename = parseContentDispositionFilename(response.headers?.["content-disposition"]);
    const filename = headerFilename || fallbackName || `novel-${id}.txt`;
    saveAs(response.data, filename);
}

export async function getAdminNovelStatus(token: string, signal?: AbortSignal): Promise<AdminNovelStatus> {
    return unwrap<AdminNovelStatus>(
        axios.get("/api/user/novel/admin/status", { headers: authHeaders(token), requiresAuth: true, signal, timeout: 15000 }),
        "获取管理员引擎状态失败",
    );
}

export async function getAdminNovelConfig(token: string, signal?: AbortSignal): Promise<AdminNovelConfig> {
    return unwrap<AdminNovelConfig>(
        axios.get("/api/user/novel/admin/config", { headers: authHeaders(token), requiresAuth: true, signal, timeout: 15000 }),
        "读取引擎配置失败",
    );
}

export async function updateAdminNovelConfig(token: string, config: AdminNovelConfig): Promise<AdminNovelConfig> {
    return unwrap<AdminNovelConfig>(
        axios.put("/api/user/novel/admin/config", config, { headers: authHeaders(token), requiresAuth: true, timeout: 20000 }),
        "保存引擎配置失败",
    );
}

export function formatNovelBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const idx = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const value = bytes / 1024 ** idx;
    return `${value.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

export function formatNovelTimestamp(unixSec: number): string {
    if (!unixSec) return "";
    const d = new Date(unixSec * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
