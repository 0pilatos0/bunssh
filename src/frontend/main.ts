import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

interface TermAPI {
  getContent(): string;
  sendData(data: string): void;
  resize(cols: number, rows: number): void;
  waitForContent(pattern: string | RegExp, timeout?: number): Promise<string>;
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

let terminal: Terminal | null = null;
let ws: WebSocket | null = null;
let lastAuthMsg: object | null = null;
let onDataDisposable: { dispose(): void } | null = null;

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
          ws?.send(JSON.stringify({ type: "data", data }));
        });

        terminal.focus();
        break;

      case "data": {
        const bytes = Uint8Array.from(atob(msg.data), (c) => c.charCodeAt(0));
        terminal?.write(bytes);
        break;
      }

      case "error":
        if (terminal) {
          terminal.write(`\r\n\x1b[31mError: ${msg.message}\x1b[0m\r\n`);
        } else {
          loginError.textContent = msg.message;
        }
        break;

      case "closed":
        disconnectOverlay.style.display = "flex";
        break;
    }
  };

  ws.onclose = () => {
    if (terminal) {
      disconnectOverlay.style.display = "flex";
    }
  };
}

// Login form handler
loginForm.addEventListener("submit", (e) => {
  e.preventDefault();
  loginError.textContent = "";

  const host = (document.getElementById("host") as HTMLInputElement).value;
  const port = parseInt((document.getElementById("port") as HTMLInputElement).value, 10);
  const username = (document.getElementById("username") as HTMLInputElement).value;
  const password = (document.getElementById("password") as HTMLInputElement).value;

  connect({ type: "auth", host, port, username, password });
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
};

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
