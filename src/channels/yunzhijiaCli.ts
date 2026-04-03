/**
 * 云之家桥接服务启动器
 * 支持两种模式：
 * - 云之家模式: WebSocket 收发消息
 * - CLI 模式: 直接终端输入/输出
 */
import { getYunzhijiaManager, initYunzhijia, stopYunzhijia } from '../channels/index.js';
import { initMessageProcessor, getMessageProcessor } from './messageProcessor.js';
import * as readline from 'readline';

/** CLI 模式：直接在终端对话 */
async function startCliMode(): Promise<void> {
  console.log('=== CLI 模式 ===');
  console.log('直接输入消息与 Claude Code 对话，输入 exit 退出\n');

  const processor = getMessageProcessor();
  if (!processor) {
    console.error('[错误] 请先初始化 MessageProcessor');
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (): void => {
    rl.question('> ', async (input) => {
      const message = input.trim();

      if (message === 'exit' || message === 'quit') {
        console.log('再见！');
        rl.close();
        return;
      }

      if (!message) {
        ask();
        return;
      }

      console.log('\n[正在处理...]');

      try {
        // 直接调用 Claude Code 处理
        const reply = await processor.processWithClaudeCode({
          accountId: 'cli',
          senderName: 'User',
          content: message,
          msgId: `cli-${Date.now()}`,
        });

        console.log(`\n${reply}\n`);
      } catch (error) {
        console.error('[错误]', error instanceof Error ? error.message : error);
      }

      ask();
    });
  };

  ask();
}

/** 云之家模式 */
export async function startYunzhijiaBridge(): Promise<void> {
  console.log('[Yunzhijia Bridge] Starting...');

  const success = await initYunzhijia();
  if (!success) {
    console.log('[Yunzhijia Bridge] Not enabled or configuration not found');
    return;
  }

  // 初始化消息处理器（调用 AI）
  console.log('[Yunzhijia Bridge] Initializing AI message processor...');
  initMessageProcessor();

  console.log('[Yunzhijia Bridge] Running. Press Ctrl+C to stop.');

  // 保持进程运行
  process.on('SIGINT', async () => {
    console.log('\n[Yunzhijia Bridge] Stopping...');
    await stopYunzhijia();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n[Yunzhijia Bridge] Stopping...');
    await stopYunzhijia();
    process.exit(0);
  });
}

/** 根据参数选择模式 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--cli') || args.includes('-c')) {
    // CLI 模式
    initMessageProcessor();
    await startCliMode();
  } else {
    // 云之家模式（默认）
    await startYunzhijiaBridge();
  }
}

main().catch(console.error);
