// 上游把「内部细节」直接写进错误正文：渠道号、每次报价、"channel 可传渠道 id 或渠道名，
// 留空则用当前使用渠道" 这类只有对接人才看得懂的说明。这些话对终端用户没有意义，
// 还会把进货价暴露出去，所以命中就整段换成一句人话。
//
// 只认上游的固定说法，不做模糊猜测：自家后端的提示（余额不足、模型不存在…）照原样透出。
import i18n from "@/i18n";

const UPSTREAM_LINE_PATTERNS = [/渠道不可用/, /当前可用渠道/, /可用渠道为/, /channel\s*可传渠道/, /is not served by/i, /not served by this plugin/i];

/** 上游「请求失败/超时」类错误（do request failed 等）→ 请稍后重试。 */
const UPSTREAM_RETRY_PATTERNS = [/do request failed/i, /upstream error/i];

/** 网关返回的 HTML 错误页（nginx 502/504 白页等）→ 请稍后重试，绝不把 HTML 原文当内容展示。 */
const HTML_DOC_PATTERN = /<(?:html|head|body|title)[\s>]/i;

/** 上游线路/渠道/请求失败类错误 → 一句可展示的提示；其它错误原样返回。 */
export function humanizeUpstreamError(message: string): string {
    if (!message) return message;
    if (HTML_DOC_PATTERN.test(message)) return i18n.t("apiErrors.pleaseRetryLater");
    if (UPSTREAM_LINE_PATTERNS.some((pattern) => pattern.test(message))) return i18n.t("apiErrors.upstreamLineUnavailable");
    if (UPSTREAM_RETRY_PATTERNS.some((pattern) => pattern.test(message))) return i18n.t("apiErrors.pleaseRetryLater");
    return message;
}
