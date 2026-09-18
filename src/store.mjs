// 持久化存储：全量状态保存在单个 JSON 文件中，写入采用「临时文件 + 原子改名」，
// 任何一次写盘中途崩溃都不会留下半个文件；启动时若文件损坏会备份后重建，
// 保证应用总能恢复运行。

import fs from 'node:fs';
import path from 'node:path';

const emptyState = () => ({
  counters: {}, // 各类业务 id 的自增序号
  datasets: { balances: [], debts: [], creditLines: [], fx: [] },
  scenarios: [],
  jobs: [], // 计算任务：入队即落盘，崩溃后可恢复续跑
  audit: [], // 操作审计：谁在什么时间做了什么
});

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'store.json');
    this.state = emptyState();
    this.recoveryReport = null; // 启动恢复报告（仅内存，不落盘）
  }

  static load(dir) {
    const store = new Store(dir);
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(store.file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(store.file, 'utf8'));
        store.state = { ...emptyState(), ...parsed };
        store.state.datasets = { ...emptyState().datasets, ...(parsed.datasets || {}) };
      } catch {
        const backup = `${store.file}.corrupt-${Date.now()}`;
        fs.copyFileSync(store.file, backup);
        store.state = emptyState();
        store.corruptBackup = backup;
      }
    }
    return store;
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }

  nextId(prefix) {
    const n = (this.state.counters[prefix] || 0) + 1;
    this.state.counters[prefix] = n;
    return `${prefix}-${String(n).padStart(4, '0')}`;
  }

  audit(entry) {
    this.state.audit.push({ at: new Date().toISOString(), ...entry });
  }
}
