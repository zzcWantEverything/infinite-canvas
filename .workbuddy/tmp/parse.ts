const TIMECODE = "\\d{1,2}:\\d{1,2}(?::\\d{1,2})?(?:[.,]\\d{1,3})?";

/** 按中文/英文句末标点和换行拆句。 */
function splitSentences(text: string) {
    return String(text || "")
        .split(/(?<=[。！？!?；;])|\n+/)
        .map((line) => line.trim())
        .filter(Boolean);
}

/**
 * 腾讯经常把一整段话识别成一句（`[0:0.000,0:30.080] 全文…`）。
 * 这种整句没法按时间窗分配，按标点拆句后按字数比例分摊时间，至少每个窗口只拿到属于自己那段。
 * 时间比例是估算，提示词里已要求「时间戳与画面对不上时以画面为准」。
 */
function splitBySentence(segment: TranscriptSegment): TranscriptSegment[] {
    const sentences = splitSentences(segment.text);
    if (sentences.length <= 1) return [segment];
    const total = sentences.reduce((sum, sentence) => sum + sentence.length, 0) || 1;
    const span = Math.max(0.1, segment.end - segment.start);
    let cursor = segment.start;
    return sentences.map((sentence) => {
        const next = { start: cursor, end: cursor + (span * sentence.length) / total, text: sentence };
        cursor = next.end;
        return next;
    });
}

export function parseTranscript(raw: string): TranscriptSegment[] {
    const text = String(raw || "");
    if (!text.trim()) return [];
    const segments: TranscriptSegment[] = [];
    const range = new RegExp(`\\[\\s*(${TIMECODE})\\s*(?:-->|->|~|-|,)\\s*(${TIMECODE})\\s*\\]\\s*([^\\[\\n]+)`, "g");
    for (const match of text.matchAll(range)) {
        const start = timecodeToSeconds(match[1]);
        const end = timecodeToSeconds(match[2]);
        const line = match[3].trim();
        if (!line || !Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
        segments.push({ start, end, text: line });
    }
    if (segments.length) return segments.sort((a, b) => a.start - b.start).flatMap(splitBySentence);
    // 兜底：只有单个时间点（[0:00:12,300] 台词）的格式，用下一行的时间点当结束，最后一行按 3 秒补齐。
    const points: { time: number; text: string }[] = [];
    const pointPattern = new RegExp(`\\[\\s*(${TIMECODE})\\s*\\]\\s*([^\\[\\n]+)`, "g");
    for (const match of text.matchAll(pointPattern)) {
        const time = timecodeToSeconds(match[1]);
        const line = match[2].trim();
        if (line && Number.isFinite(time)) points.push({ time, text: line });
    }
    return points
        .sort((a, b) => a.time - b.time)
        .map((point, index) => ({ start: point.time, end: index + 1 < points.length ? points[index + 1].time : point.time + 3, text: point.text }))
        .flatMap(splitBySentence);
}

/** 完全没有时间戳时：把整段按句子均分到全片时长。 */
export function spreadTranscript(raw: string, duration: number): TranscriptSegment[] {
    const sentences = splitSentences(raw);
    if (!sentences.length || !Number.isFinite(duration) || duration <= 0) return [];
    const total = sentences.reduce((sum, sentence) => sum + sentence.length, 0) || 1;
    let cursor = 0;
    return sentences.map((sentence) => {
        const span = (duration * sentence.length) / total;
        const segment = { start: cursor, end: cursor + span, text: sentence };
        cursor += span;
        return segment;
    });
}
