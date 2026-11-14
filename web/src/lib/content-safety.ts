/**
 * 上游内容审核拦截的识别。
 *
 * Seedance / miniKey 这类上游把「内容未通过安全审核」和普通生成失败放在同一个
 * status=failed + error 字段里返回，客户端只能靠文案区分。区分开才有意义：
 * 审核失败要引导用户改提示词或换参考素材，反复点重试是没用的。
 *
 * 判定刻意宽松（宁可把普通失败当审核失败提示一次，也不要让用户对着一句
 * 「内容未通过安全审核」干瞪眼），所以只匹配上游确实在用的说法。
 */
const SAFETY_BLOCK_PATTERNS = [/安全审核/, /内容审核/, /审核未通过/, /未通过审核/, /违规/, /敏感内容/, /sensitive/i, /moderation/i, /content policy/i, /safety filter/i, /flagged/i];

export function isContentSafetyBlock(reason?: string | null): boolean {
    if (!reason) return false;
    return SAFETY_BLOCK_PATTERNS.some((pattern) => pattern.test(reason));
}
