/** One line per action, prefixed with the time and the service name. */

export type Logger = (msg: string) => void;

export function logger(service: string, write: (line: string) => void = console.log): Logger {
  return (msg) => write(`${new Date().toISOString()} ${service} ${msg}`);
}

/** Recent failures, newest first, for `/health`. */
export class RecentErrors {
  private readonly items: Array<{ at: string; message: string }> = [];

  constructor(private readonly max = 20) {}

  add(message: string): void {
    this.items.unshift({ at: new Date().toISOString(), message });
    if (this.items.length > this.max) this.items.length = this.max;
  }

  list(): Array<{ at: string; message: string }> {
    return [...this.items];
  }
}
