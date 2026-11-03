// Minimal image bed: accepts a file upload, stores it on disk, and serves the
// file publicly. No database, no auth — it sits behind the same host as new-api
// and is reached only through the frontend's proxy, so the upload token is the
// new-api one the caller already carries.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 8081);
const DATA_DIR = process.env.DATA_DIR || "/data";
const PUBLIC_DIR = path.join(DATA_DIR, "public");
const MAX_BYTES = Number(process.env.MAX_BYTES || 50) * 1024 * 1024; // 50 MB default
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "video/mp4", "audio/mpeg", "audio/wav", "audio/mp3"]);

fs.mkdirSync(PUBLIC_DIR, { recursive: true });

const MIME_TO_EXT = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
  "video/mp4": "mp4", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/mp3": "mp3",
};

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
    return res.end();
  }

  // GET /public/<file> — serve the stored file.
  if (req.method === "GET" && req.url.startsWith("/public/")) {
    const filePath = path.join(PUBLIC_DIR, path.basename(req.url));
    if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, { error: "forbidden" });
    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) return send(res, 404, { error: "not found" });
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Cache-Control": "public, max-age=31536000" });
      fs.createReadStream(filePath).pipe(res);
    });
    return;
  }

  // GET /health
  if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true });

  // POST /upload — multipart/form-data with a single `file` field.
  if (req.method === "POST" && req.url === "/upload") {
    const contentType = req.headers["content-type"] || "";
    if (!contentType.startsWith("multipart/form-data")) return send(res, 400, { error: "multipart/form-data required" });

    const boundary = contentType.split("boundary=")[1];
    if (!boundary) return send(res, 400, { error: "missing boundary" });

    let chunks = [];
    let totalBytes = 0;
    let aborted = false;

    req.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BYTES) { aborted = true; req.destroy(); }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (aborted) return send(res, 413, { error: "file too large" });
      const buffer = Buffer.concat(chunks);
      const file = extractFile(buffer, boundary);
      if (!file) return send(res, 400, { error: "no file field found" });

      const ext = MIME_TO_EXT[file.contentType] || "bin";
      const filename = crypto.randomBytes(16).toString("hex") + "." + ext;
      const savePath = path.join(PUBLIC_DIR, filename);

      fs.writeFile(savePath, file.data, (err) => {
        if (err) return send(res, 500, { error: "save failed" });
        send(res, 200, { url: "/public/" + filename, filename, bytes: file.data.length, contentType: file.contentType });
      });
    });

    req.on("error", () => { if (!aborted) send(res, 500, { error: "request error" }); });
    return;
  }

  send(res, 404, { error: "not found" });
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
