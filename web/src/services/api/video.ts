import axios from "axios";
import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { dataUrlToFile, readFileAsDataUrl } from "@/lib/image-utils";
import { sha256Hex } from "@/lib/hash";
import { maxImageReferenceIndex } from "@/lib/image-reference-prompt";
import { clampVideoSeconds, computeVideoSize, inferVideoRatio, parseVideoResolution } from "@/lib/media-size";
import { estimateVideoPrice, clampSecondsToModel, videoModelCapability, type VideoModelCapability } from "@/config/video-models";
import { fetchModelCatalog } from "@/services/api/model-catalog";
import { getMediaBlob, resolveMediaUrl, uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { readAxiosError, readFailureMessage } from "./http";
import { boolConfig, buildApiUrl, modelOptionName, resolveModelRequestConfig, resolveModelScript, withLocalProxy, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { runModelPlugin } from "./model-plugin";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

type VideoResponse = { id: string; status?: string; error?: { message?: string }; url?: string; result_url?: string; video_url?: string; content?: { video_url?: string; url?: string } | null };
type ApiVideoResponse = VideoResponse | { code?: number | string; data?: VideoResponse | null; msg?: string; message?: string; error?: { message?: string } };
type ApiEnvelope<T> = T | { code?: number | string; data?: T | null; msg?: string; message?: string; error?: { message?: string } };
type RequestOptions = { signal?: AbortSignal };
type VideoMediaOptions = RequestOptions & { videos?: ReferenceVideo[]; audios?: ReferenceAudio[] };
const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

export type VideoGenerationResult = { blob?: Blob; url?: string; mimeType?: string };
export type VideoGenerationTask = { id: string; provider: "openai" | "gemini" | "plugin" | "ark" | "qora"; model: string };
type GeminiInlineData = { bytesBase64Encoded: string; mimeType: string };
type GeminiVideoOperation = {
    name?: string;
    done?: boolean;
    error?: { message?: string };
    response?: { generateVideoResponse?: { generatedSamples?: Array<{ video?: { uri?: string } }> } };
};
export type VideoGenerationTaskState = { status: "pending" } | { status: "completed"; result: VideoGenerationResult } | { status: "media_pending"; error: string } | { status: "failed"; error: string };

/** Results for scripted (plugin) video models, which run their own create+poll in one shot at task creation. */
const pluginVideoResults = new Map<string, VideoGenerationResult>();

function aiApiUrl(config: AiConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig, contentType?: string) {
    return {
        Authorization: `Bearer ${config.apiKey}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

export async function requestVideoGeneration(config: AiConfig, prompt: string, references: ReferenceImage[] = [], options?: VideoMediaOptions): Promise<VideoGenerationResult> {
    return waitForVideoGenerationTask(config, await createVideoGenerationTask(config, prompt, references, options), options);
}

/**
 * 轮询节奏与后端保持一致：new-api 的后台任务每 15 秒才向上游刷新一次状态
 *（controller/system_task_handlers.go 的 asyncTaskPollHandler.Interval），
 * 前端比这更密只会空转，既不给用户更早的结果，又多打了网关。
 *
 * 只要上游没判失败就一直查：过去跑到 90 分钟会转「后台运行」，用户以为任务卡住，
 * 实际上游还在跑。取消任务只能由上游返回 failed/cancelled，前端不自己放弃。
 */
export const VIDEO_POLL_INTERVAL = 15000;

export async function waitForVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationResult> {
    for (;;) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const state = await pollVideoGenerationTask(config, task, options);
        if (state.status === "completed") return state.result;
        if (state.status === "media_pending") throw videoMediaPending(state.error);
        if (state.status === "failed") throw videoTaskFailed(state.error);
        await delay(VIDEO_POLL_INTERVAL, options?.signal);
    }
}

export function isVideoTaskFailed(error: unknown) {
    return error instanceof Error && error.name === "VideoTaskFailed";
}

function videoTaskFailed(message: string) {
    const error = new Error(message);
    error.name = "VideoTaskFailed";
    return error;
}

/** 任务在上游已成功，只是视频文件没下下来（上游下载慢/网络拥堵）。不是失败，画布按「生成完成、获取中」展示。 */
export function isVideoMediaPending(error: unknown) {
    return error instanceof Error && error.name === "VideoMediaPending";
}

function videoMediaPending(message: string) {
    const error = new Error(message);
    error.name = "VideoMediaPending";
    return error;
}

/**
 * 提交前把时长收进当前档位的范围。
 *
 * 目录只在登录时预热一次，后台改过档位能力（比如「近期上新」从 5~30 秒收窄到 4~15 秒）
 * 页面手里的还是旧快照；节点里也可能存着换档位之前的秒数。这里强制刷一次目录再裁，
 * 否则会把旧范围里的秒数发给上游，直接 400「时长不可用」。
 */
async function prepareVideoSeconds(config: AiConfig): Promise<AiConfig> {
    const { session } = useUserStore.getState();
    if (session?.token) await fetchModelCatalog(session.baseUrl, session.token, { force: true });
    const model = modelOptionName(config.videoModel || config.model);
    const seconds = clampSecondsToModel(model, config.videoSeconds);
    return seconds === config.videoSeconds ? config : { ...config, videoSeconds: seconds };
}

export async function createVideoGenerationTask(config: AiConfig, prompt: string, references: ReferenceImage[] = [], options?: VideoMediaOptions): Promise<VideoGenerationTask> {
    const readyConfig = await prepareVideoSeconds(config);
    const selectedModel = (readyConfig.model || readyConfig.videoModel).trim();
    const requestConfig = resolveModelRequestConfig(readyConfig, selectedModel);
    // 提示词里的「图片N」必须落在实际上传的图片数量内：上游按编号校验素材，
    // 越界直接 502（「提示词引用了 [图9]，但只提供了 8 个」），本地先拦下来，
    // 别让用户为一次必然失败的请求等一轮轮询。
    if (references.length > 0) {
        const capability = videoModelCapability(requestConfig.model);
        const sendable = capability?.maxImages ? Math.min(references.length, capability.maxImages) : references.length;
        const referenced = maxImageReferenceIndex(prompt);
        if (referenced > sendable) throw new Error(apiText("promptImageReferenceOutOfRange", { index: referenced, count: sendable }));
    }
    const script = resolveModelScript(config, selectedModel);
    if (script) return createPluginVideoTask(requestConfig, selectedModel, script, prompt, references, options);
    assertVideoConfig(requestConfig, requestConfig.model);
    if (requestConfig.apiFormat === "gemini") return createGeminiVideoTask(requestConfig, selectedModel, prompt, references, options);
    if (videoModelCapability(requestConfig.model)?.protocol === "ark") return createArkVideoTask(requestConfig, selectedModel, prompt, references, options);
    if (videoModelCapability(requestConfig.model)?.protocol === "qora") return createQoraVideoTask(requestConfig, selectedModel, prompt, references, options);
    return createOpenAIVideoTask(requestConfig, selectedModel, prompt, references, options);
}

export async function pollVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    if (task.provider === "plugin") {
        const result = pluginVideoResults.get(task.id);
        return result ? { status: "completed", result } : { status: "failed", error: apiText("pluginVideoExpired") };
    }
    const requestConfig = resolveModelRequestConfig(config, task.model);
    assertVideoConfig(requestConfig, requestConfig.model);
    if (task.provider === "gemini") return pollGeminiVideoTask(requestConfig, task, options);
    if (task.provider === "ark") return pollArkVideoTask(requestConfig, task, options);
    if (task.provider === "qora") return pollQoraVideoTask(requestConfig, task, options);
    return pollOpenAIVideoTask(requestConfig, task, options);
}

async function createPluginVideoTask(config: AiConfig, model: string, script: string, prompt: string, references: ReferenceImage[], options?: VideoMediaOptions): Promise<VideoGenerationTask> {
    if (!config.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
    if (!config.apiKey.trim()) throw new Error(apiText("apiKeyRequired"));
    const refs = await Promise.all(references.map((image) => imageToDataUrl(image)));
    const videos = await Promise.all((options?.videos || []).map((video) => referenceMediaToFile(video, "ref.mp4", "invalidReferenceVideo", options)));
    const audios = await Promise.all((options?.audios || []).map((audio) => referenceMediaToFile(audio, "ref.mp3", "invalidReferenceAudio", options)));
    const result = videoPluginResult(
        await runModelPlugin({
            capability: "video",
            script,
            config,
            prompt,
            images: refs,
            videos,
            audios,
            params: {
                seconds: normalizeVideoSeconds(config.videoSeconds),
                size: normalizeVideoSize(config.size, config.vquality),
                resolution: normalizeVideoResolution(config.vquality),
                ratio: videoAspectRatio(config.size),
                generateAudio: boolConfig(config.videoGenerateAudio, true),
                watermark: boolConfig(config.videoWatermark, false),
                mode: resolveVideoMode(config.videoMode, refs.length),
            },
            signal: options?.signal,
        }),
    );
    const id = nanoid();
    pluginVideoResults.set(id, result);
    return { id, provider: "plugin", model };
}

function videoPluginResult(result: unknown): VideoGenerationResult {
    if (result instanceof Blob) return { blob: result };
    if (typeof result === "string") return { url: result, mimeType: "video/mp4" };
    if (result && typeof result === "object") {
        const record = result as Record<string, unknown>;
        if (record.blob instanceof Blob) return { blob: record.blob };
        const url = [record.url, record.video_url, record.result_url].find((value) => typeof value === "string" && value) as string | undefined;
        if (url) return { url, mimeType: "video/mp4" };
    }
    throw new Error(apiText("scriptNoVideo"));
}

export async function storeGeneratedVideo(result: VideoGenerationResult): Promise<UploadedFile> {
    if (result.blob) return uploadMediaFile(result.blob, "video");
    if (result.url) {
        try {
            return await uploadMediaFile(result.url, "video");
        } catch {
            return { url: result.url, storageKey: "", bytes: 0, mimeType: result.mimeType || "video/mp4" };
        }
    }
    throw new Error(apiText("noPlayableVideo"));
}

async function createOpenAIVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: VideoMediaOptions): Promise<VideoGenerationTask> {
    const images = await Promise.all(references.map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
    // 参考素材要全传：网关上的 miniKey 等视频渠道按 images[] / videos[] / audios[] 收多份，
    // 提示词里的 @图1/@图2 就按上传顺序编号，漏传会让序号越界直接报错。
    // 但 OpenAI 官方接口只认单个 input_reference，所以数量一律以目录声明的上限为准：
    // 目录没声明（未接入网关的模型）就退回单图，保持原行为。
    const capability = videoModelCapability(model);
    const maxImages = Math.max(1, capability?.maxImages || 1);
    const maxVideos = capability?.maxVideos || 0;
    const maxAudios = capability?.maxAudios || 0;
    const body = new FormData();
    body.append("model", modelOptionName(model));
    body.append("prompt", prompt);
    body.append("seconds", normalizeVideoSeconds(config.videoSeconds));
    const normalizedSize = normalizeVideoSize(config.size, config.vquality);
    // size 是唯一能把用户选的横竖屏传给上游的字段（网关插件按它反推 ratio）：
    // 传空等于交给上游默认值，所以「auto」时不塞兜底尺寸，免得替用户做了横屏决定。
    if (normalizedSize) body.append("size", mapVideoSize(normalizedSize));
    images.slice(0, maxImages).forEach((file, index) => body.append("input_reference", file, referenceFileName(file, index, "png")));
    if (maxVideos > 0) {
        const videos = await Promise.all((options?.videos || []).slice(0, maxVideos).map((video) => referenceMediaToFile(video, "ref.mp4", "invalidReferenceVideo", options)));
        videos.forEach((file, index) => body.append("videos", file, referenceFileName(file, index, "mp4")));
    }
    if (maxAudios > 0) {
        const audios = await Promise.all((options?.audios || []).slice(0, maxAudios).map((audio) => referenceMediaToFile(audio, "ref.mp3", "invalidReferenceAudio", options)));
        audios.forEach((file, index) => body.append("audios", file, referenceFileName(file, index, "mp3")));
    }
    try {
        const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), body, { headers: aiHeaders(config), signal: options?.signal })).data);
        if (!created.id) throw new Error(apiText("noVideoTaskId"));
        return { id: created.id, provider: "openai", model };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

/**
 * 上传文件名必须带正确扩展名：图片按 mime 落 png/jpg/webp，视频音频同理。
 * 上游按扩展名 + 内容双重校验，全部叫 ref.png 时非 png 素材会被判成「不是有效图片」。
 */
function referenceFileName(file: File, index: number, fallbackExtension: string) {
    const fromType = (file.type || "").split("/")[1] || "";
    const extension = fromType.replace(/^x-/, "").replace("mpeg", "mp3") || fallbackExtension;
    return `ref${index + 1}.${extension}`;
}

async function pollOpenAIVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const video = unwrapVideoResponse((await axios.get<ApiVideoResponse>(aiApiUrl(config, `/videos/${task.id}`), { headers: aiHeaders(config), signal: options?.signal })).data);
        const url = videoResultUrl(video);
        if (url) return { status: "completed", result: await videoResultFromUrl(url, options) };
        if (video.status === "completed") {
            try {
                const content = await axios.get<Blob>(aiApiUrl(config, `/videos/${task.id}/content`), { headers: aiHeaders(config), responseType: "blob", signal: options?.signal });
                await assertVideoBlob(content.data);
                return { status: "completed", result: { blob: content.data } };
            } catch (error) {
                if (axios.isCancel(error) || options?.signal?.aborted) throw error;
                // 任务在上游已经成功，只是视频文件没下下来（上游文件下载慢/网络拥堵）。
                // 不判失败：交给上层显示「生成完成、视频获取中」，保留 taskId 供重试下载。
                return { status: "media_pending", error: apiText("videoMediaPending") };
            }
        }
        if (video.status === "failed" || video.status === "cancelled") return { status: "failed", error: readFailureMessage(video.error?.message, apiText("videoGenerationFailed")) };
        return { status: "pending" };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskQueryFailed")));
    }
}

async function videoResultFromUrl(url: string, options?: RequestOptions): Promise<VideoGenerationResult> {
    try {
        const response = await axios.get<Blob>(withLocalProxy(url), { responseType: "blob", signal: options?.signal });
        await assertVideoBlob(response.data);
        return { blob: response.data };
    } catch (error) {
        if (axios.isCancel(error) || options?.signal?.aborted) throw error;
        return { url, mimeType: "video/mp4" };
    }
}

async function createGeminiVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: VideoMediaOptions): Promise<VideoGenerationTask> {
    const images = await Promise.all(references.map((image) => imageToDataUrl(image)));
    const videos = await Promise.all((options?.videos || []).map((video) => referenceMediaToFile(video, "ref.mp4", "invalidReferenceVideo", options)));
    const audios = await Promise.all((options?.audios || []).map((audio) => referenceMediaToFile(audio, "ref.mp3", "invalidReferenceAudio", options)));
    const mode = resolveVideoMode(config.videoMode, images.length);
    const instance: Record<string, unknown> = { prompt };
    if (mode === "frames") {
        if (images[0]) instance.image = parseDataUrlInline(images[0]);
        if (images[1]) instance.lastFrame = parseDataUrlInline(images[1]);
    } else {
        instance.referenceImages = images.map((dataUrl) => ({ image: parseDataUrlInline(dataUrl), referenceType: "asset" }));
    }
    if (videos[0]) instance.video = await fileToGeminiInline(videos[0]);
    if (audios[0]) instance.audio = await fileToGeminiInline(audios[0]);
    try {
        const created = unwrapEnvelope(
            (
                await axios.post<ApiEnvelope<GeminiVideoOperation>>(
                    geminiVideoUrl(config, model, "predictLongRunning"),
                    {
                        instances: [instance],
                        parameters: {
                            aspectRatio: videoAspectRatio(config.size),
                            durationSeconds: Number(normalizeVideoSeconds(config.videoSeconds)) || 8,
                            resolution: normalizeVideoResolution(config.vquality),
                            generateAudio: boolConfig(config.videoGenerateAudio, true),
                            addWatermark: boolConfig(config.videoWatermark, false),
                        },
                    },
                    { headers: geminiVideoHeaders(config), signal: options?.signal },
                )
            ).data,
            apiText("noVideoTask"),
        );
        if (!created.name) throw new Error(apiText("noVideoTaskId"));
        return { id: created.name, provider: "gemini", model };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

async function pollGeminiVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const state = unwrapEnvelope((await axios.get<ApiEnvelope<GeminiVideoOperation>>(geminiOperationUrl(config, task.id), { headers: geminiVideoHeaders(config), signal: options?.signal })).data, apiText("videoTaskQueryFailed"));
        if (state.error) return { status: "failed", error: readFailureMessage(state.error.message, apiText("videoGenerationFailed")) };
        if (!state.done) return { status: "pending" };
        const uri = state.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
        if (!uri) return { status: "failed", error: apiText("noPlayableVideo") };
        const url = uri.includes("key=") ? uri : `${uri}${uri.includes("?") ? "&" : "?"}key=${config.apiKey}`;
        return { status: "completed", result: await videoResultFromUrl(url, options) };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskQueryFailed")));
    }
}

async function createArkVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: VideoMediaOptions): Promise<VideoGenerationTask> {
    const capability = videoModelCapability(model);
    if (!capability) throw new Error(apiText("videoModelRequired"));
    if (!references.length && (options?.videos?.length || options?.audios?.length)) throw new Error(apiText("arkReferenceUnsupported"));
    if (references.length > capability.maxImages) throw new Error(apiText("arkReferenceImageLimit", { count: capability.maxImages }));
    // Ark 的 content 只接受公网 URL：本地 blob/data 图片先上传到图床，已是公网 URL 的直接用。
    const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
    for (const image of references) {
        const url = await resolveArkReferenceUrl(config, image);
        content.push({ type: "image_url", image_url: { url }, role: "reference_image" });
    }
    const resolution = normalizeResolutionTier(capability, config.vquality);
    const seconds = clampArkSeconds(capability, config.videoSeconds);
    try {
        const created = unwrapEnvelope(
            (
                await axios.post<ApiEnvelope<VideoResponse>>(
                    arkVideoUrl(config, "/contents/generations/tasks"),
                    {
                        model: modelOptionName(model),
                        content,
                        duration: seconds,
                        ratio: capability.ratios.includes(videoAspectRatio(config.size)) ? videoAspectRatio(config.size) : capability.ratios[0],
                        resolution: `${resolution}p`,
                    },
                    { headers: aiHeaders(config, "application/json"), signal: options?.signal },
                )
            ).data,
            apiText("noVideoTask"),
        );
        if (!created?.id) throw new Error(apiText("noVideoTaskId"));
        return { id: created.id, provider: "ark", model };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

async function pollArkVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const state = unwrapEnvelope(
            (await axios.get<ApiEnvelope<VideoResponse>>(arkVideoUrl(config, `/contents/generations/tasks/${encodeURIComponent(task.id)}`), { headers: aiHeaders(config), signal: options?.signal })).data,
            apiText("videoTaskQueryFailed"),
        );
        const url = videoResultUrl(state);
        if (url) return { status: "completed", result: await videoResultFromUrl(url, options) };
        if (state.status === "failed" || state.status === "cancelled") return { status: "failed", error: readFailureMessage(state.error?.message, apiText("videoGenerationFailed")) };
        return { status: "pending" };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskQueryFailed")));
    }
}

function arkVideoUrl(config: Pick<AiConfig, "baseUrl">, path: string) {
    const baseUrl = config.baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
    return withLocalProxy(`${baseUrl}/doubao/api/v3${path}`);
}

// ── Qora asset upload (3-step: authorize → OSS direct → complete) ──────────
// new-api proxies steps 1 & 3 at POST /api/qora-assets (adds channel Qora key).
// Step 2 (file → OSS) goes directly from the browser to Aliyun OSS – no auth.

type QoraAuthorizeResp = { status: "uploading"; id: string; host: string; upload_mode: string; fields: Record<string, string> } | { status: "ready"; id: string };
type QoraCompleteResp = { status: "ready"; id: string };

function qoraAssetsProxyUrl(config: Pick<AiConfig, "baseUrl">) {
    const base = config.baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
    return `${base}/api/qora-assets`;
}

/** Upload one file to Qora's OSS and return the asset id. */
async function qoraUploadAsset(config: AiConfig, blob: Blob, mimeType: string, signal?: AbortSignal): Promise<string> {
    // 1. Compute SHA-256 of the file.
    const source = await sha256Hex(await blob.arrayBuffer());

    // 2. Authorize via new-api proxy.
    const authRes = await fetch(qoraAssetsProxyUrl(config), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ action: "authorize", source, size: blob.size, type: mimeType }),
        signal,
    });
    if (!authRes.ok) throw new Error(apiText("arkUploadFailed", { status: authRes.status }));
    const authData = (await authRes.json()) as QoraAuthorizeResp;

    if (authData.status === "ready") return authData.id;

    // Sanity-check the OSS host stays on Aliyun.
    const ossHost = new URL(authData.host);
    if (!ossHost.hostname.endsWith("aliyuncs.com")) throw new Error("Unexpected Qora OSS host");

    // 3. Upload directly to OSS (no Qora key – must not forward it).
    const form = new FormData();
    for (const [k, v] of Object.entries(authData.fields)) form.append(k, v);
    form.append("file", blob, "ref");
    const ossRes = await fetch(ossHost.origin, { method: "POST", body: form, signal });
    if (!ossRes.ok && ossRes.status !== 204) {
        // OSS returns 204 No Content on success.
        const txt = await ossRes.text().catch(() => "");
        if (ossRes.status !== 204) throw new Error(apiText("arkUploadFailed", { status: ossRes.status }) + " " + txt.slice(0, 80));
    }

    // 4. Complete via new-api proxy.
    const completeRes = await fetch(qoraAssetsProxyUrl(config), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ action: "complete", id: authData.id }),
        signal,
    });
    if (!completeRes.ok) throw new Error(apiText("arkUploadFailed", { status: completeRes.status }));
    const completeData = (await completeRes.json()) as QoraCompleteResp;
    if (completeData.status !== "ready") throw new Error("Qora asset not ready after complete");
    return completeData.id;
}

/** Upload a ReferenceImage to Qora and return {id, role}. */
async function qoraUploadImageRef(config: AiConfig, image: ReferenceImage, role: string, signal?: AbortSignal): Promise<{ id: string; role: string }> {
    let blob: Blob | null = null;
    // Priority 1: storageKey → IndexedDB
    if (image.storageKey) blob = await getMediaBlob(image.storageKey);
    // Priority 2: use imageToDataUrl which handles all cases (storageKey, dataUrl, blob:, url)
    if (!blob) {
        try {
            const dataUrl = await imageToDataUrl(image);
            if (dataUrl.startsWith("data:")) blob = await (await fetch(dataUrl)).blob();
        } catch {
            /* ignore */
        }
    }
    // Priority 3: raw candidate
    if (!blob) {
        const candidate = image.url || image.dataUrl || "";
        if (candidate.startsWith("blob:")) blob = await (await fetch(candidate, { signal })).blob();
        else if (candidate.startsWith("data:")) blob = await (await fetch(candidate)).blob();
        else if (/^https?:\/\//i.test(candidate)) blob = await (await fetch(withLocalProxy(candidate), { signal })).blob();
    }
    if (!blob) throw new Error(apiText("referenceImageReadFailed"));
    const mimeType = blob.type || "image/png";
    const id = await qoraUploadAsset(config, blob, mimeType, signal);
    return { id, role };
}

/** Upload a ReferenceVideo to Qora and return {id, role}. */
async function qoraUploadVideoRef(config: AiConfig, video: ReferenceVideo, role: string, signal?: AbortSignal): Promise<{ id: string; role: string }> {
    let blob: Blob | null = null;
    if (video.storageKey) blob = await getMediaBlob(video.storageKey);
    if (!blob) {
        const url = video.storageKey ? await resolveMediaUrl(video.storageKey, video.url || "") : video.url || "";
        if (!url) throw new Error(apiText("invalidReferenceVideo"));
        blob = await (await fetch(withLocalProxy(url), { signal })).blob();
    }
    if (!blob?.size) throw new Error(apiText("invalidReferenceVideo"));
    const mimeType = blob.type || "video/mp4";
    const id = await qoraUploadAsset(config, blob, mimeType, signal);
    return { id, role };
}

// Qora: 走 new-api 的 /v1/videos（multipart），由 Qora 插件（Task Plugin 61）处理。
// new-api 识别 route_id 前缀（qr-v*）路由到 channel #8。
// Qora 走 new-api 的 /v1/videos，baseUrl 已含 /v1 不能用 aiApiUrl（会再加 /v1）。
function qoraApiUrl(config: Pick<AiConfig, "baseUrl">, path: string) {
    const baseUrl = config.baseUrl.trim().replace(/\/+$/, "");
    // 如果 baseUrl 已经以 /v1 结尾（如 https://qorastudio.cn/api/v1），直接拼路径。
    // 否则走 buildApiUrl 补 /v1。
    if (/\/v1$/i.test(baseUrl)) return withLocalProxy(`${baseUrl}${path}`);
    return buildApiUrl(baseUrl, path);
}

// Qora 对参考素材有时长上限：同一次任务里所有参考视频 + 参考音频的时长**合计**
// 不能超过 30 秒（视频和音频合并计算，不是各自算）。超了上游会拒绝，白白上传
// 一遍素材再失败，所以在真正上传之前就拦住。
// durationMs 缺失的素材按 0 计，不猜测时长。
const QORA_REFERENCE_TOTAL_SECONDS = 30;

function assertQoraReferenceDuration(videos: ReferenceVideo[], audios: ReferenceAudio[]) {
    const totalSeconds = [...videos, ...audios].reduce((total, item) => {
        const ms = Number(item.durationMs);
        return total + (Number.isFinite(ms) && ms > 0 ? ms / 1000 : 0);
    }, 0);
    if (totalSeconds > QORA_REFERENCE_TOTAL_SECONDS) {
        throw new Error(apiText("referenceMediaTotalTooLong", { limit: QORA_REFERENCE_TOTAL_SECONDS, actual: Math.round(totalSeconds * 10) / 10 }));
    }
}

async function createQoraVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: VideoMediaOptions): Promise<VideoGenerationTask> {
    const capability = videoModelCapability(model);
    const rawModel = modelOptionName(model);
    const seconds = capability ? String(clampArkSeconds(capability, config.videoSeconds)) : normalizeVideoSeconds(config.videoSeconds);
    const resolution = capability ? normalizeResolutionTier(capability, config.vquality) : parseVideoResolution(config.vquality);
    const ratio = videoAspectRatio(config.size);

    // Upload reference images and videos to Qora OSS and collect asset IDs.
    const refImages = references.slice(0, capability?.maxImages ?? 9);
    const refVideos = (options?.videos || []).slice(0, capability?.maxVideos ?? 0);
    const refAudios = (options?.audios || []).slice(0, capability?.maxAudios ?? 0);
    assertQoraReferenceDuration(refVideos, refAudios);

    let qoraRefs: { id: string; role: string }[] = [];
    if (refImages.length || refVideos.length || refAudios.length) {
        const imageUploads = refImages.map((img) => qoraUploadImageRef(config, img, "reference_image", options?.signal));
        const videoUploads = refVideos.map((vid) => qoraUploadVideoRef(config, vid, "reference_video", options?.signal));
        const audioUploads = refAudios.map((aud) => qoraUploadVideoRef(config, { ...aud, url: aud.url || "", type: aud.type || "audio/mpeg" } as ReferenceVideo, "reference_audio", options?.signal));
        qoraRefs = await Promise.all([...imageUploads, ...videoUploads, ...audioUploads]);
    }

    const body = new FormData();
    body.append("model", rawModel);
    body.append("prompt", prompt);
    body.append("seconds", seconds);
    body.append("size", `${resolution}p`);
    body.append("metadata", JSON.stringify({ resolution: `${resolution}p`, ratio, duration: Number(seconds), references: qoraRefs }));
    try {
        const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(qoraApiUrl(config, "/videos"), body, { headers: aiHeaders(config), signal: options?.signal })).data);
        if (!created.id) throw new Error(apiText("noVideoTaskId"));
        return { id: created.id, provider: "qora", model };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

async function pollQoraVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const video = unwrapVideoResponse((await axios.get<ApiVideoResponse>(qoraApiUrl(config, `/videos/${task.id}`), { headers: aiHeaders(config), signal: options?.signal })).data);
        const url = videoResultUrl(video);
        if (url) return { status: "completed", result: await videoResultFromUrl(url, options) };
        if (video.status === "failed" || video.status === "cancelled" || video.status === "FAILURE") {
            return { status: "failed", error: readFailureMessage(video.error?.message, apiText("videoGenerationFailed")) };
        }
        return { status: "pending" };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskQueryFailed")));
    }
}

/** 把本地参考图上传到图床并返回公网 URL；已经是 http(s) 的直接返回。 */
async function resolveArkReferenceUrl(config: AiConfig, image: ReferenceImage): Promise<string> {
    const candidate = image.url || image.dataUrl || "";
    if (/^https?:\/\//i.test(candidate)) return candidate;

    const imgbedUrl = (config.imgbedUrl || "").trim().replace(/\/+$/, "");
    if (!imgbedUrl) throw new Error(apiText("arkReferenceNeedsPublicUrl"));
    // 图床地址允许是同源相对路径（如 /imgbed），但火山侧要抓图必须是绝对 URL。
    const imgbedBase = (/^https?:\/\//i.test(imgbedUrl) ? imgbedUrl : new URL(imgbedUrl, window.location.origin).href).replace(/\/+$/, "");

    // 从 IndexedDB / dataUrl 拿到 Blob，然后 POST 到图床。
    let blob: Blob | null = null;
    if (image.storageKey) blob = await getMediaBlob(image.storageKey);
    if (!blob && candidate.startsWith("data:")) blob = await (await fetch(candidate)).blob();
    if (!blob && candidate.startsWith("blob:")) blob = await (await fetch(candidate)).blob();
    if (!blob) throw new Error(apiText("referenceImageReadFailed"));

    const form = new FormData();
    const ext = blob.type.split("/")[1] || "png";
    form.append("file", blob, `ref.${ext}`);

    const resp = await fetch(withLocalProxy(`${imgbedUrl}/upload`), { method: "POST", body: form });
    if (!resp.ok) throw new Error(apiText("arkUploadFailed", { status: resp.status }));
    const json = await resp.json();
    if (!json.url) throw new Error(apiText("arkUploadFailed", { status: 0 }));

    // 图床返回的是相对路径 /public/xxx.png，加上图床地址变成完整 URL。
    return /^https?:\/\//i.test(json.url) ? json.url : `${imgbedBase}${json.url}`;
}

function publicReferenceUrl(image: ReferenceImage) {
    const candidate = image.url || image.dataUrl || "";
    return /^https?:\/\//i.test(candidate) ? candidate : "";
}

function normalizeResolutionTier(capability: VideoModelCapability, value: string) {
    const tier = parseVideoResolution(value);
    if (capability.resolutions.includes(tier)) return tier;
    return capability.resolutions[capability.resolutions.length - 1];
}

function clampArkSeconds(capability: VideoModelCapability, value: string) {
    const step = capability.seconds.step || 1;
    const requested = Math.floor(Number(value) || capability.defaultSeconds);
    const bounded = Math.min(capability.seconds.max, Math.max(capability.seconds.min, requested));
    const steps = Math.round((bounded - capability.seconds.min) / step);
    return capability.seconds.min + steps * step;
}

function assertVideoConfig(config: AiConfig, model: string) {
    if (!model) throw new Error(apiText("videoModelRequired"));
    if (!config.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
    if (!config.apiKey.trim()) throw new Error(apiText("apiKeyRequired"));
}

function geminiVideoBaseUrl(config: Pick<AiConfig, "baseUrl">) {
    const normalizedBaseUrl = config.baseUrl.trim().replace(/\/+$/, "");
    const lowerBaseUrl = normalizedBaseUrl.toLowerCase();
    return lowerBaseUrl.endsWith("/v1") || lowerBaseUrl.endsWith("/v1beta") ? normalizedBaseUrl : `${normalizedBaseUrl}/v1beta`;
}

function geminiVideoUrl(config: Pick<AiConfig, "baseUrl">, model: string, action: string) {
    return withLocalProxy(`${geminiVideoBaseUrl(config)}/models/${encodeURIComponent(modelOptionName(model).replace(/^models\//, ""))}:${action}`);
}

function geminiOperationUrl(config: Pick<AiConfig, "baseUrl">, name: string) {
    return withLocalProxy(`${geminiVideoBaseUrl(config)}/${name.replace(/^\//, "")}`);
}

function geminiVideoHeaders(config: Pick<AiConfig, "apiKey">) {
    return { "x-goog-api-key": config.apiKey, "Content-Type": "application/json" };
}

function videoAspectRatio(size: string) {
    const ratio = inferVideoRatio(size);
    return ratio === "auto" ? "16:9" : ratio;
}

function parseDataUrlInline(dataUrl: string, fallbackType = "image/png"): GeminiInlineData {
    const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
    return { bytesBase64Encoded: match?.[2] || "", mimeType: match?.[1] || fallbackType };
}

async function fileToGeminiInline(file: File): Promise<GeminiInlineData> {
    return parseDataUrlInline(await readFileAsDataUrl(file), file.type || "application/octet-stream");
}

async function referenceMediaToFile(item: { name: string; type?: string; url?: string; storageKey?: string }, fallbackName: string, errorKey: "invalidReferenceVideo" | "invalidReferenceAudio", options?: RequestOptions) {
    let blob = item.storageKey ? await getMediaBlob(item.storageKey) : null;
    if (!blob) {
        const url = item.storageKey ? await resolveMediaUrl(item.storageKey, item.url || "") : item.url || "";
        if (!url) throw new Error(apiText(errorKey));
        try {
            blob = await (await fetch(url, { signal: options?.signal })).blob();
        } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") throw error;
            throw new Error(apiText(errorKey));
        }
    }
    if (!blob.size) throw new Error(apiText(errorKey));
    return new File([blob], item.name || fallbackName, { type: item.type || blob.type || "application/octet-stream" });
}

function normalizeVideoSeconds(value: string) {
    return clampVideoSeconds(value);
}

function resolveVideoMode(mode: string | undefined, imageCount: number) {
    if (mode === "reference" || imageCount > 2) return "reference";
    return "frames";
}

/**
 * 把请求尺寸收敛到 480/720/1080 三档（miniKey 这类上游只认这几档的短边），
 * 但**必须保留横竖方向**。
 *
 * 之前这里三个分支一律返回竖屏尺寸（480x854 / 720x1280 / 1080x1920），
 * 用户选 16:9（1280x720）也会被发成 720x1280，网关插件按 16:9 的反比算出 9:16，
 * 上游就老老实实出了竖屏。2026-11-20 09:08 那条 text_to_video 就是这么变成竖屏的。
 */
function mapVideoSize(size: string) {
    const match = size.match(/^(\d+)x(\d+)$/);
    if (!match) return "720x1280";
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!width || !height) return "720x1280";
    const shortEdgeRaw = Math.min(width, height);
    const shortEdge = shortEdgeRaw <= 480 ? 480 : shortEdgeRaw <= 720 ? 720 : 1080;
    const longEdge = Math.round((shortEdge * Math.max(width, height)) / shortEdgeRaw);
    return width >= height ? `${longEdge}x${shortEdge}` : `${shortEdge}x${longEdge}`;
}

function normalizeVideoSize(value: string, resolution?: string) {
    if (value === "auto") return null;
    if (/^\d+x\d+$/.test(value || "")) return value;
    const ratio = inferVideoRatio(value || "16:9");
    if (ratio === "auto") return null;
    return computeVideoSize(resolution || "720", ratio);
}

function normalizeVideoResolution(value: string) {
    if (value === "low") return "480p";
    if (value === "auto" || value === "high" || value === "medium") return "720p";
    const resolution = value.replace(/p$/i, "") || "720";
    return `${resolution}p`;
}

function unwrapVideoResponse(payload: ApiVideoResponse) {
    return unwrapEnvelope(payload, apiText("noVideoTask"));
}

function unwrapEnvelope<T>(payload: ApiEnvelope<T>, emptyMessage: string): T {
    if (!payload) throw new Error(emptyMessage);
    if (typeof payload === "object" && "code" in payload && payload.code !== undefined) {
        if (payload.code !== 0 && payload.code !== "0") throw new Error(readFailureMessage(payload, apiText("requestFailed")));
        if (!payload.data) throw new Error(emptyMessage);
        return payload.data;
    }
    return payload as T;
}

function videoResultUrl(payload: VideoResponse) {
    return [payload.video_url, payload.result_url, payload.url, payload.content?.video_url, payload.content?.url].find((url) => typeof url === "string" && (isPublicMediaUrl(url) || /\.mp4(\?|#|$)/i.test(url)));
}

async function assertVideoBlob(blob: Blob) {
    if (!blob.type.includes("json")) return;
    let payload: { code?: number; msg?: string; error?: { message?: string } };
    try {
        payload = JSON.parse(await blob.text()) as { code?: number; msg?: string; error?: { message?: string } };
    } catch {
        return;
    }
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(readFailureMessage(payload, apiText("videoDownloadFailed")));
    if (payload.error?.message) throw new Error(readFailureMessage(payload.error.message, apiText("videoDownloadFailed")));
}

function isPublicMediaUrl(value: string) {
    return /^https?:\/\//i.test(value || "");
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });
}
