import net from "node:net";

export function isPortAvailable(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(Number(port), host, () => server.close(() => resolve(true)));
  });
}
