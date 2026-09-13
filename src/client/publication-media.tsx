import React, { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { LibraryItem, LibraryMediaChunk } from "../domain/contentLibrary.ts";
import type { PublicationAsset, PublicationDraft } from "../domain/publicationDraft.ts";
import type { WorkbenchController } from "./controller.ts";
import { CONTENT_MEDIA_CHUNK, CONTENT_MEDIA_LIMIT, decodeContentMediaChunk } from "./content-library-controller.ts";

export async function readPublicationAsset(controller: Pick<WorkbenchController, "requestContent">, asset: PublicationAsset, draft: Pick<PublicationDraft, "contentRef" | "revisionDigest">, signal: AbortSignal): Promise<Blob> {
  if (!Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || asset.bytes > CONTENT_MEDIA_LIMIT) throw new Error("MEDIA_TOO_LARGE");
  const allowed = asset.kind === "image" ? ["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"] : ["video/mp4", "video/webm", "video/quicktime", "video/ogg"];
  if (!allowed.includes(asset.mediaType)) throw new Error("MEDIA_INVALID");
  const revisionDigest = asset.source === "draft" ? draft.revisionDigest : asset.revisionDigest;
  const item: LibraryItem = { itemId: asset.itemId, revisionDigest, mediaType: asset.mediaType, title: asset.title, kind: asset.kind, bytes: asset.bytes, publicationType: null, publicationStatus: "unknown", origin: "local", rootLabel: "素材", readOnly: true, legacyReadOnly: false, contentRef: null, status: "local", updatedAt: null };
  const parts: Uint8Array<ArrayBuffer>[] = [];
  for (let offset = 0; offset < asset.bytes;) {
    if (signal.aborted) throw new Error("REQUEST_CANCELLED");
    const range = { itemId: asset.itemId, revisionDigest, offset, length: CONTENT_MEDIA_CHUNK };
    const chunk = await controller.requestContent<LibraryMediaChunk>(asset.source === "draft" ? { operation: "publication_media", contentRef: draft.contentRef, ...range } : { operation: "library_media", ...range }, signal);
    if (signal.aborted) throw new Error("REQUEST_CANCELLED");
    const part = decodeContentMediaChunk(chunk, item, offset, asset.bytes); parts.push(part); offset += part.length;
  }
  return new Blob(parts, { type: asset.mediaType });
}

export function PublicationMedia({ controller, asset, draft, active = true }: { controller: WorkbenchController; asset: PublicationAsset; draft: Pick<PublicationDraft, "contentRef" | "revisionDigest">; active?: boolean }): ReactNode {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setUrl(null); setError(false);
    if (!active) return;
    const owner = new AbortController(); let ownedUrl: string | null = null;
    void readPublicationAsset(controller, asset, draft, owner.signal).then(blob => {
      if (owner.signal.aborted) return;
      ownedUrl = URL.createObjectURL(blob); setUrl(ownedUrl);
    }).catch(() => { if (!owner.signal.aborted) setError(true); });
    return () => { owner.abort(); if (ownedUrl) URL.revokeObjectURL(ownedUrl); };
  }, [controller, asset.itemId, asset.source, asset.revisionDigest, asset.mediaType, asset.bytes, draft.contentRef, draft.revisionDigest, active, attempt]);
  if (error) return <div className="wm-publication-media-notice" role="alert"><p>素材暂时无法预览，请核对文件后重试。</p><button type="button" onClick={() => setAttempt(value => value + 1)}>重试素材预览</button></div>;
  if (!url) return <div className="wm-publication-media-notice" role="status">正在读取素材…</div>;
  return asset.kind === "video" ? <video key={url} className="wm-publication-media" controls preload="metadata" playsInline src={url} onError={() => setError(true)} /> : <img className="wm-publication-media" src={url} alt={asset.caption || asset.title} onError={() => setError(true)} />;
}
