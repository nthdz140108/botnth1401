export function buildYoutubeSendVideoPayload({
  videoUrl,
  threadId,
  threadType,
  thumbnail,
  duration,
  message,
  ttl,
  sendOptions = {},
}) {
  return {
    videoUrl,
    threadId,
    threadType,
    thumbnail,
    duration,
    ...(sendOptions.videoAlreadyUploaded ? { videoAlreadyUploaded: true } : {}),
    message,
    ttl,
  };
}
