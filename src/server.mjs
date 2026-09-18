// 服务入口：加载持久化状态 → 恢复未完成的计算任务 → 启动 HTTP 服务。
// 数据目录默认 ./data，可用 DATA_DIR 覆盖；端口默认 3000，可用 PORT 覆盖。

import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { recoverStore } from './domain.mjs';
import { createApp } from './app.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const port = Number(process.env.PORT || 3000);

const store = Store.load(dataDir);
const recovery = recoverStore(store);
if (recovery.recoveredJobs.length > 0) {
  console.log(`[恢复] 重跑未完成任务：${recovery.recoveredJobs.join(', ')}`);
}
if (recovery.publishedReports.length > 0) {
  console.log(`[恢复] 已发布报告可用：${recovery.publishedReports.join(', ')}`);
}

const server = createServer(createApp(store));
server.listen(port, () => {
  console.log(`跨境流动性压力沙盘已启动：http://localhost:${port}（数据目录：${dataDir}）`);
});
