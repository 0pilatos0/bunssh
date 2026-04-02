import { type ServerWebSocket } from "bun";
import { SSHSession, type SSHConfig } from "./ssh.ts";
import { join } from "path";
import { readFileSync, existsSync } from "fs";

const PORT = parseInt(process.env["PORT"] ?? "8091", 10);
const DIST_DIR = join(import.meta.dir, "..", "dist");

const autoConnectConfig: SSHConfig | null =
  process.env["SSH_HOST"] && process.env["SSH_USERNAME"] && process.env["SSH_PASSWORD"]
    ? {
        host: process.env["SSH_HOST"],
        port: parseInt(process.env["SSH_PORT"] ?? "22", 10),
        username: process.env["SSH_USERNAME"],
        password: process.env["SSH_PASSWORD"],
      }
    : null;

interface WSData {
  ssh: SSHSession | null;
}

type WSMessage =
  | { type: "auth"; host?: string; port?: number; username?: string; password?: string; auto?: boolean }
  | { type: "data"; data: string }
  | { type: "resize"; cols: number; rows: number };

function getMimeType(path: string): string {
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".js")) return "application/javascript";
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".map")) return "application/json";
  return "application/octet-stream";
}

function serveStatic(filePath: string): Response {
  const fullPath = join(DIST_DIR, filePath);
  if (!existsSync(fullPath)) {
    return new Response("Not Found", { status: 404 });
  }
  const content = readFileSync(fullPath);
  return new Response(content, {
    headers: { "Content-Type": getMimeType(fullPath) },
  });
}

const server = Bun.serve<WSData>({
  port: PORT,

  fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req, {
        data: { ssh: null } satisfies WSData,
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    if (url.pathname === "/config") {
      return Response.json({ autoConnect: autoConnectConfig !== null });
    }

    const filePath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    return serveStatic(filePath);
  },

  websocket: {
    open(_ws) {},

    async message(ws: ServerWebSocket<WSData>, message) {
      const msg = JSON.parse(String(message)) as WSMessage;

      switch (msg.type) {
        case "auth": {
          if (ws.data.ssh) {
            ws.send(JSON.stringify({ type: "error", message: "Already connected" }));
            return;
          }

          let config: SSHConfig;
          if (msg.auto && autoConnectConfig) {
            config = autoConnectConfig;
          } else if (msg.host && msg.username && msg.password) {
            config = {
              host: msg.host,
              port: msg.port ?? 22,
              username: msg.username,
              password: msg.password,
            };
          } else {
            ws.send(JSON.stringify({ type: "error", message: "Missing credentials" }));
            return;
          }

          const ssh = new SSHSession();
          ws.data.ssh = ssh;

          ssh.onData = (data: Buffer) => {
            ws.send(JSON.stringify({ type: "data", data: data.toString("base64") }));
          };

          ssh.onClose = () => {
            ws.send(JSON.stringify({ type: "closed" }));
            ws.data.ssh = null;
          };

          ssh.onError = (err: Error) => {
            ws.send(JSON.stringify({ type: "error", message: err.message }));
          };

          try {
            const cols = 80;
            const rows = 24;
            await ssh.connect(config, cols, rows);
            ws.send(JSON.stringify({ type: "connected" }));
          } catch (err) {
            const message = err instanceof Error ? err.message : "Connection failed";
            ws.send(JSON.stringify({ type: "error", message }));
            ws.data.ssh = null;
          }
          break;
        }

        case "data": {
          ws.data.ssh?.write(msg.data);
          break;
        }

        case "resize": {
          ws.data.ssh?.resize(msg.cols, msg.rows);
          break;
        }
      }
    },

    close(ws: ServerWebSocket<WSData>) {
      ws.data.ssh?.disconnect();
      ws.data.ssh = null;
    },
  },
});

console.log(`bunssh listening on http://localhost:${server.port}`);
if (autoConnectConfig) {
  console.log(`Auto-connect enabled: ${autoConnectConfig.username}@${autoConnectConfig.host}:${autoConnectConfig.port}`);
}
