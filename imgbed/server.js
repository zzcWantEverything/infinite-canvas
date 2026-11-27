// Minimal image bed: accepts a file upload, stores it on disk, and serves the
// file publicly. Behind nginx auth_request (external /imgbed/upload requires valid
// new-api auth) and private Docker network for internal new-api uploads.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 8081);
const DATA_DIR = process.env.DATA_DIR || "/data";
const PUBLIC_DIR = path.join(DATA_DIR, "public");
const MAX_BYTES = Number(process.env.MAX_BYTES || 20) * 1024 * 1024; // 20 MB default
const MAX_CONCURRENT_UPLOADS = Number(process.env.MAX_CONCURRENT_UPLOADS || 4);
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "video/mp4", "audio/mpeg", "audio/wav", "audio/mp3"]);
const ALLOWED_UPLOAD_ORIGIN_RE = /^https?:\/\/(huayou\.cloud|localhost(:\d+)?|127\.0\.0\.1(:\d+)?)$/i;

fs.mkdirSync(PUBLIC_DIR, { recursive: true });

const MIME_TO_EXT = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
  "video/mp4": "mp4", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/mp3": "mp3",
};

// Served files must carry a real MIME type: browsers refuse to render images sent
// as application/octet-stream once X-Content-Type-Options: nosniff is in play.
// nosniff 本身由前置 nginx 统一加（见 snippets/security-headers.conf），这里不重复。
const EXT_TO_MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
  mp4: "video/mp4", mp3: "audio/mpeg", wav: "audio/wav",
};

let activeUploads = 0;

function corsOrigin(req, publicRead) {
  if (publicRead) return "*";
  const origin = req.headers.origin || "";
  if (ALLOWED_UPLOAD_ORIGIN_RE.test(origin)) return origin;
  return "https://huayou.cloud";
}

function send(req, res, status, body, publicRead = false) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": corsOrigin(req, publicRead),
    "Vary": "Origin",
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function matchesMagicBytes(buf, mime) {
  if (!buf || buf.length < 12) return false;
  switch (mime) {
    case "image/png":
      return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    case "image/jpeg":
      return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case "image/gif":
      return buf.slice(0, 6).toString("ascii") === "GIF87a" || buf.slice(0, 6).toString("ascii") === "GIF89a";
    case "image/webp":
      return buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP";
    case "video/mp4":
      return buf.slice(4, 8).toString("ascii") === "ftyp";
    case "audio/wav":
      return buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WAVE";
    case "audio/mpeg":
    case "audio/mp3":
      return buf.slice(0, 3).toString("ascii") === "ID3" || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0);
    default:
      return false;
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": corsOrigin(req, false),
      "Access-Control-Allow-Methods": "POST, GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Vary": "Origin",
    });
    return res.end();
  }

  // GET / HEAD /public/<file> — serve the stored file.
  if ((req.method === "GET" || req.method === "HEAD") && req.url.startsWith("/public/")) {
    const cleanPath = req.url.split("?")[0];
    const base = path.basename(cleanPath);
    if (!/^[a-f0-9]{16,64}\.(png|jpg|jpeg|webp|gif|mp4|mp3|wav)$/i.test(base)) {
      return send(req, res, 404, { error: "not found" }, true);
    }
    const filePath = path.join(PUBLIC_DIR, base);
    if (!filePath.startsWith(PUBLIC_DIR)) return send(req, res, 403, { error: "forbidden" }, true);
    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) return send(req, res, 404, { error: "not found" }, true);
      const ext = path.extname(filePath).slice(1).toLowerCase();
      res.writeHead(200, {
        "Content-Type": EXT_TO_MIME[ext] || "application/octet-stream",
        "Content-Length": stat.size,
        "Cache-Control": "public, max-age=31536000, immutable",
        "Access-Control-Allow-Origin": "*",
      });
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(filePath).pipe(res);
    });
    return;
  }

  // GET /health
  if (req.method === "GET" && req.url === "/health") return send(req, res, 200, { ok: true }, true);

  // POST /upload — multipart/form-data with a single `file` field.
  if (req.method === "POST" && req.url === "/upload") {
    if (activeUploads >= MAX_CONCURRENT_UPLOADS) {
      return send(req, res, 429, { error: "too many concurrent uploads" });
    }
    const contentType = req.headers["content-type"] || "";
    if (!contentType.startsWith("multipart/form-data")) return send(req, res, 400, { error: "multipart/form-data required" });

    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
    const boundary = boundaryMatch ? (boundaryMatch[1] || boundaryMatch[2]) : "";
    if (!boundary) return send(req, res, 400, { error: "missing boundary" });

    activeUploads++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        activeUploads = Math.max(0, activeUploads - 1);
      }
    };
    res.on("close", release);

    const chunks = [];
    let totalBytes = 0;
    let aborted = false;

    req.on("data", (chunk) => {
      if (aborted) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_BYTES) {
        aborted = true;
        send(req, res, 413, { error: "file too large" });
        req.resume();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (aborted) return release();
      const buffer = Buffer.concat(chunks);
      const file = extractFile(buffer, boundary);
      if (!file) { release(); return send(req, res, 400, { error: "no file field found" }); }

      const mime = file.contentType.split(";")[0].trim().toLowerCase();
      if (!ALLOWED_TYPES.has(mime)) {
        release();
        return send(req, res, 415, { error: "unsupported media type" });
      }
      if (!matchesMagicBytes(file.data, mime)) {
        release();
        return send(req, res, 400, { error: "file content does not match declared media type" });
      }

      const ext = MIME_TO_EXT[mime];
      const hash = crypto.createHash("sha256").update(file.data).digest("hex").slice(0, 32);
      const filename = hash + "." + ext;
      const savePath = path.join(PUBLIC_DIR, filename);

      fs.access(savePath, fs.constants.F_OK, (existsErr) => {
        if (!existsErr) {
          release();
          return send(req, res, 200, { url: "/public/" + filename, filename, bytes: file.data.length, contentType: mime, dedup: true });
        }
        fs.writeFile(savePath, file.data, (err) => {
          release();
          if (err) return send(req, res, 500, { error: "save failed" });
          send(req, res, 200, { url: "/public/" + filename, filename, bytes: file.data.length, contentType: mime });
        });
      });
    });

    req.on("error", () => {
      release();
      if (!aborted && !res.headersSent) send(req, res, 500, { error: "request error" });
    });
    return;
  }

  send(req, res, 404, { error: "not found" });
});

function extractFile(buffer, boundary) {
  const delim = Buffer.from("--" + boundary);
  let pos = 0;
  while (pos < buffer.length) {
    const start = buffer.indexOf(delim, pos);
    if (start === -1) break;
    const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"), start);
    if (headerEnd === -1) break;
    const headerStr = buffer.slice(start, headerEnd).toString("utf-8");
    const nextDelim = buffer.indexOf(delim, headerEnd + 4);
    if (nextDelim === -1) break;

    if (headerStr.includes('name="file"')) {
      const contentTypeMatch = headerStr.match(/Content-Type:\s*(.+)/i);
      const contentType = (contentTypeMatch ? contentTypeMatch[1] : "").trim();
      const dataStart = headerEnd + 4;
      const dataEnd = nextDelim - 2; // strip trailing \r\n before boundary
      return { data: buffer.slice(dataStart, dataEnd), contentType };
    }
    pos = nextDelim + delim.length;
  }
  return null;
}

server.listen(PORT, () => console.log(`imgbed listening on :${PORT}, serving from ${PUBLIC_DIR}`));
