// 计算作业队列：queued → running → completed/failed，全程落盘。
// 重启恢复：recover() 把 running（崩溃时中断）重置为 queued，随后由调度继续执行。
import { computeStress } from './engine.mjs';

export class JobRunner {
  constructor(store, { autoProcess = false, intervalMs = 25 } = {}) {
    this.store = store;
    this.intervalMs = intervalMs;
    this.timer = null;
    if (autoProcess) this.start();
  }

  // 应用恢复运行：未完成的计算重新排队，等待执行。
  recover() {
    let resumed = 0;
    for (const run of Object.values(this.store.data.runs)) {
      if (run.status === 'running' || run.status === 'queued') {
        if (run.status === 'running') {
          run.status = 'queued';
          run.startedAt = null;
          resumed += 1;
        }
      }
    }
    if (resumed > 0) this.store.save();
    return resumed;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.processNext();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  nextQueued() {
    return (
      Object.values(this.store.data.runs)
        .filter((r) => r.status === 'queued')
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0] ?? null
    );
  }

  processNext() {
    const run = this.nextQueued();
    if (!run) return false;
    run.status = 'running';
    run.startedAt = new Date().toISOString();
    this.store.save();
    try {
      const result = computeStress(run.inputSnapshot, run.options);
      result.meta.runId = run.id;
      result.meta.inputHash = run.inputHash;
      result.meta.versionNo = run.versionNo;
      run.result = result;
      run.status = 'completed';
    } catch (err) {
      run.status = 'failed';
      run.error = String(err?.message ?? err);
    }
    run.finishedAt = new Date().toISOString();
    this.store.save();
    return true;
  }

  drain() {
    let n = 0;
    while (this.processNext()) n += 1;
    return n;
  }
}
