import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

interface TermAPI {
  getContent(): string;
  sendData(data: string): void;
  resize(cols: number, rows: number): void;
  waitForContent(pattern: string | RegExp, timeout?: number): Promise<string>;
  getMetrics(): MetricsSnapshot;
}

type ConnectionState = "idle" | "connecting" | "connected" | "closed" | "error";

interface Metrics {
  state: ConnectionState;
  identity: string;
  connectedAt: number | null;
  reconnectCount: number;
  bytesIn: number;
  bytesOut: number;
  writeCount: number;
  lastByteAt: number | null;
  lastError: string | null;
  envRejected: string[];
}

interface MetricsSnapshot extends Metrics {
  msSinceLastByte: number | null;
  sessionDurationMs: number | null;
}

declare global {
  interface Window {
    term: TermAPI;
  }
}

const loginEl = document.getElementById("login")!;
const loginForm = document.getElementById("login-form") as HTMLFormElement;
const loginError = document.getElementById("login-error")!;
const terminalContainer = document.getElementById("terminal-container")!;
const terminalEl = document.getElementById("terminal")!;
const disconnectOverlay = document.getElementById("disconnect-overlay")!;
const reconnectBtn = document.getElementById("reconnect-btn")!;
const envRows = document.getElementById("env-rows")!;
const envAddBtn = document.getElementById("env-add")!;

let terminal: Terminal | null = null;
let ws: WebSocket | null = null;
let lastAuthMsg: object | null = null;
let onDataDisposable: { dispose(): void } | null = null;

// ---- Metrics dashboard (browser-side; also exposed via window.term.getMetrics) ----
const IDLE_THRESHOLD_MS = 300;
const MAX_EVENTS = 50;
const textEncoder = new TextEncoder();

const metrics: Metrics = {
  state: "idle",
  identity: "",
  connectedAt: null,
  reconnectCount: 0,
  bytesIn: 0,
  bytesOut: 0,
  writeCount: 0,
  lastByteAt: null,
  lastError: null,
  envRejected: [],
};

const panelLed = document.getElementById("m-led")!;
const panelState = document.getElementById("m-state")!;
const panelIdentity = document.getElementById("m-identity")!;
const panelUptime = document.getElementById("m-uptime")!;
const panelReconnects = document.getElementById("m-reconnects")!;
const panelBytesIn = document.getElementById("m-bytes-in")!;
const panelBytesOut = document.getElementById("m-bytes-out")!;
const panelWrites = document.getElementById("m-writes")!;
const panelIdle = document.getElementById("m-idle")!;
const panelLastByte = document.getElementById("m-lastbyte")!;
const panelEvents = document.getElementById("m-events")!;
const panelAlert = document.getElementById("m-alert")!;
const sparkEl = document.getElementById("m-spark")!;
const panelRate = document.getElementById("m-rate")!;

// Sparkline: rolling samples of incoming bytes/sec, drawn as block characters.
const SPARK_BLOCKS = "▁▂▃▄▅▆▇█";
const SPARK_SAMPLES = 32;
const rateSamples: number[] = [];
let lastSampleBytesIn = 0;
let lastSampleAt = Date.now();

// Event-log de-duplication: collapse consecutive identical events into "×N".
let lastEvent: { label: string; li: HTMLElement; count: number } | null = null;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const pad = (x: number) => String(x).padStart(2, "0");
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function clockTime(): string {
  const d = new Date();
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatAgo(ms: number): string {
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s ago` : `${formatDuration(ms)} ago`;
}

function pushEvent(label: string, kind = "") {
  if (lastEvent && lastEvent.label === label) {
    lastEvent.count++;
    let badge = lastEvent.li.querySelector(".hud-count");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "hud-count";
      lastEvent.li.append(badge);
    }
    badge.textContent = `×${lastEvent.count}`;
    return;
  }

  const li = document.createElement("li");
  if (kind) li.setAttribute("data-kind", kind);
  const time = document.createElement("span");
  time.className = "m-event-time";
  time.textContent = clockTime();
  const text = document.createElement("span");
  text.textContent = label;
  li.append(time, text);
  panelEvents.append(li);

  while (panelEvents.children.length > MAX_EVENTS) {
    panelEvents.firstElementChild?.remove();
  }
  panelEvents.scrollTop = panelEvents.scrollHeight;
  lastEvent = { label, li, count: 1 };
}

function setState(state: ConnectionState) {
  metrics.state = state;
  pushEvent(state, state);
  renderPanel();
}

function sampleRate() {
  const now = Date.now();
  const elapsed = (now - lastSampleAt) / 1000;
  const rate = elapsed > 0 ? (metrics.bytesIn - lastSampleBytesIn) / elapsed : 0;
  lastSampleAt = now;
  lastSampleBytesIn = metrics.bytesIn;

  rateSamples.push(rate);
  while (rateSamples.length > SPARK_SAMPLES) rateSamples.shift();

  panelRate.textContent = `${formatBytes(Math.round(rate))}/s`;

  const max = Math.max(...rateSamples, 1);
  const top = SPARK_BLOCKS.length - 1;
  sparkEl.textContent = rateSamples
    .map((v) => SPARK_BLOCKS[v <= 0 ? 0 : Math.min(top, Math.round((v / max) * top))])
    .join("");
}

function renderPanel() {
  panelLed.setAttribute("data-state", metrics.state);
  panelState.textContent = metrics.state.toUpperCase();
  panelState.setAttribute("data-state", metrics.state);
  panelIdentity.textContent = metrics.identity || "—";
  panelBytesIn.textContent = formatBytes(metrics.bytesIn);
  panelBytesOut.textContent = formatBytes(metrics.bytesOut);
  panelWrites.textContent = String(metrics.writeCount);

  if (metrics.reconnectCount > 0) {
    panelReconnects.textContent = `↻ ${metrics.reconnectCount} reconnect${metrics.reconnectCount > 1 ? "s" : ""}`;
    panelReconnects.removeAttribute("hidden");
  } else {
    panelReconnects.setAttribute("hidden", "");
  }

  const connected = metrics.state === "connected";
  panelUptime.textContent =
    connected && metrics.connectedAt ? formatDuration(Date.now() - metrics.connectedAt) : "—";

  const since = metrics.lastByteAt === null ? null : Date.now() - metrics.lastByteAt;
  if (!connected || since === null) {
    panelIdle.textContent = "—";
    panelIdle.setAttribute("data-idle", "");
    panelLastByte.textContent = "—";
  } else {
    const idle = since >= IDLE_THRESHOLD_MS;
    panelIdle.textContent = idle ? "idle" : "active";
    panelIdle.setAttribute("data-idle", String(idle));
    panelLastByte.textContent = formatAgo(since);
  }

  if (metrics.lastError) {
    panelAlert.textContent = `⚠ ${metrics.lastError}`;
    panelAlert.style.display = "block";
  } else if (metrics.envRejected.length > 0) {
    panelAlert.textContent = `⚠ server refused env var(s): ${metrics.envRejected.join(", ")}`;
    panelAlert.style.display = "block";
  } else {
    panelAlert.style.display = "none";
  }
}

function tagRows(term: Terminal) {
  const rowsContainer = terminalEl.querySelector(".xterm-rows");
  if (!rowsContainer) return;

  const buffer = term.buffer.active;
  const cursorRow = buffer.cursorY;
  const cursorCol = buffer.cursorX;
  const children = rowsContainer.children;

  for (let i = 0; i < children.length; i++) {
    const row = children[i] as HTMLElement;
    row.setAttribute("data-row", String(i));

    if (i === cursorRow) {
      row.setAttribute("data-cursor-row", "");
      row.setAttribute("data-cursor-col", String(cursorCol));
    } else {
      row.removeAttribute("data-cursor-row");
      row.removeAttribute("data-cursor-col");
    }
  }
}

function createTerminal(cols: number, rows: number): Terminal {
  const term = new Terminal({
    cols,
    rows,
    cursorBlink: true,
    fontFamily: "'Menlo', 'DejaVu Sans Mono', 'Consolas', monospace",
    fontSize: 14,
    theme: {
      background: "#1e1e1e",
      foreground: "#cccccc",
      cursor: "#ffffff",
    },
  });
  term.open(terminalEl);

  // Tag xterm DOM rows with data-row attributes for Playwright locators
  term.onWriteParsed(() => tagRows(term));

  // Prevent browser from intercepting F keys and other terminal-relevant shortcuts
  term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
    // Capture all F1-F12 keys
    if (event.key.startsWith("F") && event.key.length <= 3) {
      return true;
    }
    // Let Ctrl+Shift+I (devtools) through to browser
    if (event.ctrlKey && event.shiftKey && event.key === "I") {
      return false;
    }
    return true;
  });

  return term;
}

function connect(authMsg: object) {
  lastAuthMsg = authMsg;

  const a = authMsg as { auto?: boolean; username?: string; host?: string; port?: number };
  metrics.identity = a.auto ? "auto-connect" : `${a.username}@${a.host}:${a.port ?? 22}`;
  setState("connecting");

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.onopen = () => {
    ws!.send(JSON.stringify(authMsg));
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    switch (msg.type) {
      case "connected":
        loginEl.style.display = "none";
        disconnectOverlay.style.display = "none";
        terminalContainer.style.display = "flex";

        if (!terminal) {
          terminal = createTerminal(80, 24);
        } else {
          terminal.clear();
        }

        onDataDisposable?.dispose();
        onDataDisposable = terminal.onData((data: string) => {
          metrics.bytesOut += textEncoder.encode(data).length;
          ws?.send(JSON.stringify({ type: "data", data }));
        });

        terminal.focus();

        // Counters stay monotonic across reconnects; reconnectCount tracks the churn.
        if (metrics.connectedAt !== null) metrics.reconnectCount++;
        metrics.connectedAt = Date.now();
        metrics.lastError = null;
        setState("connected");
        break;

      case "data": {
        const bytes = Uint8Array.from(atob(msg.data), (c) => c.charCodeAt(0));
        metrics.bytesIn += bytes.length;
        metrics.writeCount++;
        metrics.lastByteAt = Date.now();
        terminal?.write(bytes);
        break;
      }

      case "error":
        metrics.lastError = msg.message;
        setState("error");
        if (terminal) {
          terminal.write(`\r\n\x1b[31mError: ${msg.message}\x1b[0m\r\n`);
        } else {
          loginError.textContent = msg.message;
        }
        break;

      case "env_rejected":
        metrics.envRejected = msg.keys;
        pushEvent(`env refused: ${msg.keys.join(", ")}`, "env");
        renderPanel();
        terminal?.write(
          `\r\n\x1b[33m⚠ server refused env var(s): ${msg.keys.join(", ")} (check AcceptEnv in sshd_config)\x1b[0m\r\n`
        );
        break;

      case "closed":
        setState("closed");
        disconnectOverlay.style.display = "flex";
        break;
    }
  };

  ws.onclose = () => {
    if (terminal) {
      disconnectOverlay.style.display = "flex";
    }
    if (metrics.state === "connected" || metrics.state === "connecting") {
      setState("closed");
    }
  };
}

// Environment variable rows
function addEnvRow(key = "", value = "") {
  const row = document.createElement("div");
  row.className = "env-row";

  const keyInput = document.createElement("input");
  keyInput.type = "text";
  keyInput.placeholder = "NAME";
  keyInput.value = key;
  keyInput.className = "env-key";

  const valueInput = document.createElement("input");
  valueInput.type = "text";
  valueInput.placeholder = "value";
  valueInput.value = value;
  valueInput.className = "env-value";

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "env-remove";
  removeBtn.textContent = "×";
  removeBtn.setAttribute("aria-label", "Remove variable");
  removeBtn.addEventListener("click", () => row.remove());

  row.append(keyInput, valueInput, removeBtn);
  envRows.append(row);
}

function collectEnv(): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  for (const row of Array.from(envRows.querySelectorAll(".env-row"))) {
    const key = (row.querySelector(".env-key") as HTMLInputElement).value.trim();
    if (!key) continue;
    env[key] = (row.querySelector(".env-value") as HTMLInputElement).value;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

envAddBtn.addEventListener("click", () => addEnvRow());
addEnvRow();

// Login form handler
loginForm.addEventListener("submit", (e) => {
  e.preventDefault();
  loginError.textContent = "";

  const host = (document.getElementById("host") as HTMLInputElement).value;
  const port = parseInt((document.getElementById("port") as HTMLInputElement).value, 10);
  const username = (document.getElementById("username") as HTMLInputElement).value;
  const password = (document.getElementById("password") as HTMLInputElement).value;
  const env = collectEnv();

  connect({ type: "auth", host, port, username, password, ...(env ? { env } : {}) });
});

// Reconnect button
reconnectBtn.addEventListener("click", () => {
  ws?.close();
  ws = null;
  if (lastAuthMsg) {
    connect(lastAuthMsg);
  }
});

// Expose window.term API for Playwright
window.term = {
  getContent(): string {
    if (!terminal) return "";
    const buffer = terminal.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (line) {
        lines.push(line.translateToString(true));
      }
    }
    // Trim trailing empty lines
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") {
      lines.pop();
    }
    return lines.join("\n");
  },

  sendData(data: string): void {
    metrics.bytesOut += textEncoder.encode(data).length;
    ws?.send(JSON.stringify({ type: "data", data }));
  },

  resize(cols: number, rows: number): void {
    terminal?.resize(cols, rows);
    ws?.send(JSON.stringify({ type: "resize", cols, rows }));
  },

  waitForContent(pattern: string | RegExp, timeout = 5000): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!terminal) {
        reject(new Error("Terminal not initialized"));
        return;
      }

      const regex = typeof pattern === "string" ? new RegExp(pattern) : pattern;

      // Check immediately
      const currentContent = window.term.getContent();
      if (regex.test(currentContent)) {
        resolve(currentContent);
        return;
      }

      const timer = setTimeout(() => {
        disposable.dispose();
        reject(new Error(`Timed out waiting for content matching: ${pattern}`));
      }, timeout);

      const disposable = terminal.onWriteParsed(() => {
        const content = window.term.getContent();
        if (regex.test(content)) {
          clearTimeout(timer);
          disposable.dispose();
          resolve(content);
        }
      });
    });
  },

  getMetrics(): MetricsSnapshot {
    return {
      ...metrics,
      msSinceLastByte: metrics.lastByteAt === null ? null : Date.now() - metrics.lastByteAt,
      sessionDurationMs: metrics.connectedAt === null ? null : Date.now() - metrics.connectedAt,
    };
  },
};

// Live-refresh the panel's time-derived fields (uptime, idle, sparkline).
setInterval(() => {
  sampleRate();
  renderPanel();
}, 250);
renderPanel();

// Auto-connect check
(async () => {
  try {
    const res = await fetch("/config");
    const config = await res.json();
    if (config.autoConnect) {
      loginEl.style.display = "none";
      terminalContainer.style.display = "flex";
      connect({ type: "auth", auto: true });
    }
  } catch {
    // Config fetch failed, show login form
  }
})();
