/** Per-tool and total daily caps for write tools, counted in memory per UTC day. */

export interface CapConfig {
  perTool: number;
  total: number;
}

export class DailyCaps {
  private day = '';
  private counts = new Map<string, number>();
  private all = 0;

  constructor(private readonly cfg: CapConfig, private readonly now: () => Date = () => new Date()) {}

  private roll() {
    const d = this.now().toISOString().slice(0, 10);
    if (d !== this.day) {
      this.day = d;
      this.counts.clear();
      this.all = 0;
    }
  }

  /** Reserves one use of `tool`; returns why not when a cap is reached. */
  take(tool: string): { ok: true } | { ok: false; reason: string } {
    this.roll();
    const n = this.counts.get(tool) ?? 0;
    if (n >= this.cfg.perTool) return { ok: false, reason: `${tool} reached its daily cap of ${this.cfg.perTool}` };
    if (this.all >= this.cfg.total) return { ok: false, reason: `write tools reached the daily cap of ${this.cfg.total}` };
    this.counts.set(tool, n + 1);
    this.all++;
    return { ok: true };
  }

  usage() {
    this.roll();
    return { day: this.day, total: this.all, perTool: Object.fromEntries(this.counts), caps: this.cfg };
  }
}
