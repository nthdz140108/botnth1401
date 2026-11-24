export const MEDIA_KIND_TEXT = "text";
export const MEDIA_KIND_IMAGE = "image";
export const MEDIA_KIND_AUDIO = "audio";
export const MEDIA_KIND_VIDEO = "video";

export const MEDIA_EXT_BY_KIND = Object.freeze({
  [MEDIA_KIND_IMAGE]: "jpg",
  [MEDIA_KIND_AUDIO]: "mp3",
  [MEDIA_KIND_VIDEO]: "mp4",
});

export const MEDIA_MIME_BY_KIND = Object.freeze({
  [MEDIA_KIND_IMAGE]: "image/jpeg",
  [MEDIA_KIND_AUDIO]: "audio/mpeg",
  [MEDIA_KIND_VIDEO]: "video/mp4",
});

export function mediaExtFor(kind) {
  return MEDIA_EXT_BY_KIND[kind] || "bin";
}

export function mediaKindToMime(kind) {
  return MEDIA_MIME_BY_KIND[kind] || "application/octet-stream";
}
