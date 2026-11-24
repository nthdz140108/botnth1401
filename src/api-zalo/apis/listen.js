import EventEmitter from "events";
import WebSocket from "ws";
import { appContext } from "../context.js";
import { getZaloRuntimeConfig } from "../zalo-config.js";
import { initializeGroupEvent } from "../models/GroupEvent.js";
import { GroupMessage, Message, Reaction, Undo } from "../models/index.js";
import { decodeEventData, getGroupEventType, logger } from "../utils.js";
import { getListenerRuntimeState } from "../../runtime/listener-state.js";

export class Listener extends EventEmitter {
  constructor(url, options = {}) {
    super();
    if (!appContext.cookie) throw new Error("Cookie is not available");
    if (!appContext.userAgent) throw new Error("User agent is not available");
    this.url = url;
    this.wsEndpoints = Array.isArray(options.wsEndpoints) && options.wsEndpoints.length > 0
      ? [...options.wsEndpoints]
      : (url ? [url] : []);
    this._endpointIndex = 0;
    this.handshakeTimeoutMs = Number.isFinite(options.handshakeTimeoutMs) ? options.handshakeTimeoutMs : 15_000;
    this.openSettleMs = Number.isFinite(options.openSettleMs) ? options.openSettleMs : 800;
    this.wsPingIntervalMs = Number.isFinite(options.wsPingIntervalMs) ? options.wsPingIntervalMs : 0;
    this.wsPongTimeoutMs = Number.isFinite(options.wsPongTimeoutMs) ? options.wsPongTimeoutMs : 15_000;
    this.zaloKeepAliveIntervalMs = Number.isFinite(options.zaloKeepAliveIntervalMs) ? options.zaloKeepAliveIntervalMs : 90_000;
    this._wsFactory = typeof options.wsFactory === "function" ? options.wsFactory : null;
    this.zaloConfig = getZaloRuntimeConfig();
    this.cookie = appContext.cookie;
    this.userAgent = appContext.userAgent;
    this.selfListen = appContext.options.selfListen;
    this.onConnectedCallback = () => { };
    this.onClosedCallback = () => { };
    this.onErrorCallback = () => { };
    this.onMessageCallback = () => { };
    this.pingInterval = null;
    this.wsHeartbeatInterval = null;
    this.wsPongTimer = null;
    this._lastCloseReason = null;
    this._kickedByDuplicate = false;
    this.ws = null;
  }
  onConnected(cb) {
    this.onConnectedCallback = cb;
  }
  onClosed(cb) {
    this.onClosedCallback = cb;
  }
  onError(cb) {
    this.onErrorCallback = cb;
  }
  onMessage(cb) {
    this.onMessageCallback = cb;
  }
  updateEndpoints(url, wsEndpoints = null) {
    this.url = url;
    this.wsEndpoints = Array.isArray(wsEndpoints) && wsEndpoints.length > 0
      ? [...wsEndpoints]
      : (url ? [url] : []);
    this._endpointIndex = 0;
  }
  _resolveNextUrl(rotateEndpoint = false) {
    if ((!Array.isArray(this.wsEndpoints) || this.wsEndpoints.length === 0) && this.url) {
      this.wsEndpoints = [this.url];
    }
    if (rotateEndpoint && this.wsEndpoints.length > 1) {
      this._endpointIndex = (this._endpointIndex + 1) % this.wsEndpoints.length;
    }
    const candidate = this.wsEndpoints[this._endpointIndex] || this.url;
    if (!candidate) return "";
    try {
      const parsed = new URL(candidate);
      if (parsed.searchParams.has("t") || parsed.searchParams.has("zpw_ver")) {
        parsed.searchParams.set("t", String(Date.now()));
      }
      this.url = parsed.toString();
      return this.url;
    } catch {
      return candidate;
    }
  }
  _clearZaloKeepAlive() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
  _clearWsHeartbeat() {
    if (this.wsHeartbeatInterval) {
      clearInterval(this.wsHeartbeatInterval);
      this.wsHeartbeatInterval = null;
    }
    if (this.wsPongTimer) {
      clearTimeout(this.wsPongTimer);
      this.wsPongTimer = null;
    }
  }
  _clearPingInterval() {
    this._clearZaloKeepAlive();
    this._clearWsHeartbeat();
  }
  _startWsHeartbeat(ws) {
    this._clearWsHeartbeat();
    if (!ws || this.wsPingIntervalMs <= 0) return;
    if (typeof ws.on === "function") {
      ws.on("pong", () => {
        if (this.wsPongTimer) {
          clearTimeout(this.wsPongTimer);
          this.wsPongTimer = null;
        }
      });
    }
    this.wsHeartbeatInterval = setInterval(() => {
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) {
        this._clearWsHeartbeat();
        return;
      }
      if (typeof ws.ping !== "function") return;
      if (this.wsPongTimer) clearTimeout(this.wsPongTimer);
      this.wsPongTimer = setTimeout(() => {
        this.wsPongTimer = null;
        if (this.ws !== ws) return;
        this._lastCloseReason = "WebSocket ping timeout (dead connection)";
        try {
          if (typeof ws.terminate === "function") ws.terminate();
          else ws.close();
        } catch {}
      }, this.wsPongTimeoutMs);
      this.wsPongTimer.unref?.();
      try {
        ws.ping();
      } catch {}
    }, this.wsPingIntervalMs);
    this.wsHeartbeatInterval.unref?.();
  }
  stop() {
    this._clearPingInterval();
    const oldWs = this.ws;
    this.ws = null;
    if (oldWs) {
      oldWs.onopen = null;
      oldWs.onerror = null;
      oldWs.onclose = null;
      oldWs.onmessage = null;
      try { oldWs.removeAllListeners?.("pong"); } catch {}
      try {
        if (oldWs.readyState !== WebSocket.CLOSED && oldWs.readyState !== WebSocket.CLOSING) {
          oldWs.close();
        }
      } catch {}
    }
  }
  start({ rotateEndpoint = false } = {}) {
    if (appContext.cookie) this.cookie = appContext.cookie;
    if (appContext.userAgent) this.userAgent = appContext.userAgent;
    const connectUrl = this._resolveNextUrl(rotateEndpoint);
    if (!connectUrl) {
      throw new Error("WebSocket URL không hợp lệ (thiếu zpw_ws). Kiểm tra lại cookie đăng nhập.");
    }
    this._clearPingInterval();
    if (this.ws) {
      const prevWs = this.ws;
      this.ws = null;
      prevWs.onopen = null;
      prevWs.onerror = null;
      prevWs.onclose = null;
      prevWs.onmessage = null;
      try { prevWs.removeAllListeners?.("pong"); } catch {}
      try {
        if (prevWs.readyState !== WebSocket.CLOSED && prevWs.readyState !== WebSocket.CLOSING) {
          prevWs.close();
        }
      } catch {}
    }
    this.cipherKey = null;
    this._lastCloseReason = null;
    this._kickedByDuplicate = false;
    // Tag this socket with a fresh connection generation so that a late
    // `closed`/`error` event from a REPLACED socket (a previous generation)
    // can be recognized and dropped instead of clobbering the healthy state
    // of the current socket. Best-effort: if listener state is unavailable the
    // generation stays undefined and events are accepted unconditionally.
    let socketGeneration = undefined;
    try {
      socketGeneration = getListenerRuntimeState().beginConnection();
    } catch {}
    const wsOptions = {
      handshakeTimeout: this.handshakeTimeoutMs,
      headers: {
        "accept-encoding": "gzip, deflate, br, zstd",
        "accept-language": "en-US,en;q=0.9",
        "cache-control": "no-cache",
        connection: "Upgrade",
        host: new URL(connectUrl).host,
        origin: this.zaloConfig.origin,
        prgama: "no-cache",
        "sec-websocket-extensions": "permessage-deflate; client_max_window_bits",
        "sec-websocket-version": "13",
        upgrade: "websocket",
        "user-agent": this.userAgent,
        cookie: this.cookie,
      },
    };
    const ws = this._wsFactory
      ? this._wsFactory(connectUrl, wsOptions)
      : new WebSocket(connectUrl, wsOptions);
    this.ws = ws;
    this._socketGeneration = socketGeneration;
    const generation = socketGeneration;
    ws.onopen = () => {
      if (this.ws === ws) {
        this._startWsHeartbeat(ws);
      }
      this.onConnectedCallback(generation);
      this.emit("connected", generation);
    };
    ws.onerror = (error) => {
      const msg = error?.message || String(error || "WebSocket error");
      if (!this._lastCloseReason) this._lastCloseReason = msg;
      console.error("[ERROR] Lỗi kết nối WebSocket:", msg);
      this.onErrorCallback(error, generation);
      this.emit("error", error, generation);
    };
    ws.onclose = (closeEvent) => {
      if (this.ws === ws) {
        this._clearPingInterval();
      }
      const closeCode = closeEvent?.code ?? null;
      const closeReasonText = typeof closeEvent?.reason === "string" && closeEvent.reason.trim()
        ? closeEvent.reason.trim()
        : "";
      const fallbackReason = closeCode
        ? `WebSocket closed (code=${closeCode}${closeReasonText ? `: ${closeReasonText}` : ""})`
        : "WebSocket closed";
      const closeInfo = {
        reason: this._lastCloseReason || fallbackReason,
        code: closeCode,
        kickedByDuplicate: this._kickedByDuplicate,
      };
      this.onClosedCallback(generation, closeInfo);
      this.emit("closed", generation, closeInfo);
    };
    ws.onmessage = async (event) => {
      await this.handleFrame(event?.data);
    };
  }

  /**
   * Start the WebSocket listener and await actual connection readiness
   * (either Zalo key exchange `(1,1)` or sustained OPEN past `openSettleMs`),
   * rejecting on handshake error, immediate close (`cmd=3000` / invalid ticket),
   * or handshake timeout.
   */
  startAsync({ timeoutMs = this.handshakeTimeoutMs, rotateEndpoint = false } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let settleTimer = null;
      let deadlineTimer = null;
      let targetGen = undefined;

      const cleanup = () => {
        if (settleTimer) {
          clearTimeout(settleTimer);
          settleTimer = null;
        }
        if (deadlineTimer) {
          clearTimeout(deadlineTimer);
          deadlineTimer = null;
        }
        this.removeListener("cipher_key", onCipherKey);
        this.removeListener("connected", onConnected);
        this.removeListener("error", onError);
        this.removeListener("closed", onClosed);
      };

      const finishResolve = (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      const finishReject = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      const onCipherKey = (gen) => {
        if (targetGen !== undefined && gen !== undefined && gen !== targetGen) return;
        finishResolve({ generation: targetGen, keyExchanged: true });
      };

      const onConnected = (gen) => {
        if (targetGen !== undefined && gen !== undefined && gen !== targetGen) return;
        if (this.cipherKey || this.openSettleMs <= 0) {
          finishResolve({ generation: targetGen, keyExchanged: Boolean(this.cipherKey) });
          return;
        }
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
          settleTimer = null;
          if (this.ws && this.ws.readyState === WebSocket.OPEN && !this._kickedByDuplicate) {
            finishResolve({ generation: targetGen, keyExchanged: Boolean(this.cipherKey) });
          } else {
            const err = new Error(this._lastCloseReason || "WebSocket closed immediately after open");
            if (this._kickedByDuplicate) err.code = "DUPLICATE_CONNECTION";
            finishReject(err);
          }
        }, this.openSettleMs);
      };

      const onError = (error, gen) => {
        if (targetGen !== undefined && gen !== undefined && gen !== targetGen) return;
        const err = error instanceof Error
          ? error
          : new Error(error?.message || String(error || "WebSocket handshake error"));
        finishReject(err);
      };

      const onClosed = (gen, closeInfo) => {
        if (targetGen !== undefined && gen !== undefined && gen !== targetGen) return;
        const err = new Error(closeInfo?.reason || this._lastCloseReason || "WebSocket closed during handshake");
        if (closeInfo?.kickedByDuplicate || this._kickedByDuplicate) {
          err.code = "DUPLICATE_CONNECTION";
        }
        finishReject(err);
      };

      this.on("cipher_key", onCipherKey);
      this.on("connected", onConnected);
      this.on("error", onError);
      this.on("closed", onClosed);

      deadlineTimer = setTimeout(() => {
        deadlineTimer = null;
        const timeoutErr = new Error(`WebSocket handshake timed out after ${timeoutMs}ms`);
        timeoutErr.code = "WS_HANDSHAKE_TIMEOUT";
        try { this.stop(); } catch {}
        finishReject(timeoutErr);
      }, Math.max(50, timeoutMs));

      try {
        this.start({ rotateEndpoint });
        targetGen = this._socketGeneration;
        if (!settled && this.ws && this.ws.readyState === WebSocket.OPEN) {
          onConnected(targetGen);
        }
      } catch (syncErr) {
        finishReject(syncErr);
      }
    });
  }

  async handleFrame(data) {
    if (!(data instanceof Buffer)) return;
    try {
      const encodedHeader = data.subarray(0, 4);
      const [version, cmd, subCmd] = getHeader(encodedHeader);
      const dataToDecode = data.subarray(4);
      const decodedData = new TextDecoder("utf-8").decode(dataToDecode);
      if (decodedData.length == 0) return;
      let parsed;
      try {
        parsed = JSON.parse(decodedData);
      } catch (parseError) {
        logger.error(`WS_DECODE: không parse được frame (${parseError.message}); bỏ qua frame này.`);
        return;
      }
      await this.dispatchParsedFrame(version, cmd, subCmd, parsed);
    } catch (error) {
      // A malformed frame must never escalate to a process-level error:
      // log, drop this frame and keep the socket alive for the next one.
      logger.error(`WS_DECODE: lỗi xử lý frame: ${error.message}; bỏ qua frame.`);
    }
  }

  async dispatchParsedFrame(version, cmd, subCmd, parsed) {
    if (version == 1) {
          // Key exchange (1,1)
          if (cmd == 1 && subCmd == 1 && parsed.hasOwnProperty("key")) {
            this.handleKeyExchange(parsed);
          }
          // Personal messages (501,0)
          else if (cmd == 501 && subCmd == 0) {
            await this.handlePersonalMessages(parsed);
          }
          // Group messages (521,0)
          else if (cmd == 521 && subCmd == 0) {
            await this.handleGroupMessages(parsed);
          }
          // Controls/Events (601,0)
          else if (cmd == 601 && subCmd == 0) {
            await this.handleControlEvents(parsed);
          }
          // Reactions (612, 0)
          else if (cmd == 612 && subCmd == 0) {
            await this.handleReactions(parsed);
          }
          // Connection closed (3000,0)
          else if (cmd == 3000 && subCmd == 0) {
            logger.error("Another connection is opened, closing this one");
            this._kickedByDuplicate = true;
            this._lastCloseReason = "Another Zalo connection is opened (code 3000)";
            this.emit("duplicate_connection", this._socketGeneration);
            if (this.ws && this.ws.readyState !== WebSocket.CLOSED) this.ws.close();
          }
        }
  }

  handleKeyExchange(parsed) {
    this.cipherKey = parsed.key;
    this._clearZaloKeepAlive();
    this.setupPingInterval();
    this.emit("cipher_key", this._socketGeneration);
  }

  setupPingInterval() {
    const ping = () => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this._clearZaloKeepAlive();
        return;
      }
      const payload = {
        version: 1,
        cmd: 2,
        subCmd: 1,
        data: { eventId: Date.now() },
      };
      const encodedData = new TextEncoder().encode(JSON.stringify(payload.data));
      const dataLength = encodedData.length;
      const data = new DataView(Buffer.alloc(4 + dataLength).buffer);
      data.setUint8(0, payload.version);
      data.setInt32(1, payload.cmd, true);
      data.setInt8(3, payload.subCmd);
      encodedData.forEach((e, i) => {
        data.setUint8(4 + i, e);
      });
      try {
        this.ws.send(data);
      } catch {}
    };
    this.pingInterval = setInterval(ping, this.zaloKeepAliveIntervalMs);
    this.pingInterval.unref?.();
  }

  async handlePersonalMessages(parsed) {
    const receivedAt = Date.now();
    const parsedData = (await decodeEventData(parsed, this.cipherKey)).data;
    const { msgs } = parsedData;
    for (const msg of msgs) {
      if (typeof msg.content == "object" && msg.content.hasOwnProperty("deleteMsg")) {
        const undoObject = new Undo(msg, false);
        undoObject.wsReceivedAt = receivedAt;
        if (undoObject.isSelf && !this.selfListen) continue;
        this.emit("undo", undoObject);
      } else {
        const messageObject = new Message(msg);
        messageObject.wsReceivedAt = receivedAt;
        if (messageObject.isSelf && !this.selfListen) continue;
        this.onMessageCallback(messageObject);
        this.emit("message", messageObject);
      }
    }
  }

  async handleGroupMessages(parsed) {
    const receivedAt = Date.now();
    const parsedData = (await decodeEventData(parsed, this.cipherKey)).data;
    const { groupMsgs } = parsedData;
    for (const msg of groupMsgs) {
      if (typeof msg.content == "object" && msg.content.hasOwnProperty("deleteMsg")) {
        const undoObject = new Undo(msg, true);
        undoObject.wsReceivedAt = receivedAt;
        if (undoObject.isSelf && !this.selfListen) continue;
        this.emit("undo", undoObject);
      } else {
        const messageObject = new GroupMessage(msg);
        messageObject.wsReceivedAt = receivedAt;
        if (messageObject.isSelf && !this.selfListen) continue;
        this.onMessageCallback(messageObject);
        this.emit("message", messageObject);
      }
    }
  }

  async handleControlEvents(parsed) {
    const receivedAt = Date.now();
    const parsedData = (await decodeEventData(parsed, this.cipherKey)).data;
    const { controls } = parsedData;
    for (const control of controls) {
      if (control.content.act_type == "file_done") {
        const data = {
          fileUrl: control.content.data.url,
          fileId: control.content.fileId,
        };
        const uploadCallback = appContext.uploadCallbacks.get(String(control.content.fileId));
        if (uploadCallback) uploadCallback(data);
        appContext.uploadCallbacks.delete(String(control.content.fileId));
        this.emit("upload_attachment", data);
      } else if (control.content.act_type == "voice_aac_success") {
        const data = {
          fileUrl: control.content.data["5"] || control.content.data["6"],
          fileId: control.content.fileId,
        };
        const uploadCallback = appContext.uploadCallbacks.get(String(control.content.fileId));
        if (uploadCallback) uploadCallback(data);
        appContext.uploadCallbacks.delete(String(control.content.fileId));
        this.emit("upload_attachment", data);
      } else if (control.content.act_type == "group") {
        if (control.content.act == "join_reject") continue;
        const groupEventData = typeof control.content.data == "string" ? JSON.parse(control.content.data) : control.content.data;
        const groupEvent = initializeGroupEvent(groupEventData, getGroupEventType(control.content.act));
        groupEvent.wsReceivedAt = receivedAt;
        if (groupEvent.isSelf && !this.selfListen) continue;
        this.emit("group_event", groupEvent);
      }
    }
  }

  async handleReactions(parsed) {
    const receivedAt = Date.now();
    const parsedData = (await decodeEventData(parsed, this.cipherKey)).data;
    const { reacts, reactGroups } = parsedData;
    for (const react of reacts) {
      react.content = JSON.parse(react.content);
      const reactionObject = new Reaction(react, false);
      reactionObject.wsReceivedAt = receivedAt;
      if (reactionObject.isSelf && !this.selfListen) continue;
      this.emit("reaction", reactionObject);
    }
    for (const reactGroup of reactGroups) {
      reactGroup.content = JSON.parse(reactGroup.content);
      const reactionObject = new Reaction(reactGroup, true);
      reactionObject.wsReceivedAt = receivedAt;
      if (reactionObject.isSelf && !this.selfListen) continue;
      this.emit("reaction", reactionObject);
    }
  }

  async handleTyping(parsed) {
    const data = JSON.parse(parsed.data);
    if (data.error_code !== 0) return;

    const actions = data.data.actions;
    for (const action of actions) {
      if (action.act_type === "typing") {
        // Parse dữ liệu typing theo cách thủ công
        const rawData = action.data.replace(/\\/g, '');
        const matches = {
          gid: rawData.match(/"gid":"(\d+)"/)?.[1],
          uid: rawData.match(/"uid":"(\d+)"/)?.[1],
          ts: rawData.match(/"ts":\s*"(\d+)"/)?.[1],
          isPC: rawData.match(/"isPC":(\d+)/)?.[1]
        };

        if (!matches.uid || !matches.ts) continue;

        const typingEvent = {
          userId: matches.uid,
          timestamp: Number(matches.ts),
          isPC: Boolean(Number(matches.isPC)),
          type: action.act // 'typing' cho tin nhắn cá nhân, 'gtyping' cho nhóm
        };

        // Thêm groupId nếu là typing trong nhóm và có gid
        if (action.act === "gtyping" && matches.gid) {
          typingEvent.groupId = matches.gid;
        }

        this.emit("typing", typingEvent);
      }
    }
  }
}
function getHeader(buffer) {
  if (buffer.byteLength < 4) {
    throw new Error("Invalid header");
  }
  return [buffer[0], buffer.readUInt16LE(1), buffer[3]];
}
