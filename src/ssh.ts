import { Client, type ClientChannel } from "ssh2";

export interface SSHConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  env?: Record<string, string>;
}

export class SSHSession {
  private client: Client;
  private stream: ClientChannel | null = null;

  onData: ((data: Buffer) => void) | null = null;
  onClose: (() => void) | null = null;
  onError: ((err: Error) => void) | null = null;
  onEnvRejected: ((keys: string[]) => void) | null = null;

  constructor() {
    this.client = new Client();
  }

  connect(config: SSHConfig, cols: number, rows: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client.on("ready", () => {
        this.client.shell(
          { term: "xterm-256color", cols, rows },
          { env: config.env },
          (err, stream) => {
            if (err) {
              reject(err);
              return;
            }
            this.stream = stream;

            if (config.env && Object.keys(config.env).length > 0) {
              this.probeEnv(stream, config.env);
            }

            stream.on("data", (data: Buffer) => {
              this.onData?.(data);
            });

            stream.stderr.on("data", (data: Buffer) => {
              this.onData?.(data);
            });

            stream.on("close", () => {
              this.onClose?.();
              this.client.end();
            });

            resolve();
          }
        );
      });

      this.client.on("error", (err) => {
        this.onError?.(err);
        reject(err);
      });

      this.client.connect({
        host: config.host,
        port: config.port,
        username: config.username,
        password: config.password,
      });
    });
  }

  // The shell() `env` option sets variables before the shell starts, but ssh2
  // sends those requests without asking for a reply, so a server that rejects
  // them (no matching AcceptEnv) does so silently. Re-send each var with
  // wantReply purely to learn which ones the server refused, then surface them.
  // Reaches into ssh2 internals (no public client-side API for this); guarded
  // so it degrades to silent if those internals ever change.
  private probeEnv(stream: ClientChannel, env: Record<string, string>): void {
    const anyStream = stream as any;
    const proto = anyStream._client?._protocol;
    const callbacks = anyStream._callbacks;
    const chanId = anyStream.outgoing?.id;

    if (
      !proto ||
      typeof proto.env !== "function" ||
      !Array.isArray(callbacks) ||
      chanId === undefined
    ) {
      return;
    }

    const keys = Object.keys(env);
    const rejected: string[] = [];
    let pending = keys.length;

    for (const key of keys) {
      callbacks.push((hadErr: unknown) => {
        if (hadErr) rejected.push(key);
        if (--pending === 0 && rejected.length > 0) {
          this.onEnvRejected?.(rejected);
        }
      });
      proto.env(chanId, key, env[key], true);
    }
  }

  write(data: string): void {
    this.stream?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.stream?.setWindow(rows, cols, 0, 0);
  }

  disconnect(): void {
    this.stream?.close();
    this.client.end();
  }
}
