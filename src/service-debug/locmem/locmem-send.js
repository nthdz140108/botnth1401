const senders = new WeakMap();

export function createPacedSender(send, { now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  let tail = Promise.resolve();
  let nextSendAt = 0;
  return (args, onWait = () => {}, invoke = send) => {
    const result = tail.then(async () => {
      const wait = Math.max(0, nextSendAt - now());
      onWait(wait);
      if (wait) await sleep(wait);
      try { return await invoke(...args); }
      finally { nextSendAt = now() + 1000; }
    });
    tail = result.catch(() => {});
    return result;
  };
}

export function sendLocmemMessage(api, args, onWait, invoke) {
  let sender = senders.get(api);
  if (!sender) {
    sender = createPacedSender((...values) => api.sendMessage(...values));
    senders.set(api, sender);
  }
  return sender(args, onWait, invoke);
}
