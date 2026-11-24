import FormData from "form-data";
import fs from "fs";
import path from "path";
import { appContext } from "../context.js";
import { API_TYPE, API_VERSION } from "../constants.js";
import { ZaloApiError } from "../Errors/ZaloApiError.js";
import { MessageType } from "../models/Message.js";
import { encodeAES, getFileSize, getImageMetaData, getMd5LargeFileObject, handleZaloResponse, makeURL, request } from "../utils.js";
import { uploadTempFile } from "../../utils/util.js";
const urlType = {
  image: "photo_original/upload",
  aac: "voice/upload",
  video: "asyncfile/upload",
  gif: "gif?",
  others: "asyncfile/upload",
};

const DEFAULT_UPLOAD_CONCURRENCY = 2;
const MAX_UPLOAD_CONCURRENCY = 8;
const DEFAULT_CHUNK_SIZE = 3 * 1024 * 1024; // 3 MiB fallback
/** One retry layer total: at most 3 HTTP attempts per chunk. */
const MAX_CHUNK_HTTP_ATTEMPTS = 3;
/** Deadline for the ws upload-callback so the promise can never hang forever. */
const UPLOAD_CALLBACK_DEADLINE_MS = Number(process.env.ZALO_UPLOAD_CALLBACK_DEADLINE_MS) || 60_000;

/**
 * Retry classification (upload retry policy):
 * - RETRYABLE: timeout/network transport failures, HTTP 408/429/5xx.
 * - NOT retryable: other 4xx, auth/cookie errors, bad params, and Zalo
 *   application error codes — retrying cannot fix those.
 */
export function isRetryableUploadError(error) {
  if (!error) return false;
  if (error instanceof ZaloApiError && error.retryable === true) return true;
  const code = error?.code;
  if (typeof code === "number") {
    return code === 408 || code === 429 || (code >= 500 && code < 600);
  }
  const message = String(error?.message || "");
  return /timeout|abort|network|econn|socket|fetch failed|http_request_failed/i.test(message);
}

/** True for auth/cookie/param problems and Zalo app error codes: never retry. */
export function isNonRetryableAuthOrAppError(error) {
  if (!error) return false;
  const code = error?.code;
  if (typeof code === "number") {
    // Zalo app error codes are not HTTP statuses (e.g. 114, 215): never retry.
    if (code >= 100 && code < 400) return true;
    return code !== 408 && code !== 429 && (code < 500 || code >= 600);
  }
  if (typeof code === "string") {
    return /auth|cookie|permission|invalid|decrypt|encrypt|parameter|param/i.test(code);
  }
  return false;
}

/** Strip the query string from an endpoint so logs never leak params. */
export function redactEndpoint(url) {
  try {
    const parsed = new URL(String(url));
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(url || "").split("?")[0];
  }
}

/** Chunk size from server settings (features.sharefile.chunk_size_file) with a 3 MiB fallback. */
export function resolveChunkSize() {
  const configured = Number(appContext.settings?.features?.sharefile?.chunk_size_file);
  if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
  return DEFAULT_CHUNK_SIZE;
}

export function getUploadConcurrency(totalChunks, configured = process.env.ZALO_UPLOAD_CONCURRENCY) {
  const parsed = Number.parseInt(configured, 10);
  const requested = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_UPLOAD_CONCURRENCY;
  return Math.max(1, Math.min(requested, MAX_UPLOAD_CONCURRENCY, totalChunks));
}

export function createChunkParams(params, chunkId) {
  return { ...params, chunkId };
}

// Original: Thanh Hung
// Custom: BUG ( DEO XOA CAI NAY, XOA T CHAT CU M )
export function uploadAttachmentFactory(api) {
  if (!api?.zpwServiceMap?.file?.[0]) throw new ZaloApiError("Missing file endpoint (zpwServiceMap.file[0])");
  const uploadHooks = appContext.options?.uploadAttachmentHooks || {};
  const checkConfigUploadAttachment = uploadHooks.checkConfigUploadAttachment || (() => {});
  const getProphylacticUploadAttachment = uploadHooks.getProphylacticUploadAttachment || (() => false);
  const setProphylacticUploadAttachment = uploadHooks.setProphylacticUploadAttachment || (() => {});
  const serviceURL = `${api.zpwServiceMap.file[0]}/api`;
  return async function uploadAttachment(filePaths, threadId, type = MessageType.DirectMessage, isUseProphylactic = false) {
    if (!appContext.secretKey || !appContext.imei || !appContext.cookie || !appContext.userAgent)
      throw new ZaloApiError("Missing required app context fields");
    if (!filePaths?.length) throw new ZaloApiError("Missing filePaths");
    if (!threadId) throw new ZaloApiError("Missing threadId");
    const results = [];
    for (const filePath of filePaths) {
      if (!fs.existsSync(filePath)) throw new ZaloApiError(`${filePath} not found`);
      const extFile = path.extname(filePath).slice(1).toLowerCase();
      const maxSize = 9 * 1000 * 1000; 
      const fileSize = await getFileSize(filePath);
      let fileType = "";
      let maxType = "";
      if (["jpg", "jpeg", "png"].includes(extFile)) {
        fileType = "image";
      } else if (["mp3", "aac"].includes(extFile)) {
        if (fileSize > maxSize) {
          fileType = "others";
          maxType = "ThanhHung.aac";
        } else {
          fileType = "aac";
        }
      } else if (extFile === "mp4") {
        fileType = "video";
      } else {
        fileType = "others";
      }
      if (getProphylacticUploadAttachment() || isUseProphylactic) {
        try {
          if (["jpg", "jpeg", "png", "webp"].includes(extFile)) {
            const imageData = await getImageMetaData(filePath);
            const url = await uploadTempFile(filePath);
            results.push({
              fileType: "image",
              width: imageData.width,
              height: imageData.height,
              totalSize: imageData.totalSize,
              photoId: Math.floor(Date.now() / 1000),
              normalUrl: url,
              hdUrl: url,
              thumbUrl: url,
            });
            continue;
          }
        } catch (error) {
          console.error("Upload Attachment API Thứ 3 Đã Xảy Ra Lỗi, Vui Lòng Kiểm Tra Lại!");
          console.error("Chuyển sang dùng api chính từ zalo (Không khả thi khi upload nhiều file trong thời gian ngắn)!");
        }
      }
      const chunkSize = resolveChunkSize();
      const isGroupMessage = type === MessageType.GroupMessage;
      const baseUrl = `${serviceURL}/${isGroupMessage ? "group" : "message"}/`;
      const query = {
        zpw_ver: API_VERSION,
        zpw_type: API_TYPE,
        type: isGroupMessage ? "11" : "2",
      };
      const fileName = path.basename(filePath);
      const totalSize = fileSize;
      const totalChunks = Math.ceil(totalSize / chunkSize);
      const clientId = Date.now();
      const processUpload = async () => {
        const data = {
          filePath,
          chunkContent: [],
          params: {
            imei: appContext.imei,
            isE2EE: 0,
            jxl: 0,
            chunkId: 1,
            clientId,
            fileName,
            totalChunk: totalChunks,
            totalSize,
            fileType,
            ...(isGroupMessage ? { grid: threadId } : { toid: threadId }),
          },
        };
        if (["jpg", "jpeg", "png"].includes(extFile)) {
          const imageData = await getImageMetaData(filePath);
          data.fileType = "image";
          data.fileData = imageData;
        } else {
          data.fileType = fileType;
          data.fileData = { fileName, totalSize };
        }
        const fileHandle = await fs.promises.open(filePath, "r");
        try {
          for (let i = 0; i < totalChunks; i++) {
            const chunkStart = i * chunkSize;
            const currentChunkSize = Math.min(chunkSize, totalSize - chunkStart);
            const chunkBuf = Buffer.alloc(currentChunkSize);
            await fileHandle.read(chunkBuf, 0, currentChunkSize, chunkStart);
            const formData = new FormData();
            formData.append("chunkContent", chunkBuf, {
              filename: fileName,
              contentType: "application/octet-stream",
            });
            data.chunkContent[i] = formData;
          }
        } finally {
          await fileHandle.close();
        }
        const maxConcurrentUploads = getUploadConcurrency(totalChunks);
        const activeUploads = [];
        let uploadedChunks = 0;
        const chunkEndpoint = `${baseUrl}${urlType[data.fileType]}`;
        const uploadChunk = async (chunkContent, chunkId) => {
          const encryptedParams = encodeAES(
            appContext.secretKey,
            JSON.stringify(createChunkParams(data.params, chunkId)),
          );
          if (!encryptedParams) throw new ZaloApiError("Failed to encrypt message");
          // SINGLE retry layer: at most MAX_CHUNK_HTTP_ATTEMPTS HTTP attempts
          // with jittered backoff, only for classified-retryable failures.
          // The underlying request() runs with its internal retry DISABLED so
          // attempts never nest (previously one chunk could be POSTed ~24x).
          let lastError = null;
          for (let attempt = 1; attempt <= MAX_CHUNK_HTTP_ATTEMPTS; attempt++) {
            try {
              const response = await request(
                makeURL(chunkEndpoint, { ...query, params: encryptedParams }),
                {
                  method: "POST",
                  headers: chunkContent.getHeaders(),
                  body: chunkContent.getBuffer(),
                  timeout: 30000,
                  retry: 0,
                },
              );

              const result = await handleZaloResponse(response);
              if (result.error) {
                setProphylacticUploadAttachment(true);
                const zaloError = new ZaloApiError(result.error.message, result.error.code, result.error.status);
                // Zalo application error codes are never retried.
                if (!isRetryableUploadError(zaloError)) {
                  zaloError.chunk = chunkId;
                  zaloError.file = fileName;
                  zaloError.attempt = attempt;
                  zaloError.endpoint = redactEndpoint(chunkEndpoint);
                  throw zaloError;
                }
                lastError = zaloError;
              } else {
                checkConfigUploadAttachment(extFile);

                const resData = result.data;
                if (resData) {
                  if (resData.fileId && resData.fileId !== "-1") {
                    return await new Promise((resolve, reject) => {
                      let settled = false;
                      // Deadline for the ws upload-callback: a missing/lost
                      // callback must reject with a clear error instead of
                      // hanging the promise (and the pool scan) forever.
                      const deadline = setTimeout(() => {
                        if (settled) return;
                        settled = true;
                        appContext.uploadCallbacks.delete(String(resData.fileId));
                        const timeoutError = new ZaloApiError(
                          `Upload callback timeout for fileId=${resData.fileId}`,
                          "UPLOAD_CALLBACK_TIMEOUT",
                        );
                        timeoutError.chunk = chunkId;
                        timeoutError.file = fileName;
                        timeoutError.attempt = attempt;
                        timeoutError.endpoint = redactEndpoint(chunkEndpoint);
                        reject(timeoutError);
                      }, UPLOAD_CALLBACK_DEADLINE_MS);
                      appContext.uploadCallbacks.set(String(resData.fileId), async (wsData) => {
                        try {
                          const resultData = {
                            ...data.fileData,
                            ...resData,
                            ...wsData,
                            fileType: data.fileType,
                            checksum: (await getMd5LargeFileObject(data.filePath, data.fileData.totalSize)).data,
                          };
                          if (maxType) {
                            resultData.fileUrl = `${resultData.fileUrl}/${maxType}`;
                          }
                          if (settled) return;
                          settled = true;
                          clearTimeout(deadline);
                          results.push(resultData);
                          resolve(resultData);
                        } catch (error) {
                          if (settled) return;
                          settled = true;
                          clearTimeout(deadline);
                          reject(error);
                        }
                      });
                    });
                  }
                  if (resData.photoId && resData.finished) {
                    const resultData = {
                      fileType: data.fileType,
                      width: data.fileData.width,
                      height: data.fileData.height,
                      totalSize: data.fileData.totalSize,
                      ...resData,
                    };
                    results.push(resultData);
                    return resultData;
                  }
                }
                return undefined;
              }
            } catch (error) {
              lastError = error;
              // Keep the ORIGINAL error: code, status, retryable, endpoint
              // (query-redacted), chunk, file and attempt — never replace it
              // with a generic message that hides the root cause.
              const enrich = (target) => {
                if (target.chunk === undefined) target.chunk = chunkId;
                if (target.file === undefined) target.file = fileName;
                if (target.attempt === undefined) target.attempt = attempt;
                if (target.endpoint === undefined) target.endpoint = redactEndpoint(chunkEndpoint);
              };
              if (!isRetryableUploadError(error) || attempt >= MAX_CHUNK_HTTP_ATTEMPTS) {
                enrich(error);
                throw error;
              }
              const baseBackoff = 500 * 2 ** (attempt - 1);
              const jitter = Math.round(baseBackoff * 0.2 * (Math.random() * 2 - 1));
              console.log(`Retrying chunk ${chunkId}/${totalChunks} attempt ${attempt}/${MAX_CHUNK_HTTP_ATTEMPTS} in ${baseBackoff + jitter}ms...`);
              await new Promise((resolve) => setTimeout(resolve, baseBackoff + jitter));
            }
          }
          if (lastError) {
            lastError.chunk = chunkId;
            lastError.file = fileName;
            lastError.attempt = MAX_CHUNK_HTTP_ATTEMPTS;
            lastError.endpoint = redactEndpoint(chunkEndpoint);
            throw lastError;
          }
          throw new ZaloApiError(`Failed to upload chunk ${chunkId}/${totalChunks}`);
        };

        const startTime = Date.now();
        for (let i = 0; i < data.chunkContent.length; i++) {
          while (activeUploads.length >= maxConcurrentUploads) {
            await Promise.race(activeUploads);
          }
          const uploadPromise = uploadChunk(data.chunkContent[i], i + 1).then((result) => {
            uploadedChunks++;
            const percent = (uploadedChunks / totalChunks) * 100;
            console.log(`Upload progress: ${uploadedChunks}/${totalChunks} chunks (${percent.toFixed(2)}%)`);
            return result;
          });
          activeUploads.push(uploadPromise);
          uploadPromise.then(
            () => activeUploads.splice(activeUploads.indexOf(uploadPromise), 1),
            () => activeUploads.splice(activeUploads.indexOf(uploadPromise), 1),
          );
        }

        const uploadedResults = await Promise.all(activeUploads);
        const duration = (Date.now() - startTime) / 1000;
        if (duration > 0) {
          console.log(`Upload speed: ${(totalChunks / duration).toFixed(2)} chunk(s)/s (${totalChunks} chunks in ${duration.toFixed(2)}s)`);
        } else {
          console.log("Upload completed instantly.");
        }

        for (const result of uploadedResults) {
          if (result) return result;
        }
        throw new ZaloApiError("Upload failed: No successful chunk returned.");
      };

      // NO whole-upload re-run: a failed upload surfaces its classified,
      // metadata-carrying error directly. Endpoint/auth/timeout failures are
      // common to the whole send and must stop the caller (pool scanning)
      // instead of silently burning attempts on other files.
      await processUpload();
    }

    return results;
  };
}
