/** Per-tool and total daily caps for write tools, counted in memory per UTC day. */

export interface CapConfig {
  perTool: number;
  total: number;
  /** Tighter daily caps for single tools; the lower of this and `perTool` applies. */
  tools?: Record<string, number>;
}

/** Grants of power to an agent are rarer than other writes, so they get tighter caps by default. */
export const DEFAULT_TOOL_CAPS: Record<string, number> = { grant_agent_key: 5, delegate_to_agent: 5 };

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

  /** The daily cap of one tool. */
  capOf(tool: string): number {
    return Math.min(this.cfg.perTool, this.cfg.tools?.[tool] ?? Infinity);
  }

  /** Reserves one use of `tool`; returns why not when a cap is reached. */
  take(tool: string): { ok: true } | { ok: false; reason: string } {
    this.roll();
    const n = this.counts.get(tool) ?? 0;
    const cap = this.capOf(tool);
    if (n >= cap) return { ok: false, reason: `${tool} reached its daily cap of ${cap}` };
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
