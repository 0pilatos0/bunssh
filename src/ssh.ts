import { Client, type ClientChannel } from "ssh2";

export interface SSHConfig {
  host: string;
  port: number;
  username: string;
  password: string;
}

export class SSHSession {
  private client: Client;
  private stream: ClientChannel | null = null;

  onData: ((data: Buffer) => void) | null = null;
  onClose: (() => void) | null = null;
  onError: ((err: Error) => void) | null = null;

  constructor() {
    this.client = new Client();
  }

  connect(config: SSHConfig, cols: number, rows: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client.on("ready", () => {
        this.client.shell(
          { term: "xterm-256color", cols, rows },
          (err, stream) => {
            if (err) {
              reject(err);
              return;
            }
            this.stream = stream;

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
