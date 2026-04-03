import { initYunzhijia, stopYunzhijia } from './index.js';
import { initMessageProcessor } from './messageProcessor.js';

async function test() {
  console.log('=== Starting Yunzhijia with AI Processing ===\n');

  // 初始化云之家
  const success = await initYunzhijia();
  if (!success) {
    console.log('Failed to initialize Yunzhijia');
    return;
  }

  // 初始化消息处理器
  initMessageProcessor();

  console.log('\n=== Waiting for messages ===');
  console.log('Send a message to your Yunzhijia robot now!\n');

  // 运行 2 分钟
  setTimeout(async () => {
    console.log('\n=== Stopping ===');
    await stopYunzhijia();
    process.exit(0);
  }, 120000);
}

test().catch(console.error);
