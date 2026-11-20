import axios from "axios";

import { buildApiUrl, type AiConfig } from "@/stores/use-config-store";
import { requestGeneration } from "@/services/api/image";
import { readAxiosError } from "@/services/api/http";
import { VIDEO_POLL_INTERVAL, createVideoGenerationTask, pollVideoGenerationTask, storeGeneratedVideo } from "@/services/api/video";
import type { UploadedFile } from "@/services/file-storage";
import type { ReferenceImage } from "@/types/image";

/** 爆款转绘的中间结构：角色/场景/物品 + 分镜。 */
export type CopyItem = {
    id: string;
    name: string;
    description: string;
};

export type CopyShot = {
    id: string;
    /** 时间码，精确到 0.1 秒 */
    start: string;
    end: string;
    duration: string;
    /** 景别：特写 / 近景 / 中景 / 全景 / 远景 */
    shotSize: string;
    /** 机位与角度 */
    cameraAngle: string;
    /** 镜头运动：固定 / 推 / 拉 / 摇 / 移 / 跟 / 手持 */
    cameraMove: string;
    /** 画面：首帧内容、人物位置朝向、手持物、前后景物件、结束动作停在何处 */
    description: string;
    /** 表演：动作顺序、视线落点、手势、呼吸停顿、表情变化、动作落在哪个词上 */
    performance: string;
    /** 声音：口播/对白（人物名）、画外旁白、环境声、操作音效，含说话人与起止 */
    sound: string;
    /** 台词原文（来自音轨转写，没有则为空） */
    dialogue: string;
    /** 画面文字：口播字幕 / 活动价签 / 身份条 / 招牌 / 包装，含位置与时间 */
    onScreenText: string;
    roles: string[];
    scenes: string[];
    items: string[];
};

export type CopyAnalysis = {
    title: string;
    /** 画面比例，如 9:16 */
    ratio: string;
    roles: CopyItem[];
    scenes: CopyItem[];
    items: CopyItem[];
    shots: CopyShot[];
};

export type CopyFrame = { time: number; dataUrl: string; /** 所属场景（镜头）序号，分批分析时用来保证一批不跨太多镜头 */ scene: number };

/** 前端抽帧的硬上限：超过 10 分钟 seek 次数太多，体验不可接受。 */
export const MAX_VIDEO_SECONDS = 600;

export type CopyVideoMeta = {
    duration: number;
    width: number;
    height: number;
    frameCount: number;
    sceneCount: number;
};

export type CopyAnalyzeBatch = {
    /** 第几批 / 共几批（从 1 开始） */
    index: number;
    total: number;
    /** 本批覆盖的时间范围（秒） */
    startTime: number;
    endTime: number;
    /** 前几批已经定下来的名字，本批必须沿用，避免同一个人被叫成两个名字 */
    known?: { roles: CopyItem[]; scenes: CopyItem[]; items: CopyItem[] };
};

function batchContext(batch?: CopyAnalyzeBatch) {
    if (!batch || batch.total <= 1) return "";
    const known = batch.known;
    const list = (items: CopyItem[]) => items.map((item) => `${item.name}（${item.description || "无描述"}）`).join("、");
    const lines = [
        "",
        `【分批说明】这是第 ${batch.index}/${batch.total} 批，宫格里所有格子都落在 ${batch.startTime.toFixed(1)}~${batch.endTime.toFixed(1)} 秒之间。`,
        "只输出本批时间范围内的分镜，不要重复其他批次的镜头。",
    ];
    if (known && (known.roles.length || known.scenes.length || known.items.length)) {
        lines.push("【已确认清单】前面几批已经定下的对象，本批凡是同一对象必须沿用下面的 name，不要另起新名：");
        if (known.roles.length) lines.push(`角色：${list(known.roles)}`);
        if (known.scenes.length) lines.push(`场景：${list(known.scenes)}`);
        if (known.items.length) lines.push(`物品：${list(known.items)}`);
        lines.push("本批新出现的角色/场景/物品照常写进对应数组，name 也要简短、可与上面的清单并存。");
    }
    return lines.join("\n");
}

function analysisPrompt(meta: CopyVideoMeta, batch?: CopyAnalyzeBatch) {
    return `你是一名专业的短视频逐镜拆解师，要产出一份可直接用于 AI 视频生成与剪辑复刻的逐镜脚本。
用户会给出：视频宫格图（每格标了序号和大致时间点）、元数据、以及音轨自动转写的台词。
${batchContext(batch)}
视频元数据：
- 时长：${meta.duration.toFixed(1)} 秒
- 分辨率：${meta.width}x${meta.height}
- 抽帧：${meta.frameCount} 格（已按画面差异挑选，共 ${meta.sceneCount} 个场景切换）

拆解规则：
1. 按原片切点逐镜拆解：每次硬切、机位变化或明显转场都单独编号；极短的产品特写、手部动作、人物反应镜头也要保留。
   时间码精确到 0.1 秒。跨度长时每 30 秒为一组（用 group 字段标组号，从 1 开始），最后一组按实际时长。
   跨组镜头保留原切点和连续动作，台词只录一次。
2. 声音区分四类：人物口播/对白（写明是谁、对镜还是对台下/对人说）、画外旁白（标明覆盖哪些镜头）、环境声、操作音效。
   同一句跨多镜头只写一次，并注明切在第几个词。听不清写「待核对」，不要补写；说话人无法确认标「说话人待确认」。
3. 画面里出现的数字/价签只写在画面/画面文字字段；只有实际说出的内容才进口播或旁白，两者不要混。
4. 品牌、包装、价格、数量、原话按原片记录，不要改写或替换。
5. 角色/场景/物品去重合并，名称简短；分镜里的名称必须与 roles/scenes/items 的 name 完全一致。
6. 宫格是降采样过的缩略图：人脸、小字、远景细节本来就糊。看不清就写「画面不清晰」或只描述能确认的部分（发型、服装主色、道具外形、人物站位），
   绝对不要凭常识补出品牌名、价格、字幕内容。宁可少写，不可编造。
7. 时间码以宫格上标注的时间戳为准：镜头起点在某一格附近就用那一格的时间，不要按帧率自行推算。

严格返回 JSON（不要 markdown 代码块）：
{
  "title": "一句话概括视频主题",
  "ratio": "画面比例，如 9:16",
  "roles": [{ "name": "角色名", "description": "外观、服装、发型、气质等可复用于生图的描述" }],
  "scenes": [{ "name": "场景名", "description": "地点、光线、环境布置等可复用于生图的描述" }],
  "items": [{ "name": "物品名", "description": "外观、材质、颜色等可复用于生图的描述" }],
  "shots": [{
    "group": 1,
    "start": "0.0秒",
    "end": "2.3秒",
    "duration": "2.3秒",
    "shotSize": "特写/近景/中景/全景/远景",
    "cameraAngle": "平视/俯拍/仰拍/正面/侧面/过肩等，含机位高低",
    "cameraMove": "固定/推/拉/摇/移/跟/手持",
    "description": "画面：第一帧是什么，人物在画面左/中/右哪个位置、身体朝哪、谁拿着什么、前景和背景有哪些物件，镜头结束时动作停在哪里",
    "performance": "表演：具体动作及发生顺序，视线落点、手势、呼吸停顿、表情变化，哪个动作落在哪个词上",
    "sound": "声音：🔵【人物口播／对白｜人物名】或 🟠【画外旁白｜声线归属】，以及环境声、操作音效，含说话人与起止位置",
    "dialogue": "该镜头对应的台词/口播原文（没有则为空字符串）",
    "onScreenText": "画面文字：口播字幕/活动价签/人物身份条/背景招牌/产品包装，记录内容、位置与出现时间（没有则为空字符串）",
    "roles": ["该镜头出现的角色名"],
    "scenes": ["该镜头所在场景名"],
    "items": ["该镜头出现的关键物品名"]
  }]
}


要求：
1. 角色/场景/物品去重合并，同一对象只出现一次，名称简短。
2. 分镜按时间顺序，尽量覆盖全部格；每个场景切换至少要有一个分镜。
3. 所有名称必须与 roles/scenes/items 里的 name 完全一致。
4. 只输出 JSON。`;
}

export function aiTextUrl(config: AiConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

export function aiTextHeaders(config: AiConfig) {
    return { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" };
}

/**
 * 场景检测抽帧：按固定步长采样小缩略图，和上一张比较像素差异，
 * 差异超过阈值就判定为「镜头切换」，保留该时刻的高清帧；再均匀补齐到 maxFrames。
 * 相比固定间隔抽帧，关键镜头不容易漏，重复帧也不会占满额度。
 */
export async function extractSceneFrames(file: File, maxFrames = 32, signal?: AbortSignal): Promise<{ frames: CopyFrame[]; meta: CopyVideoMeta }> {
    const src = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.src = src;
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    try {
        await new Promise<void>((resolve, reject) => {
            video.onloadedmetadata = () => resolve();
            video.onerror = () => reject(new Error("视频无法解码，请换一个格式（建议 MP4/H.264）"));
            if (signal) signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
        const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
        if (!duration) throw new Error("视频时长读取失败");
        if (duration > MAX_VIDEO_SECONDS) throw new Error(`视频不能超过 ${MAX_VIDEO_SECONDS / 60} 分钟（当前 ${(duration / 60).toFixed(1)} 分钟）`);
        const width = video.videoWidth || 0;
        const height = video.videoHeight || 0;
        if (!width || !height) throw new Error("视频分辨率读取失败");

        const thumb = document.createElement("canvas");
        thumb.width = 64;
        thumb.height = 36;
        const thumbCtx = thumb.getContext("2d", { willReadFrequently: true });
        const fullMaxEdge = 640;
        const scale = Math.min(1, fullMaxEdge / Math.max(width, height));
        const full = document.createElement("canvas");
        full.width = Math.max(1, Math.round(width * scale));
        full.height = Math.max(1, Math.round(height * scale));
        const fullCtx = full.getContext("2d");
        if (!thumbCtx || !fullCtx) throw new Error("浏览器不支持 canvas 抽帧");

        const seek = (time: number) =>
            new Promise<void>((resolve, reject) => {
                video.onseeked = () => resolve();
                video.onerror = () => reject(new Error("抽帧失败"));
                video.currentTime = Math.min(Math.max(time, 0), Math.max(0, duration - 0.05));
            });

        // 动态步长：短视频抓得细，长视频降采样，保证 seek 次数可控（10 分钟内最多约 600 次）
        const step = duration <= 60 ? 0.4 : duration <= 300 ? 1 : 2;
        let previous: Uint8ClampedArray | null = null;
        const candidates: { time: number; diff: number; dataUrl: string }[] = [];
        for (let t = 0; t < duration; t += step) {
            if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
            await seek(t);
            thumbCtx.drawImage(video, 0, 0, thumb.width, thumb.height);
            const pixels = thumbCtx.getImageData(0, 0, thumb.width, thumb.height).data;
            let diff = 0;
            if (previous) {
                for (let i = 0; i < pixels.length; i += 4) {
                    diff += Math.abs(pixels[i] - previous[i]) + Math.abs(pixels[i + 1] - previous[i + 1]) + Math.abs(pixels[i + 2] - previous[i + 2]);
                }
                diff /= (pixels.length / 4) * 3 * 255;
            }
            previous = new Uint8ClampedArray(pixels);
            fullCtx.drawImage(video, 0, 0, full.width, full.height);
            candidates.push({ time: t, diff, dataUrl: full.toDataURL("image/jpeg", 0.78) });
        }

        // 先按差异找「镜头切换」作为场景边界，再在每个场景内挑帧。
        // 关键约束：每个场景至少留 1 帧（切点后的那一帧最能代表镜头起幅），
        // 剩余预算按场景时长加权分配——之前是「每个场景 4 帧再全时间轴掐到 32」，
        // 场景一多就会把某些场景整段丢掉，模型自然漏角色/漏分镜。
        const threshold = 0.06;
        const sceneStarts = candidates.filter((item, index) => index === 0 || item.diff >= threshold);
        const scenes = sceneStarts.map((item, index) => ({
            start: item.time,
            end: index + 1 < sceneStarts.length ? sceneStarts[index + 1].time : duration,
        }));
        const frameAt = (time: number) => {
            let closest = candidates[0];
            let closestDelta = Math.abs(candidates[0].time - time);
            for (const candidate of candidates) {
                const delta = Math.abs(candidate.time - time);
                if (delta < closestDelta) {
                    closest = candidate;
                    closestDelta = delta;
                }
            }
            return closest;
        };
        const picked: { time: number; scene: number }[] = [];
        if (scenes.length >= maxFrames) {
            // 场景比帧预算还多：只能每个入选场景各一帧，按时间均匀挑场景，保证覆盖整条时间线。
            for (let i = 0; i < maxFrames; i += 1) {
                const sceneIndex = Math.round((i * (scenes.length - 1)) / Math.max(1, maxFrames - 1));
                picked.push({ time: frameAt(scenes[sceneIndex].start).time, scene: sceneIndex });
            }
        } else {
            const totalDuration = Math.max(duration, 0.1);
            const extra = maxFrames - scenes.length;
            scenes.forEach((scene, sceneIndex) => {
                const span = Math.max(scene.end - scene.start, 0.01);
                // 按场景时长占比分额外帧，单个场景最多 4 帧（再多也是同一段画面）
                const share = Math.min(3, Math.floor((extra * span) / totalDuration + 0.5));
                const count = 1 + Math.max(0, share);
                if (count === 1) {
                    picked.push({ time: frameAt(scene.start).time, scene: sceneIndex });
                    return;
                }
                // 起幅 → … → 收幅：保留镜头开始和结束，中间均匀铺开
                for (let j = 0; j < count; j += 1) {
                    const ratio = j === count - 1 ? 0.92 : (j / (count - 1)) * 0.5;
                    picked.push({ time: frameAt(scene.start + span * ratio).time, scene: sceneIndex });
                }
            });
        }
        const uniqueByTime = new Map<number, { time: number; scene: number }>();
        picked.forEach((item) => {
            if (!uniqueByTime.has(item.time)) uniqueByTime.set(item.time, item);
        });
        const finalPicked = Array.from(uniqueByTime.values())
            .sort((a, b) => a.time - b.time)
            .slice(0, maxFrames)
            .map((item) => ({ ...item, frame: candidates.find((candidate) => candidate.time === item.time) ?? frameAt(item.time) }));

        return {
            frames: finalPicked.map((item) => ({ time: item.time, dataUrl: item.frame.dataUrl, scene: item.scene })),
            meta: { duration, width, height, frameCount: finalPicked.length, sceneCount: sceneStarts.length },
        };
    } finally {
        URL.revokeObjectURL(src);
    }
}

/**
 * 把关键帧拼成宫格图（每格带序号和时间），一次请求就能让模型看到整条时间线。
 *
 * 格子尺寸不再是固定 200×112：按视频比例和帧数算「在像素预算内面积最大」的排布。
 * 之前竖屏视频也被塞进 16:9 的格子，两侧全是黑边，一半像素白白浪费；
 * 竖屏现在会排成 6~8 列，单格面积提升约 2.5 倍，模型才看得清服装、道具和画面文字。
 */
export async function buildFrameGrid(frames: CopyFrame[], aspect = 16 / 9): Promise<string> {
    const MAX_WIDTH = 1400;
    const MAX_HEIGHT = 1568; // 主流多模态模型的最优输入长边
    const LABEL_HEIGHT = 18;
    const safeAspect = Number.isFinite(aspect) && aspect >= 0.3 && aspect <= 3 ? aspect : 16 / 9;

    let best = { cols: 4, rows: Math.ceil(frames.length / 4), cellWidth: 0, cellHeight: 0 };
    for (let cols = 2; cols <= Math.min(12, Math.max(2, frames.length)); cols += 1) {
        const rows = Math.ceil(frames.length / cols);
        const heightBudget = MAX_HEIGHT - rows * LABEL_HEIGHT;
        if (heightBudget <= 0) continue;
        const byWidth = MAX_WIDTH / cols;
        const byHeight = (heightBudget / rows) * safeAspect;
        const cellWidth = Math.floor(Math.min(byWidth, byHeight));
        const cellHeight = Math.floor(cellWidth / safeAspect);
        if (cellWidth * cellHeight > best.cellWidth * best.cellHeight) best = { cols, rows, cellWidth, cellHeight };
    }
    const { cols, rows, cellWidth, cellHeight } = best;

    const canvas = document.createElement("canvas");
    canvas.width = cellWidth * cols;
    canvas.height = (cellHeight + LABEL_HEIGHT) * rows;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("浏览器不支持 canvas 拼图");
    ctx.fillStyle = "#111827";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // dataURL 的 Image 必须等 onload 才能可靠 drawImage
    const images = await Promise.all(
        frames.map(
            (frame) =>
                new Promise<HTMLImageElement>((resolve) => {
                    const image = new Image();
                    image.onload = () => resolve(image);
                    image.onerror = () => resolve(image);
                    image.src = frame.dataUrl;
                }),
        ),
    );
    frames.forEach((frame, index) => {
        const col = index % cols;
        const row = Math.floor(index / cols);
        const x = col * cellWidth;
        const y = row * (cellHeight + LABEL_HEIGHT);
        ctx.fillStyle = "#1f2937";
        ctx.fillRect(x, y + LABEL_HEIGHT, cellWidth, cellHeight);
        if (images[index]?.complete) ctx.drawImage(images[index], x, y + LABEL_HEIGHT, cellWidth, cellHeight);
        ctx.fillStyle = "rgba(17,24,39,0.9)";
        ctx.fillRect(x, y, cellWidth, LABEL_HEIGHT);
        ctx.fillStyle = "#f9fafb";
        ctx.font = "12px sans-serif";
        ctx.textBaseline = "middle";
        ctx.fillText(`#${index + 1}  ${frame.time.toFixed(1)}s`, x + 6, y + LABEL_HEIGHT / 2);
    });
    return canvas.toDataURL("image/jpeg", 0.85);
}

/** 调用多模态模型分析宫格图。sessionToken 必须是后台登录态 token（不是中转 key）。 */
export async function analyzeVideoGrid(
    config: AiConfig,
    gridDataUrl: string,
    meta: CopyVideoMeta,
    model: string,
    sessionToken: string,
    transcript = "",
    signal?: AbortSignal,
    batch?: CopyAnalyzeBatch,
): Promise<CopyAnalysis> {
    const basePrompt = analysisPrompt(meta, batch);
    const promptText = transcript ? `${basePrompt}\n\n附：视频音轨自动转写的台词（带时间戳，可直接用于分镜的口播/台词字段，注意校正同音字）\n${transcript}` : basePrompt;
    if (!sessionToken.trim()) throw new Error("请先登录后再分析");
    // 走异步任务：长请求会被链路中间代理 120s 掐断，改成「提交 + 轮询」。
    // 用同源相对路径：`/api/user/**` 挂的是 UserAuth，只认后台登录态 token；
    // 渠道里那个中转 key（sk-...）会被判成「access token 无效」。
    // key 和 baseUrl 都不再上传 —— 服务端按登录用户自己取令牌、地址固定本机回环，
    // 既不让凭证出现在请求体里，也避免 baseUrl 被拿去打内网（SSRF）。
    const endpoint = "/api/user/copy/analyze";
    const headers = { Authorization: `Bearer ${sessionToken.trim()}` };
    // 把后端的中文 message（如「access token 无效」）透出来，别只显示 HTTP 401。
    const submit = await axios.post(endpoint, { model, prompt: promptText, image: gridDataUrl }, { headers, signal, timeout: 30000 }).catch((error: unknown) => {
        throw new Error(readAxiosError(error, "提交分析任务失败"));
    });
    const jobId = String((submit.data as { jobId?: string })?.jobId || "");
    if (!jobId) throw new Error("提交分析任务失败");
    for (;;) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const poll = await axios.get(`${endpoint}/${encodeURIComponent(jobId)}`, { headers, signal, timeout: 30000 }).catch((error: unknown) => {
            throw new Error(readAxiosError(error, "查询分析进度失败"));
        });
        const data = poll.data as { status?: string; content?: string; error?: string };
        if (data.status === "done") {
            return normalizeAnalysis(extractJson(String(data.content || "")));
        }
        if (data.status === "failed") throw new Error(data.error || "分析失败");
    }
}


function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = String(reader.result || "");
            const idx = result.indexOf("base64,");
            resolve(idx >= 0 ? result.slice(idx + 7) : result);
        };
        reader.onerror = () => reject(new Error("音频读取失败"));
        reader.readAsDataURL(blob);
    });
}

/** whisper 只吃 16kHz 单声道 PCM；这里把视频文件的音轨解出来并重采样。 */
export async function extractAudioWav(file: File, signal?: AbortSignal): Promise<{ blob: Blob; duration: number } | null> {
    const AudioCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) return null;
    const ctx = new AudioCtor();
    try {
        const buffer = await file.arrayBuffer();
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const decoded = await ctx.decodeAudioData(buffer);
        if (!decoded || decoded.duration <= 0) return null;
        const targetRate = 16000;
        const frames = Math.max(1, Math.ceil(decoded.duration * targetRate));
        const offline = new OfflineAudioContext(1, frames, targetRate);
        const source = offline.createBufferSource();
        source.buffer = decoded;
        source.connect(offline.destination);
        source.start(0);
        const rendered = await offline.startRendering();
        return { blob: encodeWav(rendered.getChannelData(0), targetRate), duration: decoded.duration };
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        return null;
    } finally {
        void ctx.close();
    }
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const writeText = (offset: number, text: string) => {
        for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    };
    writeText(0, "RIFF");
    view.setUint32(4, 36 + samples.length * 2, true);
    writeText(8, "WAVE");
    writeText(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeText(36, "data");
    view.setUint32(40, samples.length * 2, true);
    let offset = 44;
    for (let i = 0; i < samples.length; i++) {
        const clamped = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
        offset += 2;
    }
    return new Blob([buffer], { type: "audio/wav" });
}

/** 调 new-api 的腾讯云 ASR 代理，把音轨转成台词。失败返回空串（降级为无台词）。 */
export async function transcribeAudio(baseUrl: string, sessionToken: string, wav: Blob, signal?: AbortSignal): Promise<string> {
    const audio = await blobToBase64(wav);
    if (!audio) return "";
    const endpoint = `${baseUrl.trim().replace(/\/+$/, "")}/api/user/copy/transcribe`;
    const response = await axios.post(endpoint, { audio }, { headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" }, signal, timeout: 240000 });
    const data = response.data as { success?: boolean; text?: string; message?: string };
    if (!data?.success) return "";
    return String(data.text || "").trim();
}

/** 角色/场景/物品 → 生成一张参考图（返回 dataUrl 或图片 URL）。 */
export async function generateItemImage(config: AiConfig, item: CopyItem, signal?: AbortSignal): Promise<string> {
    const prompt = [item.name, item.description].filter(Boolean).join("，");
    const images = await requestGeneration({ ...config, count: "1" }, prompt, { signal });
    if (!images.length) throw new Error("生图没有返回结果");
    return images[0].dataUrl;
}

/** 分镜 → 生成一段视频（首帧参考图可选），返回已入库的素材（url + storageKey）。 */
export async function generateShotVideo(
    config: AiConfig,
    shot: CopyShot,
    references: ReferenceImage[] = [],
    signal?: AbortSignal,
): Promise<UploadedFile> {
    const prompt = shotPrompt(shot);
    const task = await createVideoGenerationTask(config, prompt, references, { signal });
    for (;;) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const state = await pollVideoGenerationTask(config, task);
        if (state.status === "completed") {
            return storeGeneratedVideo(state.result);
        }
        if (state.status === "failed") throw new Error(state.error || "视频生成失败");
        await new Promise((resolve) => setTimeout(resolve, VIDEO_POLL_INTERVAL));
    }
}

/**
 * 分镜 → 视频提示词。按「镜头语言 → 画面 → 表演 → 台词/画面文字」拼，
 * 景别/机位/运动单独成句，避免和画面描述混在一起被模型忽略。
 */
export function shotPrompt(shot: CopyShot): string {
    const camera = [shot.shotSize, shot.cameraAngle, shot.cameraMove].filter(Boolean).join("，");
    const lines = [camera ? `镜头：${camera}` : "", shot.description ? `画面：${shot.description}` : "", shot.performance ? `表演：${shot.performance}` : "", shot.dialogue ? `台词：${shot.dialogue}` : "", shot.onScreenText ? `画面文字：${shot.onScreenText}` : ""];
    const prompt = lines.filter(Boolean).join("\n");
    return prompt || shot.description || "复刻原片镜头的画面与运镜";
}

function extractJson(text: string): Record<string, unknown> {
    const trimmed = String(text || "").trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1] : trimmed;
    const start = candidate.indexOf("{");
    if (start < 0) throw new Error("模型没有返回可解析的 JSON");
    const body = candidate.slice(start);
    const parsed = parseJsonLoose(body);
    if (parsed) return parsed;
    // 输出被 max_tokens 截断时会给到半截 JSON：把最后一个完整元素之前的括号补齐，
    // 保住已经写好的角色/分镜，而不是让用户白等两分钟。
    const repaired = parseJsonLoose(closeUnclosedJson(body));
    if (repaired) return repaired;
    throw new Error("模型返回的 JSON 不完整（多半是分镜太多被截断），请缩短视频或减少分镜后重试");
}

/** 截掉模型在 JSON 后面补的说明文字后再解析；失败返回 null。 */
function parseJsonLoose(value: string): Record<string, unknown> | null {
    const end = value.lastIndexOf("}");
    const attempts = end > 0 && end < value.length - 1 ? [value, value.slice(0, end + 1)] : [value];
    for (const attempt of attempts) {
        try {
            const parsed = JSON.parse(attempt);
            if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
        } catch {
            // 试下一种截法
        }
    }
    return null;
}

/**
 * 补全被截断的 JSON：找到最后一个**结构上**完整的闭合点，把没闭合的括号补上。
 * 扫的时候跳过字符串内部——模型写的描述里经常出现 `}`、`]` 这类字符，
 * 直接按字符串位置截会把它们当成结构。
 */
function closeUnclosedJson(value: string): string {
    const stack: string[] = [];
    const boundaries: number[] = [];
    let inString = false;
    let escaped = false;
    for (let index = 0; index < value.length; index += 1) {
        const char = value[index];
        if (inString) {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') {
            inString = true;
            continue;
        }
        if (char === "{" || char === "[") {
            stack.push(char === "{" ? "}" : "]");
        } else if (char === "}" || char === "]") {
            stack.pop();
            boundaries.push(index + 1);
        }
    }
    // 从后往前试：最后一个闭合点通常就是「截断前最后一个完整元素」。
    for (let cursor = boundaries.length - 1; cursor >= 0 && cursor >= boundaries.length - 4; cursor -= 1) {
        const head = value.slice(0, boundaries[cursor]);
        const closers: string[] = [];
        let nested = false;
        let quote = false;
        let slash = false;
        for (let index = 0; index < head.length; index += 1) {
            const char = head[index];
            if (quote) {
                if (slash) slash = false;
                else if (char === "\\") slash = true;
                else if (char === '"') quote = false;
                continue;
            }
            if (char === '"') quote = true;
            else if (char === "{") closers.push("}");
            else if (char === "[") closers.push("]");
            else if (char === "}" || char === "]") closers.pop();
            nested = closers.length > 0;
        }
        if (!nested) continue;
        const candidate = head + closers.reverse().join("");
        if (parseJsonLoose(candidate)) return candidate;
    }
    return "";
}

function normalizeAnalysis(raw: Record<string, unknown>): CopyAnalysis {
    const stamp = Date.now();
    const toItems = (value: unknown): CopyItem[] =>
        (Array.isArray(value) ? value : [])
            .map((item, index) => {
                const record = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
                const name = String(record.name ?? "").trim();
                if (!name) return null;
                return { id: `item-${stamp}-${index}`, name, description: String(record.description ?? "").trim() };
            })
            .filter((item): item is CopyItem => Boolean(item));
    const toShots = (value: unknown): CopyShot[] =>
        (Array.isArray(value) ? value : [])
            .map((item, index) => {
                const record = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
                const asList = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
                const text = (key: string) => String(record[key] ?? "").trim();
                return {
                    id: `shot-${stamp}-${index}`,
                    start: text("start"),
                    end: text("end"),
                    duration: text("duration"),
                    shotSize: text("shotSize"),
                    cameraAngle: text("cameraAngle"),
                    cameraMove: text("cameraMove"),
                    description: text("description"),
                    performance: text("performance"),
                    sound: text("sound"),
                    dialogue: text("dialogue"),
                    onScreenText: text("onScreenText"),
                    roles: asList(record.roles),
                    scenes: asList(record.scenes),
                    items: asList(record.items),
                };
            })
            .filter((shot) => shot.description || shot.roles.length);
    return {
        title: String(raw.title ?? "").trim() || "爆款转绘",
        ratio: String(raw.ratio ?? "").trim(),
        roles: toItems(raw.roles),
        scenes: toItems(raw.scenes),
        items: toItems(raw.items),
        shots: toShots(raw.shots),
    };
}

/**
 * 把关键帧按场景切成若干批：每批最多 maxScenes 个场景、maxFrames 帧。
 * 一批只覆盖一段连续时间，模型不用在一张图上同时盯十几个镜头，画面也能给得更大。
 */
export function groupFramesIntoBatches(frames: CopyFrame[], maxScenes = 10, maxFrames = 16): CopyFrame[][] {
    const byScene = new Map<number, CopyFrame[]>();
    for (const frame of frames) {
        const list = byScene.get(frame.scene) ?? [];
        list.push(frame);
        byScene.set(frame.scene, list);
    }
    const sceneIds = [...byScene.keys()].sort((a, b) => a - b);
    const batches: CopyFrame[][] = [];
    let current: CopyFrame[] = [];
    let scenesInCurrent = 0;
    for (const id of sceneIds) {
        const list = byScene.get(id) ?? [];
        // 满一批就切：宁可多几批，也不要让单张宫格塞到看不清
        if (current.length && (current.length + list.length > maxFrames || scenesInCurrent >= maxScenes)) {
            batches.push(current);
            current = [];
            scenesInCurrent = 0;
        }
        current.push(...list);
        scenesInCurrent += 1;
    }
    if (current.length) batches.push(current);
    return batches;
}

/** 合并多批分析结果：同名的角色/场景/物品只留一条（描述取更完整的），分镜按时间排序去重。 */
export function mergeBatchAnalyses(results: CopyAnalysis[]): CopyAnalysis {
    const valid = results.filter(Boolean);
    if (!valid.length) throw new Error("分析没有返回结果");
    if (valid.length === 1) return valid[0];
    const mergeList = (key: "roles" | "scenes" | "items") => {
        const merged: CopyItem[] = [];
        const index = new Map<string, number>();
        for (const result of valid) {
            for (const item of result[key] ?? []) {
                const name = String(item.name ?? "").trim();
                if (!name) continue;
                const existing = index.get(name);
                if (existing === undefined) {
                    index.set(name, merged.length);
                    merged.push({ ...item, name });
                } else if ((merged[existing].description ?? "").length < (item.description ?? "").length) {
                    merged[existing] = { ...merged[existing], description: item.description };
                }
            }
        }
        return merged;
    };
    const seenStarts = new Set<string>();
    const shots: CopyShot[] = [];
    for (const result of valid) {
        for (const shot of result.shots ?? []) {
            const key = String(shot.start ?? "").trim();
            if (key && seenStarts.has(key)) continue;
            if (key) seenStarts.add(key);
            shots.push(shot);
        }
    }
    shots.sort((a, b) => shotStartSeconds(a.start) - shotStartSeconds(b.start));
    const stamp = Date.now();
    return {
        title: valid.find((result) => result.title)?.title ?? "",
        ratio: valid.find((result) => result.ratio)?.ratio ?? "",
        roles: mergeList("roles"),
        scenes: mergeList("scenes"),
        items: mergeList("items"),
        shots: shots.map((shot, index) => ({ ...shot, id: `shot-${stamp}-${index}` })),
    };
}

/** 时间码归一成秒：支持 "1:02.4"、"12.5秒"、"0.0秒"。 */
function shotStartSeconds(value: string) {
    const text = String(value ?? "").trim();
    const clock = text.match(/(\d+):(\d+(?:\.\d+)?)/);
    if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
    const numeric = Number(text.replace(/[^0-9.]/g, ""));
    return Number.isFinite(numeric) ? numeric : 0;
}
