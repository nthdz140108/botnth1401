export function isAnimatedMediaExt(ext) {
  return [".mp4", ".mov", ".webm", ".gif"].includes(ext);
}

export function buildWebpFfmpegOptions(ext) {
  const baseOptions = [
    "-c:v", "libwebp",
    "-lossless", "0",
    "-compression_level", "6",
    "-q:v", "60",
    "-loop", "0",
    "-preset", "default",
    "-an",
    "-y",
  ];

  if (isAnimatedMediaExt(ext)) {
    return baseOptions.concat(["-vf", "fps=10,scale=512:-2:flags=fast_bilinear"]);
  }

  return baseOptions.concat([
    "-vf", "scale=512:-2:flags=fast_bilinear",
    "-frames:v", "1",
  ]);
}
