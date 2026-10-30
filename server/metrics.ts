import { availableParallelism, freemem, totalmem, platform } from 'node:os';
type Phase = 'idle' | 'source' | 'analysis' | 'patch' | 'discovery' | 'recheck' | 'evaluation';
export class RuntimeMetrics {
  private phase: Phase = 'idle';
  private phases: Partial<Record<Phase, { samples: number; peakRssBytes: number; minFreeMemoryBytes: number }>> = {};
  private samples: { at: string; phase: Phase; rssBytes: number; freeMemoryBytes: number }[] = [];
  private timer?: ReturnType<typeof setInterval>;
  constructor() { this.capture(); }
  start() { if (this.timer) return; this.timer = setInterval(() => this.capture(), 1000); this.timer.unref(); }
  mark(phase: Phase) { this.capture(); this.phase = phase; this.capture(); }
  private capture() {
    const rssBytes = process.memoryUsage().rss, freeMemoryBytes = freemem();
    const summary = this.phases[this.phase] ||= { samples: 0, peakRssBytes: 0, minFreeMemoryBytes: freeMemoryBytes };
    summary.samples++; summary.peakRssBytes = Math.max(summary.peakRssBytes, rssBytes); summary.minFreeMemoryBytes = Math.min(summary.minFreeMemoryBytes, freeMemoryBytes);
    this.samples.push({ at: new Date().toISOString(), phase: this.phase, rssBytes, freeMemoryBytes });
    if (this.samples.length > 120) this.samples.shift();
  }
  snapshot() {
    this.capture();
    return { platform: platform(), cpuCount: availableParallelism(), totalMemoryBytes: totalmem(), freeMemoryBytes: freemem(), rssBytes: process.memoryUsage().rss, processPeakRssBytes: process.resourceUsage().maxRSS * 1024, uptimeSeconds: process.uptime(), sampleIntervalMs: 1000, currentPhase: this.phase, phases: structuredClone(this.phases), recentSamples: [...this.samples], capacityValidated: false };
  }
  close() { clearInterval(this.timer); this.timer = undefined; }
}
