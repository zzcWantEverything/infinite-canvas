// 上游把「内部细节」直接写进错误正文：渠道号、每次报价、"channel 可传渠道 id 或渠道名，
// 留空则用当前使用渠道" 这类只有对接人才看得懂的说明；miniKey 那类中转还会把整段
// curl/images[] 教程、积分单价、倍率一起塞进来。
//
// 约定：**前端只展示 categorization 之后的固定说法**。命中规则就整段替换，不做截断拼接，
// 因为截断只会把「4.00 元/次」这类片段露出来。
//
// 顺序有意义：先识别「绝对不能露」的价格，再按内容/超时/繁忙归类，最后才看是否像上游内部文案。
import i18n from "@/i18n";

const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

/** 网关返回的 HTML 错误页（nginx 502/504 白页等）→ 请稍后重试，绝不把 HTML 原文当内容展示。 */
const HTML_DOC_PATTERN = /<(?:html|head|body|title)[\s>]/i;

/** 价格相关信息：货币符号+数字、金额+元/积分、倍率/单价，以及英文的 price/billing/credit。 */
const UPSTREAM_PRICE_PATTERN =
    /(?:[¥￥$]\s*\d)|(?:\d+(?:\.\d+)?\s*(?:元|积分))|(?:倍率|单价|进货|成本价|充值|计费|扣费)|(?:\bprice\b|\bbilling\b|\bcredits?\b)/i;

/** 只有对接人看得懂的内部文案：渠道号、upstream、原始 JSON 结构、curl 示例。 */
const UPSTREAM_INTERNAL_PATTERN = /(channel\s*#|status_code\s*=|"detail"\s*:|curl\s+-F|images\[\]|"request_id"|上游|渠道号|not served by|可传渠道)/i;

const CONTENT_BLOCKED_PATTERN = /(审核|安全策略|内容安全|违规|content\s*policy|safety\s*system|sensitive)/i;
const TIMEOUT_PATTERN = /(超时|timeout|timed?\s*out|deadline|未能在截止)/i;
const BUSY_PATTERN = /(限流|繁忙|过热|过载|负载|容量不足|并发|排队|rate\s*limit|overload|too\s*many\s*requests|系统繁忙)/i;
/** 参数类拒绝：比例/分辨率/时长不在模型支持范围内。 */
const PARAM_PATTERN =
    /(不支持|不被支持|参数.{0,8}(错误|无效|不合法|超范围)|invalid[_\s-]*(request|parameter|value|argument)|must\s+be\s+one\s+of|not\s+supported|unsupported|out\s+of\s+range|\b400\b)/i;

/** 上游「请求失败/超时」类错误（do request failed 等）→ 请稍后重试。 */
const UPSTREAM_RETRY_PATTERNS = [/do request failed/i, /upstream error/i];

/** 旧的「线路不可用」说法，保留向后兼容。 */
const UPSTREAM_LINE_PATTERNS = [/渠道不可用/, /当前可用渠道/, /可用渠道为/, /channel\s*可传渠道/, /is not served by/i, /not served by this plugin/i];

/**
 * 上游校验「提示词引用的参考图编号 > 实际收到的素材数」时，会把一整段
 * curl/images[] 教程塞进错误正文（miniKey 的 502）。对终端用户只留下原因。
 */
const UPSTREAM_IMAGE_REFERENCE_PATTERNS = [/提示词引用了[\s\S]{0,80}参考图/];

/** 超过这个长度基本是上游把接口文档贴过来了，不是给用户看的。 */
const RAW_UPSTREAM_LENGTH = 160;

/**
 * 把任意错误文案收敛成一句可直接展示的提示。
 *
 * 规则：
 *  1. HTML 错误页 → 请稍后重试
 *  2. 含价格/积分/倍率 → 线路不可用（价格绝不出现在前端）
 *  3. 审核 / 超时 / 繁忙 → 对应的固定说法
 *  4. 含上游内部标记或过长 → 线路不可用 / 请稍后重试
 *  5. 其余（我们自己后端写的短文案，如「额度不足」「提示词不能为空」）原样透出
 */
export function humanizeUpstreamError(message: string): string {
    const text = (message || "").trim();
    if (!text) return text;
    if (HTML_DOC_PATTERN.test(text)) return apiText("pleaseRetryLater");
    if (UPSTREAM_IMAGE_REFERENCE_PATTERNS.some((pattern) => pattern.test(text))) return apiText("imageReferenceMismatch");
    // 价格必须先判：它可能同时命中「繁忙」之类的词，但一旦露价就没法收回。
    if (UPSTREAM_PRICE_PATTERN.test(text)) return apiText("upstreamLineUnavailable");
    if (CONTENT_BLOCKED_PATTERN.test(text)) return apiText("contentBlocked");
    if (TIMEOUT_PATTERN.test(text)) return apiText("generationTimeout");
    if (BUSY_PATTERN.test(text)) return apiText("lineBusy");
    if (PARAM_PATTERN.test(text)) return apiText("upstreamParamInvalid");
    if (UPSTREAM_LINE_PATTERNS.some((pattern) => pattern.test(text))) return apiText("upstreamLineUnavailable");
    if (UPSTREAM_RETRY_PATTERNS.some((pattern) => pattern.test(text))) return apiText("pleaseRetryLater");
    if (UPSTREAM_INTERNAL_PATTERN.test(text) || text.length > RAW_UPSTREAM_LENGTH) return apiText("upstreamLineUnavailable");
    return text;
}
