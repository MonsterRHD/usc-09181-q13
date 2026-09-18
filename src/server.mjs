// 服务入口：DATA_DIR 指定数据目录（默认 ./data），PORT 指定端口（默认 3000）。
import { createApp } from './app.mjs';

const dataDir = process.env.DATA_DIR ?? new URL('../data', import.meta.url).pathname;
const port = Number(process.env.PORT ?? 3000);

const { server, jobs } = createApp({ dataDir, autoProcess: true });

server.listen(port, () => {
  console.log(`跨境流动性压力沙盘已启动: http://localhost:${port} (数据目录: ${dataDir})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    jobs.stop();
    server.close(() => process.exit(0));
  });
}
