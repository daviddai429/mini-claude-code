import { getYunzhijiaManager } from './manager.js';

async function test() {
  const manager = getYunzhijiaManager();
  const config = manager.loadConfig();

  if (!config) {
    console.log('No config');
    return;
  }

  await manager.initialize();
  await manager.start();

  console.log('Waiting for messages... (will run for 60 seconds)');
  console.log('Account status:');
  console.log('  personal:', manager.getAccountStatus('personal'));
  console.log('  group:', manager.getAccountStatus('group'));

  // 每3秒检查一次消息
  let checkCount = 0;
  const interval = setInterval(() => {
    checkCount++;
    console.log(`[${checkCount * 3}s] Checking messages...`);
    const messages = manager.getPendingMessages();
    if (messages.length > 0) {
      console.log('\n=== New messages ===');
      for (const msg of messages) {
        console.log(`From: ${msg.senderName} (${msg.accountId})`);
        console.log(`Content: ${msg.content}`);
        console.log('---');
      }
    } else {
      console.log('  No new messages');
    }

    // 定期检查连接状态
    console.log('  Status - personal:', manager.getAccountStatus('personal'));
    console.log('  Status - group:', manager.getAccountStatus('group'));
  }, 3000);

  // 运行 60 秒
  setTimeout(async () => {
    clearInterval(interval);
    await manager.stop();
    console.log('\nDone');
    process.exit(0);
  }, 60000);
}

test().catch(console.error);
