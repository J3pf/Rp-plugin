// Attachments: GET /v1/blobs/{id} → ImageContent (≤10 MB images) or a file in the inbox referenced by path.
import fs from "node:fs";
import path from "node:path";
import { httpRequest, toHttpUrl } from "../shared/http.ts";
import { sanitizeFileName, sha256, timestampName } from "../shared/util.ts";

export interface AttachmentRef {
  blobId: string;
  name: string;
  mime: string;
  size: number;
  sha256?: string;
}

export const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
export const MAX_INLINE_IMAGE = 10 * 1024 * 1024;
export const MAX_BLOB = 25 * 1024 * 1024;

export interface ResolvedAttachments {
  images: Array<{ type: "image"; data: string; mimeType: string }>;
  /** Lines to append to the message text. */
  lines: string[];
  failures: string[];
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function sessionDirName(sessionId: string): string {
  return sanitizeFileName(sessionId).replace(/\./g, "_") || "session";
}

export interface FetchBlob {
  (blobId: string): Promise<{ status: number; body: Buffer; headers: Record<string, any> }>;
}

export function relayBlobFetcher(relayUrl: string, token: string): FetchBlob {
  return async (blobId) => {
    const r = await httpRequest(toHttpUrl(relayUrl, `/v1/blobs/${encodeURIComponent(blobId)}`), {
      headers: { authorization: `Bearer ${token}` },
      timeoutMs: 60_000,
      maxBytes: MAX_BLOB + 1024,
    });
    return { status: r.status, body: r.body, headers: r.headers };
  };
}

/**
 * Download and place attachments. `inlineImages` is true only for the `api` delivery:
 * interactive/herdr carry text only, so images are saved to the inbox and cited by path.
 */
export async function resolveAttachments(
  refs: AttachmentRef[],
  opts: { fetchBlob: FetchBlob; inboxDir: string; sessionId: string; inlineImages: boolean; now?: Date; writtenFiles?: Map<string, string> },
): Promise<ResolvedAttachments> {
  const out: ResolvedAttachments = { images: [], lines: [], failures: [] };
  if (refs.length === 0) return out;
  const dir = path.join(opts.inboxDir, sessionDirName(opts.sessionId));
  let dirCreated = false;
  const fetched = await Promise.all(
    refs.map((ref) =>
      opts.fetchBlob(ref.blobId).then(
        (res) => ({ ok: true as const, res }),
        (err) => ({ ok: false as const, err }),
      ),
    ),
  );
  for (let idx = 0; idx < refs.length; idx++) {
    const ref = refs[idx]!;
    const cacheKey = `${idx}:${ref.blobId}:${ref.name}`;
    try {
      const item = fetched[idx]!;
      if (!item.ok) throw item.err;
      const res = item.res;
      if (res.status !== 200) throw new Error(`http ${res.status}`);
      const buf = res.body;
      if (buf.length > MAX_BLOB) throw new Error("too large");
      if (typeof ref.size === "number" && ref.size > 0 && buf.length !== ref.size) throw new Error(`size mismatch (${buf.length} ≠ ${ref.size})`);
      const expected = ref.sha256 ?? (res.headers["x-rp-sha256"] as string | undefined) ?? (res.headers["x-content-sha256"] as string | undefined);
      if (expected && sha256(buf).toLowerCase() !== expected.toLowerCase()) throw new Error("sha256 mismatch");
      if (opts.inlineImages && IMAGE_MIMES.has(ref.mime) && buf.length <= MAX_INLINE_IMAGE) {
        out.images.push({ type: "image", data: buf.toString("base64"), mimeType: ref.mime });
        continue;
      }
      let target = opts.writtenFiles?.get(cacheKey);
      if (!target) {
        if (!dirCreated) {
          await fs.promises.mkdir(dir, { recursive: true });
          dirCreated = true;
        }
        const file = path.join(dir, `${timestampName(opts.now)}-${sanitizeFileName(ref.name)}`);
        target = file;
        for (let i = 1; ; i++) {
          try {
            await fs.promises.writeFile(target, buf, { mode: 0o600, flag: "wx" });
            break;
          } catch (err: any) {
            if (err?.code === "EEXIST") {
              target = file.replace(/(\.[^./\\]+)?$/, `-${i}$1`);
              continue;
            }
            throw err;
          }
        }
        opts.writtenFiles?.set(cacheKey, target);
      }
      out.lines.push(`[Archivo adjunto desde el móvil: ${target} (${ref.mime}, ${formatSize(buf.length)})]`);
    } catch (e) {
      out.failures.push(`${ref.name}: ${e instanceof Error ? e.message : String(e)}`);
      out.lines.push(`[Adjunto no disponible: ${ref.name}]`);
    }
  }
  return out;
}

