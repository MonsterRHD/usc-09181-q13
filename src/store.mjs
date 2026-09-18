// 持久化：单文件 JSON 存储，写临时文件后原子 rename，崩溃不会留下半写文件。
// 每次变更同步落盘，进程重启后由 load() 全量恢复（已发布报告、未完成作业都在其中）。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const emptyData = () => ({
  scenarios: {},
  versions: {},
  runs: {},
  exports: {},
  reminders: {},
  audit: [],
});

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = join(dir, 'store.json');
    this.data = emptyData();
    this.load();
  }

  load() {
    if (existsSync(this.file)) {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      this.data = { ...emptyData(), ...parsed };
    }
  }

  save() {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }

  audit(actor, action, detail = {}) {
    this.data.audit.push({
      id: randomUUID(),
      at: new Date().toISOString(),
      actor: actor.user,
      role: actor.role,
      action,
      ...detail,
    });
  }

  // ---- 查询辅助 ----
  scenario(id) {
    return this.data.scenarios[id] ?? null;
  }

  versionsOf(scenarioId) {
    return Object.values(this.data.versions)
      .filter((v) => v.scenarioId === scenarioId)
      .sort((a, b) => a.versionNo - b.versionNo);
  }

  versionByNo(scenarioId, versionNo) {
    return (
      Object.values(this.data.versions).find(
        (v) => v.scenarioId === scenarioId && v.versionNo === versionNo,
      ) ?? null
    );
  }

  latestVersion(scenarioId) {
    const all = this.versionsOf(scenarioId);
    return all[all.length - 1] ?? null;
  }

  run(id) {
    return this.data.runs[id] ?? null;
  }

  latestCompletedRun(versionId) {
    return (
      Object.values(this.data.runs)
        .filter((r) => r.versionId === versionId && r.status === 'completed')
        .sort((a, b) => (a.finishedAt < b.finishedAt ? 1 : -1))[0] ?? null
    );
  }

  exportsOf(scenarioId) {
    return Object.values(this.data.exports).filter((e) => e.scenarioId === scenarioId);
  }

  remindersOf(scenarioId) {
    return Object.values(this.data.reminders).filter((r) => r.scenarioId === scenarioId);
  }
}
