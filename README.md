# bunssh

A web-based SSH terminal built with [Bun](https://bun.sh), [xterm.js](https://xtermjs.org), and [ssh2](https://github.com/mscdex/ssh2). Designed for both interactive use and automated testing of TTY applications with [Playwright](https://playwright.dev).

```
Browser (xterm.js) <── WebSocket ──> Bun Server <── SSH ──> Remote Host
```

## Features

- Full terminal emulation via xterm.js (256-color, cursor positioning, F-keys)
- Login form or auto-connect via environment variables
- Playwright-friendly: exposes `window.term` API and `data-row` DOM attributes
- Reconnect on disconnect
- Lightweight — single Bun process, no native dependencies

## Quick Start

```bash
bun install
bun run build
bun run start
```

Open [http://localhost:8091](http://localhost:8091) and enter your SSH credentials.

### Auto-Connect Mode

Set environment variables to skip the login form and connect automatically:

```bash
SSH_HOST=myserver.com SSH_PORT=22 SSH_USERNAME=user SSH_PASSWORD=secret bun run start
```

Or use a `.env` file (see `.env.example`).

### Connect via URL

Pass credentials in the URL to connect instantly, without any server config. Handy for popout links that log in automatically:

```
http://localhost:8091/?host=myserver.com&port=22&username=user&password=secret&env=TERM=xterm,LANG=C
```

| Param | Required | Description |
|-------|----------|-------------|
| `host` | yes | SSH host |
| `port` | no (default `22`) | SSH port |
| `username` | yes | SSH username |
| `password` | yes | SSH password |
| `env` | no | Session env vars as `KEY=VALUE,FOO=bar` |

When `host`, `username`, and `password` are all present the login form is skipped and the connection starts immediately. Credentials are read entirely in the browser and stripped from the address bar after connecting.

Prefer the **hash fragment** over the query string to keep credentials out of server access logs and `Referer` headers, it's read the same way:

```
http://localhost:8091/#host=myserver.com&username=user&password=secret
```

### Development

```bash
bun run dev  # builds frontend + starts server with --watch
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8091` | Web server port |
| `SSH_HOST` | — | SSH host (enables auto-connect) |
| `SSH_PORT` | `22` | SSH port |
| `SSH_USERNAME` | — | SSH username |
| `SSH_PASSWORD` | — | SSH password |

## Playwright Integration

bunssh is built to be driven by Playwright for testing TTY/TUI applications over SSH.

### Input

Use the terminal's hidden textarea for keyboard input:

```typescript
const terminal = page.getByRole("textbox", { name: "Terminal input" });

await terminal.fill("username");      // Type text
await terminal.press("Enter");        // Press Enter
await terminal.press("F3");           // F-keys work
await terminal.press("ArrowDown");    // Arrow keys
```

### Reading Content

```typescript
// Full terminal buffer as text
const content = await page.evaluate(() => window.term.getContent());

// Specific row via DOM locator
const row = await page.locator("[data-row='0']").textContent();

// Cursor position
const cursorRow = page.locator("[data-cursor-row]");
const col = await cursorRow.getAttribute("data-cursor-col");
```

### Waiting for Content

```typescript
// Wait until terminal contains matching text (rejects on timeout)
await page.evaluate(() => window.term.waitForContent("Login:", 5000));
```

### `window.term` API

| Method | Description |
|--------|-------------|
| `term.getContent()` | Returns the full terminal buffer as a string |
| `term.sendData(data)` | Sends raw data to the SSH session (supports escape sequences like `\x1bOR` for F3) |
| `term.resize(cols, rows)` | Resizes the terminal and notifies the SSH server |
| `term.waitForContent(pattern, timeout?)` | Returns a Promise that resolves when terminal content matches the pattern. Rejects after timeout (default 5000ms) |

### DOM Attributes

Each terminal row in the DOM is tagged with attributes for easy Playwright targeting:

| Attribute | Description |
|-----------|-------------|
| `data-row="N"` | Row index (0-based) |
| `data-cursor-row` | Present on the row containing the cursor |
| `data-cursor-col="N"` | Column position of the cursor |

### Example Test

```typescript
import { test, expect } from "@playwright/test";

test("login to SSH application", async ({ page }) => {
  await page.goto("http://localhost:8091");

  const term = page.getByRole("textbox", { name: "Terminal input" });
  await term.waitFor({ timeout: 10000 });

  // Wait for login screen
  await page.evaluate(() => window.term.waitForContent("Logon:", 10000));

  // Enter credentials
  await term.fill("myuser");
  await term.press("ArrowDown");
  await term.fill("mypassword");
  await term.press("F3");

  // Assert on result
  await page.evaluate(() => window.term.waitForContent("MENU", 10000));
  await expect(page.locator("[data-row='0']")).toContainText("MENU");
});
```

## Project Structure

```
src/
  server.ts           Bun.serve() — HTTP routes + WebSocket handler
  ssh.ts              SSHSession class wrapping ssh2
  build.ts            Bun.build() bundler for the frontend
  frontend/
    index.html        Login form + terminal container
    main.ts           xterm.js, WebSocket client, window.term API
    style.css         Minimal dark theme
```

## License

MIT
