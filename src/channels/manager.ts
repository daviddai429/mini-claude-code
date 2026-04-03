/**
 * 云之家消息管理器
 * 负责管理云之家连接、消息路由和处理
 */
import { YunzhijiaAdapter, type YunzhijiaChannelConfig, type YunzhijiaAccountConfig } from './adapters/yunzhijia.js';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { parse as jsoncParse } from 'jsonc-parser';

/** 消息队列文件路径 */
function getMessageQueuePath(): string {
  const dir = join(homedir(), '.claude', 'yunzhijia');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return join(dir, 'message-queue.json');
}

/** 消息条目 */
interface QueuedMessage {
  id: string;
  accountId: string;
  senderId: string;
  senderName: string;
  content: string;
  chatType: 'private' | 'group';
  chatId: string;
  timestamp: number;
  processed: boolean;
}

/** 云之家管理器 */
export class YunzhijiaManager {
  private adapter: YunzhijiaAdapter;
  private config?: YunzhijiaChannelConfig;
  private running = false;

  constructor() {
    this.adapter = new YunzhijiaAdapter();
  }

  /** 加载配置 */
  loadConfig(): YunzhijiaChannelConfig | null {
    // 只从 .claude 目录读取
    const configFilePath = join(homedir(), '.claude', 'yunzhijia-config.json');

    if (!existsSync(configFilePath)) {
      console.log('[YunzhijiaManager] Config file not found:', configFilePath);
      return null;
    }

    if (!existsSync(configFilePath)) {
      console.log('[YunzhijiaManager] Config file not found');
      return null;
    }

    console.log('[YunzhijiaManager] Loading config from:', configFilePath);

    try {
      let content = readFileSync(configFilePath, 'utf-8');
      // 移除 BOM
      content = content.replace(/^\uFEFF/, '');

      // 使用更安全的方式移除注释（不处理字符串内的内容）
      // 1. 首先用占位符保护字符串
      const strings: string[] = [];
      content = content.replace(/"(?:[^"\\]|\\.)*"/g, (match) => {
        const idx = strings.length;
        strings.push(match);
        return `__STRING_${idx}__`;
      });

      // 2. 然后移除注释
      content = content
        .replace(/\/\/[^\n]*/g, '')  // 单行注释
        .replace(/\/\*[\s\S]*?\*\//g, '');  // 多行注释

      // 3. 恢复字符串
      content = content.replace(/__STRING_(\d+)__/g, (_, idx) => strings[parseInt(idx)]);

      // 4. 移除多余空白但保留 URL
      content = content.replace(/\s+/g, ' ').trim();

      // 使用 jsonc-parser 解析
      const errors: string[] = [];
      const config = jsoncParse(content, errors) as Record<string, unknown>;

      if (errors.length > 0) {
        console.log('[YunzhijiaManager] Parse errors count:', errors.length);
        // 即使有错误也尝试使用部分结果
      }

      if (config.channels?.yunzhijia) {
        this.config = config.channels.yunzhijia;
        return this.config;
      }

      return null;
    } catch (error) {
      console.error('[YunzhijiaManager] Failed to load config:', error);
      return null;
    }
  }

  /** 初始化适配器 */
  async initialize(): Promise<boolean> {
    const config = this.loadConfig();

    if (!config || !config.enabled) {
      console.log('[YunzhijiaManager] Yunzhijia not enabled');
      return false;
    }

    await this.adapter.initialize(config);

    // 设置消息处理回调
    this.adapter.onMessage(async (message) => {
      await this.handleIncomingMessage(message);
    });

    console.log('[YunzhijiaManager] Initialized');
    return true;
  }

  /** 启动管理器 */
  async start(): Promise<void> {
    if (this.running) return;

    await this.adapter.start();
    this.running = true;
    console.log('[YunzhijiaManager] Started');
  }

  /** 停止管理器 */
  async stop(): Promise<void> {
    if (!this.running) return;

    await this.adapter.stop();
    this.running = false;
    console.log('[YunzhijiaManager] Stopped');
  }

  /** 处理收到的消息 */
  private async handleIncomingMessage(message: {
    accountId: string;
    robotId: string;
    robotName: string;
    senderId: string;
    senderName: string;
    content: string;
    chatType: 'private' | 'group';
    chatId: string;
    msgId: string;
  }): Promise<void> {
    // 将消息写入队列文件
    const queuePath = getMessageQueuePath();
    let queue: QueuedMessage[] = [];

    try {
      if (existsSync(queuePath)) {
        const content = readFileSync(queuePath, 'utf-8');
        queue = JSON.parse(content);
      }
    } catch {
      queue = [];
    }

    // 检查是否已存在（去重）
    if (queue.some((m) => m.id === message.msgId)) {
      console.log(`[YunzhijiaManager] Duplicate message ignored: ${message.msgId}`);
      return;
    }

    const queuedMsg: QueuedMessage = {
      id: message.msgId,
      accountId: message.accountId,
      senderId: message.senderId,
      senderName: message.senderName,
      content: message.content,
      chatType: message.chatType,
      chatId: message.chatId,
      timestamp: Date.now(),
      processed: false,
    };

    queue.push(queuedMsg);

    // 只保留最近100条消息
    if (queue.length > 100) {
      queue = queue.slice(-100);
    }

    writeFileSync(queuePath, JSON.stringify(queue, null, 2));
    console.log(`[YunzhijiaManager] Message queued: ${message.content.substring(0, 30)}...`);
  }

  /** 获取待处理消息 */
  getPendingMessages(): QueuedMessage[] {
    const queuePath = getMessageQueuePath();

    if (!existsSync(queuePath)) {
      return [];
    }

    try {
      const content = readFileSync(queuePath, 'utf-8');
      const queue: QueuedMessage[] = JSON.parse(content);
      return queue.filter((msg) => !msg.processed);
    } catch {
      return [];
    }
  }

  /** 标记消息已处理 */
  markMessageProcessed(msgId: string): void {
    const queuePath = getMessageQueuePath();

    if (!existsSync(queuePath)) {
      return;
    }

    try {
      const content = readFileSync(queuePath, 'utf-8');
      const queue: QueuedMessage[] = JSON.parse(content);

      // 只标记指定消息为已处理，保留所有消息
      for (const msg of queue) {
        if (msg.id === msgId) {
          msg.processed = true;
        }
      }

      // 保留所有消息（包括已处理的），而不是删除
      // 只保留最近200条消息
      if (queue.length > 200) {
        queue.splice(0, queue.length - 200);
      }
      writeFileSync(queuePath, JSON.stringify(queue, null, 2));
    } catch {
      // ignore
    }
  }

  /** 发送响应消息 */
  async sendResponse(accountId: string, content: string): Promise<void> {
    await this.adapter.sendResponseMessage(accountId, content);
  }

  /** 获取账户状态 */
  getAccountStatus(accountId: string): string {
    return this.adapter.getAccountStatus(accountId);
  }

  /** 获取所有账户 */
  getAccountIds(): string[] {
    return this.adapter.getAccountIds();
  }

  /** 检查是否正在运行 */
  isRunning(): boolean {
    return this.running;
  }
}

/** 全局单例 */
let yunzhijiaManager: YunzhijiaManager | null = null;

/** 获取云之家管理器实例 */
export function getYunzhijiaManager(): YunzhijiaManager {
  if (!yunzhijiaManager) {
    yunzhijiaManager = new YunzhijiaManager();
  }
  return yunzhijiaManager;
}

/** 初始化云之家（供外部调用） */
export async function initYunzhijia(): Promise<boolean> {
  const manager = getYunzhijiaManager();
  const success = await manager.initialize();
  if (success) {
    await manager.start();
  }
  return success;
}

/** 停止云之家 */
export async function stopYunzhijia(): Promise<void> {
  if (yunzhijiaManager) {
    await yunzhijiaManager.stop();
  }
}
