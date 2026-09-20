import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import type { FastifyInstance } from "fastify";

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);
const compressible = /json|text\/|javascript|svg|xml/;
// Below this size compression costs more loop time than it saves on the wire.
const minimumBytes = 1024;

/**
 * Weak ETags with 304 for unchanged GET bodies, and asynchronous Brotli/gzip
 * for compressible bodies. Compression runs on the libuv threadpool, so the
 * event loop only pays for the hash and the header work. Streams and
 * WebSocket upgrades are untouched.
 */
export function installResponseEncoding(app: FastifyInstance) {
  app.addHook("onSend", async (request, reply, payload) => {
    if (typeof payload !== "string" && !Buffer.isBuffer(payload)) return payload;
    if (!compressible.test(String(reply.getHeader("content-type") ?? ""))) return payload;
    const body = typeof payload === "string" ? Buffer.from(payload) : payload;
    if (request.method === "GET" && reply.statusCode === 200 && body.length) {
      const etag = `W/"${createHash("sha1").update(body).digest("base64url")}"`;
      reply.header("etag", etag);
      if (request.headers["if-none-match"] === etag) {
        reply.code(304);
        reply.removeHeader("content-length");
        return "";
      }
    }
    if (body.length < minimumBytes || reply.getHeader("content-encoding")) return payload;
    const accept = String(request.headers["accept-encoding"] ?? "");
    const encoding = /\bbr\b/.test(accept) ? "br" : /\bgzip\b/.test(accept) ? "gzip" : null;
    if (!encoding) return payload;
    const compressed =
      encoding === "br"
        ? await brotli(body, {
            params: {
              [constants.BROTLI_PARAM_QUALITY]: 4,
              [constants.BROTLI_PARAM_SIZE_HINT]: body.length,
            },
          })
        : await gzipAsync(body, { level: 6 });
    reply.header("content-encoding", encoding);
    reply.header("vary", "accept-encoding");
    reply.removeHeader("content-length");
    return compressed;
  });
}
