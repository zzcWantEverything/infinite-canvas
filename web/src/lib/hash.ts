import { sha256 } from "@noble/hashes/sha2.js";

type SubtleCryptoLike = { digest: (algorithm: string, data: BufferSource) => Promise<ArrayBuffer> };

/**
 * 计算 SHA-256 十六进制摘要。
 * crypto.subtle 只在安全上下文（HTTPS 或 localhost）暴露，用 http 访问局域网或公网 IP 时它是 undefined，
 * 所以这里回退到纯 JS 实现，保证上传参考素材在明文 HTTP 下也能用。
 */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
    const subtle = (globalThis.crypto as { subtle?: SubtleCryptoLike } | undefined)?.subtle;
    const digest = subtle ? await subtle.digest("SHA-256", data) : sha256(new Uint8Array(data));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
