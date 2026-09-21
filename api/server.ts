import app from './app.js';
import { loadStore, flushStore } from './src/services/annotationStore.js';

const PORT = process.env.PORT || 3001;

await loadStore();

const server = app.listen(PORT, () => {
  console.log(`🚀 微生物文明馆 API 服务已启动: http://localhost:${PORT}`);
});

// 防抖落盘的兜底：退出前把最后一批合并写入磁盘
async function shutdown(signal: string) {
  console.log(`\n${signal} 收到，正在落盘...`);
  server.close();
  await flushStore();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
