import axios from "axios";

import { buildApiUrl, type AiConfig } from "@/stores/use-config-store";
import { requestEdit, requestGeneration } from "@/services/api/image";
import { readAxiosError } from "@/services/api/http";
import { VIDEO_POLL_INTERVAL, createVideoGenerationTask, pollVideoGenerationTask, storeGeneratedVideo } from "@/services/api/video";
import type { UploadedFile } from "@/services/file-storage";
import type { ReferenceImage } from "@/types/image";

/** 爆款转绘的中间结构：角色/场景/物品 + 分镜。 */
export type CopyItem = {
    id: string;
    name: string;
    description: string;
    /** 角色声线设定（性别、声音年龄、音色、语言/方言、基础语速），只给角色用 */
    voice?: string;
};

export type CopyShot = {
    id: string;
    /** 时间码，精确到 0.1 秒 */
    start: string;
    end: string;
    duration: string;
    /** 可直接出片的视频提示词：整段范围 + 逐节拍时间线（分析产物，可编辑） */
    videoPrompt: string;
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
    /** 生成该镜首帧用的图片描述词（可编辑，批量「生成图片描述词」写入） */
    imagePrompt: string;
    roles: string[];
    scenes: string[];
    items: string[];
};

export type CopyAnalysis = {
    title: string;
    /** 画面比例，如 9:16 */
    ratio: string;
    /** 全片统一的画风/影调/质感描述，生图与生视频都会带上 */
    style: string;
    roles: CopyItem[];
    scenes: CopyItem[];
    items: CopyItem[];
    shots: CopyShot[];
};

export type CopyFrame = { time: number; dataUrl: string; /** 所属场景（镜头）序号，分批分析时用来保证一批不跨太多镜头 */ scene: number };


/** 16 档 RGB 直方图（48 个 bin），对摇镜、曝光漂移不敏感。 */
const HIST_BINS = 16;

function frameHistogram(pixels: Uint8ClampedArray, out: Float32Array) {
    out.fill(0);
    const total = pixels.length / 4;
    for (let i = 0; i < pixels.length; i += 4) {
        out[pixels[i] >> 4] += 1;
        out[HIST_BINS + (pixels[i + 1] >> 4)] += 1;
        out[HIST_BINS * 2 + (pixels[i + 2] >> 4)] += 1;
    }
    const scale = 1 / (total * 3);
    for (let i = 0; i < out.length; i += 1) out[i] *= scale;
    return out;
}

function histogramDistance(a: Float32Array, b: Float32Array) {
    let sum = 0;
    for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i] - b[i]);
    return sum / 2;
}

type FrameSample = { time: number; pixelDiff: number; histDiff: number; dataUrl: string };

/**
 * 切点判定（双阈值 + 渐变检测）：
 * - 硬切：瞬时跳变大（像素差 ≥0.10 或直方图差 ≥0.30）→ 立刻切
 * - 叠化/淡入淡出：画面是渐变的，单帧跳变很小，靠「连续 ≥3 个软信号 + 累积量够大」判定，
 *   在整段渐变的中间切一刀。之前只看固定阈值 0.06，叠化会被整段并成一个镜头。
 */
function detectSceneStarts(candidates: FrameSample[]) {
    const HARD_PIXEL = 0.1;
    const HARD_HIST = 0.3;
    const SOFT_PIXEL = 0.035;
    const SOFT_HIST = 0.1;
    const hard = (d: FrameSample) => d.pixelDiff >= HARD_PIXEL || d.histDiff >= HARD_HIST;
    const soft = (d: FrameSample) => d.pixelDiff >= SOFT_PIXEL || d.histDiff >= SOFT_HIST;

    const cuts = new Set<number>([0]);
    for (let i = 1; i < candidates.length; i += 1) {
        if (hard(candidates[i])) cuts.add(i);
    }
    // 渐变段：连续软信号但都不够硬，累积变化够大就当一次转场
    let runStart = -1;
    for (let i = 1; i <= candidates.length; i += 1) {
        const isSoft = i < candidates.length && soft(candidates[i]) && !hard(candidates[i]);
        if (isSoft && runStart < 0) runStart = i;
        if (!isSoft && runStart >= 0) {
            const span = i - runStart;
            let pixelSum = 0;
            let histSum = 0;
            for (let j = runStart; j < i; j += 1) {
                pixelSum += candidates[j].pixelDiff;
                histSum += candidates[j].histDiff;
            }
            if (span >= 3 && (pixelSum >= HARD_PIXEL * 1.5 || histSum >= HARD_HIST * 1.2)) {
                cuts.add(runStart + Math.floor(span / 2));
            }
            runStart = -1;
        }
    }
    return [...cuts].sort((a, b) => a - b).map((index) => candidates[index]);
}

/** 前端抽帧的硬上限：超过 10 分钟 seek 次数太多，体验不可接受。 */
export const MAX_VIDEO_SECONDS = 600;

export type CopyVideoMeta = {
    duration: number;
    width: number;
    height: number;
    frameCount: number;
    sceneCount: number;
    /** 检测到的切点时间（秒），提示词里给模型当分镜边界参考 */
    cuts?: number[];
};

export type CopyOutlineUnit = { start: string; end: string; summary: string; roles: string[]; scenes: string[]; items: string[] };

/** 第一步（全局）的产物：资产表 + 分镜大纲 + 全片风格。第二步每个时间窗都以它为「已锁定资产」。 */
export type CopyOverview = {
    title: string;
    ratio: string;
    style: string;
    roles: CopyItem[];
    scenes: CopyItem[];
    items: CopyItem[];
    outline: CopyOutlineUnit[];
};

export type CopyWindowContext = {
    index: number;
    total: number;
    startTime: number;
    endTime: number;
    /** 本窗范围内的切点时间（秒） */
    cuts?: number[];
    /** 第一步锁定的资产表 */
    casting: { roles: CopyItem[]; scenes: CopyItem[]; items: CopyItem[] };
    /** 本窗内的台词（带时间戳，原样使用） */
    transcript: string;
    /** 第一步大纲里落在这个窗的剧情摘要，给模型当上下文 */
    outline?: string;
    /** 本窗前已经说过的台词，用来避免同一句被写两遍 */
    previousDialogue?: string;
    /** 上一窗最后一个单元的收尾状态，用来做连续性 */
    previousEndState?: string;
};

/** 切点列表转成提示词里的短串：太多就折叠，避免把提示词撑长。 */
function formatCuts(cuts: number[] | undefined, max = 40) {
    if (!cuts || !cuts.length) return "";
    const list = cuts.slice(0, max).map((time) => `${time.toFixed(1)}s`);
    if (cuts.length > max) list.push(`等共 ${cuts.length} 处`);
    return list.join("、");
}

const castingLine = (items: CopyItem[]) => items.map((item) => `${item.name}（${item.description || "无描述"}${item.voice ? `；声线：${item.voice}` : ""}）`).join("、");

/** 导演规则：从《AI影视动态分镜生成系统 V2.0》收敛成模型能直接执行的一段。 */
const directingRules = `【导演规则】
1. 单元与节拍：一条分镜=一次视频生成任务出片的单位，5~15 秒；对白密集 5~8 秒，动作/空镜可 10~15 秒。
   原片里的硬切、反打、推拉、台词切换都写进同一单元的节拍里，不要一个切点开一个单元。
   先按台词实际发音时长、呼吸停顿和表演需要定节拍，再让各节拍首尾相接、不重叠、不留空档，总和必须等于单元时长。
   台词不得删减、改写、重复；一句话跨节拍时只写一次，后续节拍写「承接上一拍」。
2. 资产绑定：正文一律用 @资产名 引用，名称与资产表完全一致；已绑定资产不得重新设计五官、年龄、体型、发型、服装与道具外观；禁止凭空增加不存在的人物、场景、道具。
3. 摄影：写清景别、机位高度、拍摄角度、焦段、对焦主体与构图；运动写起始位置、方向、速度、轨迹与停留点；遵守 180° 轴线、视线匹配、动作匹配。不为炫技加运镜。
4. 表演：按「心理动机→眼神落点→微表情→呼吸→身体重心→肢体动作→情绪结果」写；倾听者有真实且带时间差的反应，不抢戏；不无故瞪眼、机械点头、突然变情绪。
5. 声音：每个声音事件标注类型——DIALOGUE（现场对白）/ NARRATION（画外旁白）/ INNER_MONOLOGUE（内心独白）/ OFFSCREEN_DIALOGUE（画外对白）/ DEVICE_VOICE（电话广播等设备声）/ ENVIRONMENT（环境声）/ SFX（动作音效）/ SILENT（纯表演）。
   口型权限只给实际说话者，其他人不得跟读张嘴；旁白是独立声轨，不归属画面人物；不得因镜头切换重复播放或改发声者；未指定不加背景音乐、不加字幕。
6. 连续性与物理：承接上一单元的结束状态（站位、姿态、道具位置、声音）；动作有起始、过程、结束；不得物品突变、左右手互换、位置重置。
7. 画面质感：统一光源方向、色温、曝光、接触阴影；不做塑料感、磨皮、悬浮、畸形。`;

/** 第一步：稀疏宫格 → 资产表 + 分镜大纲。 */
function overviewPrompt(meta: CopyVideoMeta, transcript: string) {
    return `你是一名电影导演、摄影指导和分镜设计师。这是分镜分析的第一步：只看全片稀疏宫格，建立资产表和分镜大纲，不要写逐镜细节。

视频元数据：
- 时长：${meta.duration.toFixed(1)} 秒
- 分辨率：${meta.width}x${meta.height}
- 格数：${meta.frameCount}（按时长均匀抽取，不是每一秒都有一格）
- 每格标了序号和时间点；格子在时间线上分布均匀，短镜头可能没有独立格子。

一、资产表
- roles：每个出场人物一条。description 写外观、年龄、体型、发型、服装、配饰、气质（用于生图，不要写声音）；voice 写性别、声音年龄、音色、音高、共鸣位置、语言/方言、基础语速（用于配音，不要写外观）。
- scenes：每个实际使用的场景一条，写地点、时间、天气、光线、环境布置、关键陈设。
- items：会推动剧情的道具一条，写外观、材质、颜色、状态。
- name 简短唯一；全片同一对象只允许一个 name。不得编写画面里没有出现的人物/场景/道具。

二、分镜大纲（outline）
- 按「一次生视频出片」的单元切分：每单元 5~15 秒，单元数量 ≈ 总时长 ÷ 10（上下浮动 2 个）。
- 每个单元写一句话剧情 summary，并列出本单元涉及的 roles / scenes / items（必须用资产表里的 name）。
- 单元首尾相接、覆盖全片，不留空档；边界落在场景切换、对话停顿或情绪转折处。

三、全片设定
- style：一句话写全片画风、影调、光线、质感、剪辑节奏（例如「冷调写实，低照度侧光，浅景深，手持轻晃，剪辑偏快」）。
- title：一句话概括片子内容；ratio：画面比例，如 9:16。

${transcript ? `【音轨转写台词（带时间戳）】\n${transcript}\n核对台词与画面对应关系；同音字按上下文校正，但不得改写内容。` : "【本片没有可用的音轨转写】按画面唇形和字幕判断台词，看不清写「台词待核对」。"}

只输出 JSON（不要 markdown 代码块）：
{
  "title": "一句话概括",
  "ratio": "9:16",
  "style": "全片风格一句话",
  "roles": [{ "name": "角色名", "description": "外观/服装/发型等", "voice": "性别、声音年龄、音色、音高、共鸣、语言/方言、基础语速" }],
  "scenes": [{ "name": "场景名", "description": "地点/时间/光线/陈设" }],
  "items": [{ "name": "物品名", "description": "外观/材质/颜色/状态" }],
  "outline": [{ "start": "0.0秒", "end": "10.0秒", "summary": "一句话剧情", "roles": ["角色名"], "scenes": ["场景名"], "items": ["物品名"] }]
}

只输出 JSON。`;
}

/** 第二步：逐时间窗细化，产出可直接出片的分镜单元。 */
function windowPrompt(meta: CopyVideoMeta, ctx: CopyWindowContext) {
    const lines = [
        `你是一名电影导演、摄影指导、表演指导和声音导演。这是分镜分析的第二步：把所有已锁定的资产交给模型，细化第 ${ctx.index}/${ctx.total} 个时间窗内的分镜单元。`,
        "",
        "视频元数据：",
        `- 时长：${meta.duration.toFixed(1)} 秒；分辨率：${meta.width}x${meta.height}`,
        `- 本窗范围：${ctx.startTime.toFixed(1)}~${ctx.endTime.toFixed(1)} 秒，宫格里的每一格都落在这个范围内，格子按时间顺序排列并标了时间点。`,
        ctx.cuts && ctx.cuts.length ? `- 本窗检测到 ${ctx.cuts.length} 处切点：${formatCuts(ctx.cuts)}（只作为节拍时间的参考，不要一个切点一个单元）。` : "",
        "",
        "【已锁定资产】以下名称必须原样沿用，不得重新设计，也不得给同一对象另起名字：",
        ctx.casting.roles.length ? `角色：${castingLine(ctx.casting.roles)}` : "角色：无",
        ctx.casting.scenes.length ? `场景：${castingLine(ctx.casting.scenes)}` : "场景：无",
        ctx.casting.items.length ? `物品：${castingLine(ctx.casting.items)}` : "物品：无",
        "本窗新出现、资产表里没有的对象可以补进输出数组，name 同样要简短唯一。",
        "",
        ctx.previousEndState ? `【上一单元结束状态】${ctx.previousEndState}\n本窗第一个节拍必须自然承接它（站位、姿态、道具、声音都不许无原因重置）。` : "",
        ctx.transcript ? `【本窗台词（带时间戳，必须逐字使用）】\n${ctx.transcript}\n台词按时间对齐到节拍；不得改写、增删、重复。时间戳与画面对不上时以画面为准并微调节拍，但台词文字保持原样。` : "【本窗没有可靠台词】按画面唇形/字幕判断，拿不准写「台词待核对」。",
        ctx.previousDialogue ? `【前面单元已经说过的台词（本窗不要重复）】${ctx.previousDialogue}
同一句台词全片只写一次；上一窗开始、本窗仍在延续的声音写「承接上一窗」，不要重抄整段。` : "",
        ctx.outline ? `【本窗剧情大纲】
${ctx.outline}` : "",
        "",
        directingRules,
        "",
        "【输出要求】",
        `- shots 只写完全落在本窗 ${ctx.startTime.toFixed(1)}~${ctx.endTime.toFixed(1)} 秒范围内的单元，按时间排序，首尾相接覆盖本窗。`,
        `- 单元时长 5~15 秒且不得超过本窗长度（${(ctx.endTime - ctx.startTime).toFixed(1)} 秒）；本窗不足 5 秒时只写一个覆盖整窗的单元。`,
        `- start / end / duration 一律用全片绝对时间（本窗起点是 ${ctx.startTime.toFixed(1)} 秒），不要每个窗都从 0.0 秒重新计时。`,
        "- 每个单元的 videoPrompt 第一行是【起-止秒】，之后每行一个节拍：「起-止秒：在 @场景 中，<景别><机位><角度><运动>拍摄。@角色 <位置朝向、动作、眼神、表情>，说道：\"台词\"。」",
        "- 没有台词的节拍写环境声、动作音效或画外音，并标注声音类型。",
        "- 最后一个节拍写清收尾状态（可用「容错时间内保持…」），方便下一单元衔接。",
        "- 结构化字段：shotSize / cameraAngle / cameraMove 写单元主镜头语言；description 写画面从第一帧到最后一帧的变化；performance 写表演要点；sound 写声音事件（带类型）；dialogue 写本单元台词合并文本；onScreenText 写画面文字；roles / scenes / items 写本单元用到的资产名；imagePrompt 写该单元首帧的生图提示词（150 字内，直接引用资产名）。",
        "- title / ratio / style 不用重复输出，可以省略。",
        "",
        "只输出 JSON（不要 markdown 代码块）：",
        `{
  "shots": [{
    "start": "${ctx.startTime.toFixed(1)}秒",
    "end": "${Math.min(ctx.startTime + 8, ctx.endTime).toFixed(1)}秒",
    "duration": "${Math.min(8, ctx.endTime - ctx.startTime).toFixed(1)}秒",
    "videoPrompt": "【${ctx.startTime.toFixed(1)}-${Math.min(ctx.startTime + 8, ctx.endTime).toFixed(1)}秒】\n节拍1起-止秒：在 @场景名 中，…\n节拍2起-止秒：…",
    "shotSize": "特写/近景/中景/全景/远景",
    "cameraAngle": "平视/俯拍/仰拍/正面/侧面/过肩等，含机位高低",
    "cameraMove": "固定/推/拉/摇/移/跟/手持，含起止位置",
    "description": "画面：第一帧到最后一帧的变化",
    "performance": "表演：动机、眼神落点、微表情、呼吸、肢体、情绪落点",
    "sound": "声音：DIALOGUE/NARRATION/ENVIRONMENT/SFX 等，含发声者与起止",
    "dialogue": "本单元台词合并文本（没有则为空字符串）",
    "onScreenText": "画面文字（没有则为空字符串）",
    "imagePrompt": "该单元首帧的图片描述词，150 字以内",
    "roles": ["角色名"],
    "scenes": ["场景名"],
    "items": ["物品名"]
  }],
  "roles": [{ "name": "本窗新角色", "description": "…", "voice": "…" }],
  "scenes": [], "items": []
}

只输出 JSON。`,
    ];
    return lines.filter(Boolean).join("\n");
}

/**
 * 场景检测抽帧：按固定步长采样小缩略图，和上一张比较像素差异，
 * 差异超过阈值就判定为「镜头切换」，保留该时刻的高清帧；再均匀补齐到 maxFrames。
 * 相比固定间隔抽帧，关键镜头不容易漏，重复帧也不会占满额度。
 */
export async function extractSceneFrames(file: File, maxFrames = 60, signal?: AbortSignal): Promise<{ frames: CopyFrame[]; meta: CopyVideoMeta }> {
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
        // 采样步长：短视频 0.2 秒（更容易踩到极短镜头），seek 总数仍控制在 600 以内。
        const step = duration <= 60 ? 0.2 : duration <= 300 ? 0.5 : 1;
        let previous: Uint8ClampedArray | null = null;
        let previousHist: Float32Array | null = null;
        const hist = new Float32Array(HIST_BINS * 3);
        const candidates: { time: number; pixelDiff: number; histDiff: number; dataUrl: string }[] = [];
        for (let t = 0; t < duration; t += step) {
            if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
            await seek(t);
            thumbCtx.drawImage(video, 0, 0, thumb.width, thumb.height);
            const pixels = thumbCtx.getImageData(0, 0, thumb.width, thumb.height).data;
            let pixelDiff = 0;
            if (previous) {
                for (let i = 0; i < pixels.length; i += 4) {
                    pixelDiff += Math.abs(pixels[i] - previous[i]) + Math.abs(pixels[i + 1] - previous[i + 1]) + Math.abs(pixels[i + 2] - previous[i + 2]);
                }
                pixelDiff /= (pixels.length / 4) * 3 * 255;
            }
            previous = new Uint8ClampedArray(pixels);
            // 直方图差分对摇镜、曝光变化不敏感，逐像素差分对同色系硬切更敏感，两个一起用。
            const currentHist = frameHistogram(pixels, hist);
            const histDiff = previousHist ? histogramDistance(currentHist, previousHist) : 0;
            previousHist = Float32Array.from(currentHist);
            fullCtx.drawImage(video, 0, 0, full.width, full.height);
            candidates.push({ time: t, pixelDiff, histDiff, dataUrl: full.toDataURL("image/jpeg", 0.78) });
        }

        // 先按差异找「镜头切换」作为场景边界，再在每个场景内挑帧。
        // 关键约束：每个场景至少留 1 帧（切点后的那一帧最能代表镜头起幅），
        // 切点检测：硬切看瞬时跳变，叠化/淡入淡出看「连续多帧小幅变化」的累积。
        // 选帧时按「每秒一帧 + 切点首帧」，这里只需要边界，不再按场景配额分帧。
        const sceneStarts = detectSceneStarts(candidates);
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
        // 选帧策略：**每秒一帧**打底，再补每个切点的首帧。
        // 之前按场景分配（每场景 1~4 帧）在短剧上密度太低——12 秒的片子可能只给模型 3~6 格，
        // 硬切、手部动作、字幕变化全看不到。对标工具就是 1 fps 铺满整条时间线。
        const sceneIndexOf = (time: number) => {
            let index = 0;
            for (let i = 0; i < scenes.length; i += 1) {
                if (scenes[i].start <= time + 0.001) index = i;
                else break;
            }
            return index;
        };
        const picked: { time: number; scene: number }[] = [];
        const seenTime = new Set<number>();
        const addFrame = (time: number) => {
            const frame = frameAt(time);
            if (seenTime.has(frame.time)) return;
            seenTime.add(frame.time);
            picked.push({ time: frame.time, scene: sceneIndexOf(frame.time) });
        };
        // 1) 每秒一帧（0s, 1s, 2s…），短于 1 秒的间隔也补最后一帧
        for (let t = 0; t < duration; t += 1) addFrame(t);
        addFrame(Math.max(0, duration - 0.05));
        // 2) 每个切点的首帧：1 秒网格可能正好跨过极短的硬切，补上才不会漏镜头
        sceneStarts.slice(1).forEach((item) => addFrame(item.time));

        const uniqueByTime = new Map<number, { time: number; scene: number }>();
        picked.forEach((item) => {
            if (!uniqueByTime.has(item.time)) uniqueByTime.set(item.time, item);
        });
        let pickedFrames = Array.from(uniqueByTime.values()).sort((a, b) => a.time - b.time);
        if (pickedFrames.length > maxFrames) {
            // 超预算：先保住每个切点的首帧（镜头起幅最要紧），剩下的按时间均匀抽，别让某段整段消失
            const cutTimes = new Set(sceneStarts.map((item) => item.time));
            const cuts = pickedFrames.filter((item) => cutTimes.has(item.time));
            const others = pickedFrames.filter((item) => !cutTimes.has(item.time));
            const room = Math.max(0, maxFrames - cuts.length);
            const thinned = room > 0 ? Array.from({ length: room }, (_, i) => others[Math.round((i * (others.length - 1)) / Math.max(1, room - 1))]) : [];
            pickedFrames = [...cuts, ...thinned].filter((item, index, list) => list.findIndex((other) => other.time === item.time) === index).sort((a, b) => a.time - b.time);
        }
        const finalPicked = pickedFrames
            .slice(0, maxFrames)
            .map((item) => ({ ...item, frame: candidates.find((candidate) => candidate.time === item.time) ?? frameAt(item.time) }));

        return {
            frames: finalPicked.map((item) => ({ time: item.time, dataUrl: item.frame.dataUrl, scene: item.scene })),
            meta: { duration, width, height, frameCount: finalPicked.length, sceneCount: sceneStarts.length, cuts: sceneStarts.map((item) => Number(item.time.toFixed(2))) },
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
/** 提交一次分析任务并轮询到完成，返回模型输出原文（提交/查询都走登录态）。 */
async function runAnalyzeJob(sessionToken: string, model: string, prompt: string, image: string, signal?: AbortSignal): Promise<string> {
    if (!sessionToken.trim()) throw new Error("请先登录后再分析");
    // 走异步任务：长请求会被链路中间代理 120s 掐断，改成「提交 + 轮询」。
    // 用同源相对路径：`/api/user/**` 挂的是 UserAuth，只认后台登录态 token；
    // 渠道里那个中转 key（sk-...）会被判成「access token 无效」。
    // key 和 baseUrl 都不再上传 —— 服务端按登录用户自己取令牌、地址固定本机回环，
    // 既不让凭证出现在请求体里，也避免 baseUrl 被拿去打内网（SSRF）。
    const endpoint = "/api/user/copy/analyze";
    const headers = { Authorization: `Bearer ${sessionToken.trim()}` };
    // 把后端的中文 message（如「access token 无效」）透出来，别只显示 HTTP 401。
    const submit = await axios.post(endpoint, { model, prompt, image }, { headers, signal, timeout: 30000 }).catch((error: unknown) => {
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
        if (data.status === "done") return String(data.content || "");
        if (data.status === "failed") throw new Error(data.error || "分析失败");
    }
}

/** 第一步：全片资产表 + 分镜大纲。 */
export async function analyzeOverview(
    gridDataUrl: string,
    meta: CopyVideoMeta,
    model: string,
    sessionToken: string,
    transcript = "",
    signal?: AbortSignal,
): Promise<CopyOverview> {
    const content = await runAnalyzeJob(sessionToken, model, overviewPrompt(meta, transcript), gridDataUrl, signal);
    return normalizeOverview(extractJson(content));
}

/** 第二步：按时间窗逐个细化分镜单元。 */
export async function analyzeShotsWindow(
    gridDataUrl: string,
    meta: CopyVideoMeta,
    model: string,
    sessionToken: string,
    ctx: CopyWindowContext,
    signal?: AbortSignal,
): Promise<CopyAnalysis> {
    const content = await runAnalyzeJob(sessionToken, model, windowPrompt(meta, ctx), gridDataUrl, signal);
    return clampWindowShots(normalizeAnalysis(extractJson(content)), ctx.startTime, ctx.endTime);
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

export type TranscriptSegment = { start: number; end: number; text: string };

/** "1:02:03,400" / "02:03.4" / "12.5" → 秒。 */
function timecodeToSeconds(value: string) {
    const text = String(value || "").trim().replace(",", ".");
    const parts = text.split(":").map((part) => Number(part));
    if (parts.some((part) => !Number.isFinite(part))) return NaN;
    return parts.reduce((acc, part) => acc * 60 + part, 0);
}

/**
 * 解析带时间戳的转写：支持
 *   [00:00:01,240 --> 00:00:03,500] 台词
 *   [00:01 - 00:03] 台词
 *   [00:01,240 - 00:03,500] 台词
 * 没有时间戳的整段文本返回空数组（调用方降级为「不带时间轴的台词」）。
 */
export function parseTranscript(raw: string): TranscriptSegment[] {
    const text = String(raw || "");
    if (!text.trim()) return [];
    const segments: TranscriptSegment[] = [];
    const pattern = /\[\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\s*(?:-->|->|~|-|,)\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\s*\]\s*([^\[\n]+)/g;
    for (const match of text.matchAll(pattern)) {
        const start = timecodeToSeconds(match[1]);
        const end = timecodeToSeconds(match[2]);
        const line = match[3].trim();
        if (!line || !Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
        segments.push({ start, end, text: line });
    }
    if (segments.length) return segments.sort((a, b) => a.start - b.start);
    // 兜底：只有单个时间点（[0:00:12,300] 台词）的格式，用下一行的时间点当结束，
    // 最后一行没有下一行时按 3 秒补齐。
    const points: { time: number; text: string }[] = [];
    const pointPattern = /\[\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\s*\]\s*([^\[\n]+)/g;
    for (const match of text.matchAll(pointPattern)) {
        const time = timecodeToSeconds(match[1]);
        const line = match[2].trim();
        if (line && Number.isFinite(time)) points.push({ time, text: line });
    }
    return points
        .sort((a, b) => a.time - b.time)
        .map((point, index) => ({ start: point.time, end: index + 1 < points.length ? points[index + 1].time : point.time + 3, text: point.text }));
}

/** 整片台词（给第一步做全局理解用）。没有时间戳时原样返回。 */
export function formatTranscript(raw: string, segments: TranscriptSegment[]) {
    if (!segments.length) return String(raw || "").trim();
    return segments.map((segment) => `${segment.start.toFixed(1)}-${segment.end.toFixed(1)}秒：${segment.text}`).join("\n");
}

/** 只取落在时间窗内的台词，前后各放 1 秒容差，避免跨边界的半句被切掉。 */
export function transcriptForWindow(segments: TranscriptSegment[], start: number, end: number) {
    // 按**句首时间**归属：一句台词只落在开始时间所在的那个窗口里。
    // 之前用「区间有重叠就带上」，跨窗的句子会在相邻两个窗口各出现一次，
    // 结果两个分镜把同一段台词原样写了两遍。
    return segments
        .filter((segment) => segment.start >= start - 0.3 && segment.start < end)
        .map((segment) => `${segment.start.toFixed(1)}-${segment.end.toFixed(1)}秒：${segment.text}`)
        .join("\n");
}

/** 角色/场景/物品 → 生成一张参考图（返回 dataUrl 或图片 URL）。提示词由调用方按素材类型拼好。 */
export async function generateItemImage(config: AiConfig, prompt: string, signal?: AbortSignal): Promise<string> {
    const images = await requestGeneration({ ...config, count: "1" }, prompt, { signal });
    if (!images.length) throw new Error("生图没有返回结果");
    return images[0].dataUrl;
}

/** 分镜 → 生成该镜首帧图（返回 dataUrl）；有参考图时走图生图，人物和场景更贴近原片。 */
export async function generateShotImage(config: AiConfig, shot: CopyShot, references: ReferenceImage[] = [], style = "", signal?: AbortSignal): Promise<string> {
    const prompt = shotImagePrompt(shot, style);
    const images = references.length
        ? await requestEdit({ ...config, count: "1" }, prompt, references, { signal })
        : await requestGeneration({ ...config, count: "1" }, prompt, { signal });
    if (!images.length) throw new Error("生图没有返回结果");
    return images[0].dataUrl;
}

/** 分镜图提示词：优先用模型写好的 imagePrompt，没有就按分镜字段拼一段。 */
export function shotImagePrompt(shot: CopyShot, style = ""): string {
    const camera = [shot.shotSize, shot.cameraAngle, shot.cameraMove].filter(Boolean).join("，");
    const body = shot.imagePrompt || [camera, shot.description, shot.performance].filter(Boolean).join("。");
    return [style ? `风格：${style}` : "", body].filter(Boolean).join("\n");
}

/**
 * 批量「生成图片描述词」：把分镜已有的画面/镜头/角色字段拼成一条可直接生图的提示词，
 * 用于模型漏写 imagePrompt 时补全（和参考产品一样，可以再手动改）。
 */
export function composeShotImagePrompt(shot: CopyShot, analysis: CopyAnalysis): string {
    const describe = (names: string[], list: CopyItem[]) =>
        names
            .map((name) => {
                const item = list.find((entry) => entry.name === name);
                return item && item.description ? `${item.name}（${item.description}）` : name;
            })
            .filter(Boolean)
            .join("；");
    const camera = [shot.shotSize, shot.cameraAngle, shot.cameraMove].filter(Boolean).join("，");
    const lines = [
        analysis.style ? `风格：${analysis.style}` : "",
        camera ? `镜头：${camera}` : "",
        shot.description ? `画面：${shot.description}` : "",
        shot.roles.length ? `角色：${describe(shot.roles, analysis.roles)}` : "",
        shot.scenes.length ? `场景：${describe(shot.scenes, analysis.scenes)}` : "",
        shot.items.length ? `物品：${describe(shot.items, analysis.items)}` : "",
    ];
    return lines.filter(Boolean).join("\n");
}

/** 每个分镜配一张「原视频分镜图」：按分镜起始时间取最近的抽帧。 */
export function matchFramesToShots(analysis: CopyAnalysis, frames: CopyFrame[]): Record<string, string> {
    const map: Record<string, string> = {};
    if (!frames.length) return map;
    for (const shot of analysis.shots) {
        const start = shotStartSeconds(shot.start);
        let best = frames[0];
        let delta = Math.abs(best.time - start);
        for (const frame of frames) {
            const next = Math.abs(frame.time - start);
            if (next < delta) {
                best = frame;
                delta = next;
            }
        }
        map[shot.id] = best.dataUrl;
    }
    return map;
}

/** 分镜 → 生成一段视频（首帧参考图可选），返回已入库的素材（url + storageKey）。 */
export async function generateShotVideo(
    config: AiConfig,
    shot: CopyShot,
    references: ReferenceImage[] = [],
    style = "",
    signal?: AbortSignal,
): Promise<UploadedFile> {
    const prompt = shotPrompt(shot, style);
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
export function shotPrompt(shot: CopyShot, style = ""): string {
    // 分析阶段已经写好「整段范围 + 逐节拍时间线」，直接用它出片；老数据没有时才按字段拼。
    const camera = [shot.shotSize, shot.cameraAngle, shot.cameraMove].filter(Boolean).join("，");
    const body = String(shot.videoPrompt || "").trim() || [camera, shot.description, shot.performance, shot.dialogue ? `台词：${shot.dialogue}` : "", shot.onScreenText ? `画面文字：${shot.onScreenText}` : ""].filter(Boolean).join("\n");
    const prompt = [style ? `风格：${style}` : "", body].filter(Boolean).join("\n");
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
        const candidate = head + closers.reverse().join("\n");
        if (parseJsonLoose(candidate)) return candidate;
    }
    return "";
}

function normalizeItems(value: unknown, section: "roles" | "scenes" | "items", stamp: number): CopyItem[] {
    return (Array.isArray(value) ? value : [])
        .map((item, index) => {
            const record = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
            const name = String(record.name ?? "").trim();
            if (!name) return null;
            return {
                id: `${section}-${stamp}-${index}`,
                name,
                description: String(record.description ?? "").trim(),
                ...(section === "roles" ? { voice: String(record.voice ?? "").trim() } : {}),
            };
        })
        .filter((item): item is CopyItem => Boolean(item));
}

export function normalizeOverview(raw: Record<string, unknown>): CopyOverview {
    const stamp = Date.now();
    const outline: CopyOutlineUnit[] = (Array.isArray(raw.outline) ? raw.outline : [])
        .map((unit) => {
            const record = (unit && typeof unit === "object" ? unit : {}) as Record<string, unknown>;
            const asList = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
            return {
                start: String(record.start ?? "").trim(),
                end: String(record.end ?? "").trim(),
                summary: String(record.summary ?? "").trim(),
                roles: asList(record.roles),
                scenes: asList(record.scenes),
                items: asList(record.items),
            };
        })
        .filter((unit) => unit.start && unit.end);
    return {
        title: String(raw.title ?? "").trim() || "爆款转绘",
        ratio: String(raw.ratio ?? "").trim(),
        style: String(raw.style ?? "").trim(),
        roles: normalizeItems(raw.roles, "roles", stamp),
        scenes: normalizeItems(raw.scenes, "scenes", stamp),
        items: normalizeItems(raw.items, "items", stamp),
        outline,
    };
}

/** 把第二步产出的实体并回第一步的资产表：同名的以资产表为准，新出现的追加。 */
export function mergeCasting(overview: CopyOverview, extra: { roles: CopyItem[]; scenes: CopyItem[]; items: CopyItem[] }) {
    const merge = (base: CopyItem[], add: CopyItem[]) => {
        const names = new Set(base.map((item) => item.name));
        return [...base, ...add.filter((item) => !names.has(item.name))];
    };
    return {
        roles: merge(overview.roles, extra.roles),
        scenes: merge(overview.scenes, extra.scenes),
        items: merge(overview.items, extra.items),
    };
}

/**
 * 窗口产出的时间要归一：模型可能写成窗内相对时间（从 0 开始），也可能越过窗口边界。
 * 这里统一映射成全片绝对时间并夹在本窗内，单元时长封顶 15 秒；完全落在窗外的丢弃。
 * 不做这一步，几个窗口会各自从 0 秒开始，合并时按起始时间去重，后面的单元就全没了。
 */
export function clampWindowShots(analysis: CopyAnalysis, start: number, end: number): CopyAnalysis {
    const shots = analysis.shots
        .map((shot) => {
            let s = shotStartSeconds(shot.start);
            let e = shotStartSeconds(shot.end);
            if (!Number.isFinite(s)) s = start;
            if (!Number.isFinite(e) || e <= s) e = s + Math.min(8, Math.max(1, end - s));
            // 窗内相对时间 → 绝对时间（只对非首个窗口做，避免把 0.x 秒的合法起点改坏）
            if (start > 0.05 && s < start - 0.5) {
                s += start;
                e += start;
            }
            s = Math.max(start, Math.min(s, Math.max(start, end - 0.1)));
            e = Math.min(end, Math.max(s + 0.1, e));
            if (e - s > 15) e = s + 15;
            return { ...shot, start: `${s.toFixed(1)}秒`, end: `${e.toFixed(1)}秒`, duration: `${(e - s).toFixed(1)}秒` };
        })
        .filter((shot) => Number(shot.end.replace(/[^0-9.]/g, "")) > Number(shot.start.replace(/[^0-9.]/g, "")));
    return { ...analysis, shots };
}

function normalizeAnalysis(raw: Record<string, unknown>): CopyAnalysis {
    const stamp = Date.now();
    // id 必须按分区加前缀：roles/scenes/items 各自从 0 开始编号，
    // 之前三个分区都用 `item-<stamp>-<index>`，导致角色 0 / 场景 0 / 物品 0 是同一个 id，
    // 生成一张图会同时显示在三个分区里（itemImages 是按 id 存的），后续生成还会互相覆盖。
    const toItems = (value: unknown, section: "roles" | "scenes" | "items"): CopyItem[] => normalizeItems(value, section, stamp);
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
                    videoPrompt: text("videoPrompt"),
                    shotSize: text("shotSize"),
                    cameraAngle: text("cameraAngle"),
                    cameraMove: text("cameraMove"),
                    description: text("description"),
                    performance: text("performance"),
                    sound: text("sound"),
                    dialogue: text("dialogue"),
                    onScreenText: text("onScreenText"),
                    imagePrompt: text("imagePrompt"),
                    roles: asList(record.roles),
                    scenes: asList(record.scenes),
                    items: asList(record.items),
                };
            })
            .filter((shot) => shot.description || shot.roles.length);
    return {
        title: String(raw.title ?? "").trim() || "爆款转绘",
        ratio: String(raw.ratio ?? "").trim(),
        style: String(raw.style ?? "").trim(),
        roles: toItems(raw.roles, "roles"),
        scenes: toItems(raw.scenes, "scenes"),
        items: toItems(raw.items, "items"),
        shots: toShots(raw.shots),
    };
}

/**
 * 按时间窗切帧：从第一步的单元大纲出发，每窗 frames 帧连续覆盖一段时间。
 * 和按场景切不同，这里保证一窗只覆盖一段连续时间，分镜单元不会跨窗。
 */
export function groupFramesIntoWindows(frames: CopyFrame[], secondsPerWindow = 12, maxCells = 16): CopyFrame[][] {
    const sorted = [...frames].sort((a, b) => a.time - b.time);
    if (!sorted.length) return [];
    // 按**时长**切窗，不按帧数：短视频是 0.2 秒一帧，按帧数切会把 10 秒的片子拆成 4 个 3 秒的小窗，
    // 模型就没法在里面排出 5~15 秒的单元。窗内帧太多时再抽稀，保证单张宫格看得清。
    const windows: CopyFrame[][] = [];
    let current: CopyFrame[] = [];
    for (const frame of sorted) {
        if (current.length && frame.time - current[0].time >= secondsPerWindow) {
            windows.push(current);
            current = [];
        }
        current.push(frame);
    }
    if (current.length) windows.push(current);
    return windows.map((windowFrames) => sampleFrames(windowFrames, maxCells));
}

/** 取大纲里和本窗重叠的条目，作为窗口提示词的剧情上下文。 */
export function outlineForWindow(outline: CopyOutlineUnit[], start: number, end: number) {
    return outline
        .filter((unit) => shotStartSeconds(unit.end) >= start - 0.5 && shotStartSeconds(unit.start) <= end + 0.5)
        .map((unit) => `${unit.start}-${unit.end}：${unit.summary}`)
        .join("\n");
}

/** 均匀抽稀到 max 帧（保留首尾），给第一步的「全局视图」用。 */
export function sampleFrames(frames: CopyFrame[], max = 24): CopyFrame[] {
    const sorted = [...frames].sort((a, b) => a.time - b.time);
    if (sorted.length <= max) return sorted;
    const picked: CopyFrame[] = [];
    for (let index = 0; index < max; index += 1) picked.push(sorted[Math.round((index * (sorted.length - 1)) / (max - 1))]);
    return picked.filter((frame, index, list) => list.findIndex((other) => other.time === frame.time) === index);
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
        style: valid.find((result) => result.style)?.style ?? "",
        roles: mergeList("roles"),
        scenes: mergeList("scenes"),
        items: mergeList("items"),
        shots: shots.map((shot, index) => ({ ...shot, id: `shot-${stamp}-${index}` })),
    };
}

/** 合并后再兜一层：后一个分镜的台词整段包含/被包含于前面某段时清空，避免同一段被写两遍。 */
export function dropRepeatedDialogue(analysis: CopyAnalysis): CopyAnalysis {
    const seen: string[] = [];
    const shots = analysis.shots.map((shot) => {
        const text = String(shot.dialogue || "").trim();
        if (!text) return shot;
        const repeated = seen.some((prev) => prev.length > 15 && (prev.includes(text) || text.includes(prev)));
        seen.push(text);
        return repeated ? { ...shot, dialogue: "" } : shot;
    });
    return { ...analysis, shots };
}

/** 时间码归一成秒：支持 "1:02.4"、"12.5秒"、"0.0秒"。 */
function shotStartSeconds(value: string) {
    const text = String(value ?? "").trim();
    const clock = text.match(/(\d+):(\d+(?:\.\d+)?)/);
    if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
    const numeric = Number(text.replace(/[^0-9.]/g, ""));
    return Number.isFinite(numeric) ? numeric : 0;
}

/**
 * 修复早期数据里的 id 撞车：那时 roles/scenes/items 都用 `item-<stamp>-<index>`，
 * 三个分区的第 0 项是同一个 id，生成一张图会同时显示在三个地方，批量生成还会互相覆盖。
 *
 * 载入历史记录时跑一次：按分区重写 id，并给出「老 id → 新 id」的映射，
 * 素材表跟着迁移。同一个老 id 被多个分区占用的，图归第一个占用者（角色 → 场景 → 物品）。
 */
export function sanitizeItemIds(analysis: CopyAnalysis): { analysis: CopyAnalysis; remap: Record<string, string> } {
    const stamp = Date.now();
    const claimed = new Set<string>();
    const remap: Record<string, string> = {};
    const fix = (list: CopyItem[], section: "roles" | "scenes" | "items") =>
        list.map((item, index) => {
            const oldId = String(item.id ?? "");
            const newId = `${section}-${stamp}-${index}`;
            if (oldId) {
                if (!claimed.has(oldId) && remap[oldId] === undefined) remap[oldId] = newId;
                claimed.add(oldId);
            }
            return { ...item, id: newId };
        });
    return {
        analysis: {
            ...analysis,
            roles: fix(analysis.roles ?? [], "roles"),
            scenes: fix(analysis.scenes ?? [], "scenes"),
            items: fix(analysis.items ?? [], "items"),
        },
        remap,
    };
}
