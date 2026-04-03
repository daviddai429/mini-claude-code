/**
 * 云之家渠道适配器（多机器人架构）
 * 连接云之家 WebSocket，接收消息并转发给处理函数
 */
import WebSocket from 'ws';
import * as crypto from 'crypto';

/** 云之家消息类型 */
export interface YunzhijiaMessage {
  msgType: number;
  robotId: string;
  robotName: string;
  openId: string;
  operatorName: string;
  time: number;
  msgId: string;
  content: string;
  groupId?: string;
  groupType?: number;
}

/** 云之家机器人配置 */
export interface YunzhijiaAccountConfig {
  name: string;
  type: 'personal' | 'group';
  enabled: boolean;
  sendMsgUrl: string;
  timeout?: number;
  secret?: string;
  heartbeatInterval?: number;
  reconnectMaxDelay?: number;
}

/** 云之家渠道配置 */
export interface YunzhijiaChannelConfig {
  enabled: boolean;
  defaultAccount?: string;
  accounts: Record<string, YunzhijiaAccountConfig>;
}

/** 消息处理器类型 */
export type MessageHandler = (message: {
  accountId: string;
  robotId: string;
  robotName: string;
  senderId: string;
  senderName: string;
  content: string;
  chatType: 'private' | 'group';
  chatId: string;
  msgId: string;
}) => Promise<void>;

/** 发送响应函数类型 */
export type SendResponseFunc = (accountId: string, content: string) => Promise<void>;

interface AccountState {
  config: YunzhijiaAccountConfig;
  ws?: WebSocket;
  wsUrl?: string;
  reconnectAttempts: number;
  heartbeatTimer?: NodeJS.Timeout;
  reconnectTimer?: NodeJS.Timeout;
  processingMessage?: Promise<void>;
}

/** 消息去重器 */
class MessageDeduplicator {
  private processedMsgIds: Set<string> = new Set();
  private maxSize = 2000;

  isDuplicate(msgId: string): boolean {
    if (this.processedMsgIds.has(msgId)) {
      return true;
    }
    this.processedMsgIds.add(msgId);

    if (this.processedMsgIds.size > this.maxSize) {
      const arr = Array.from(this.processedMsgIds);
      this.processedMsgIds = new Set(arr.slice(-1000));
    }
    return false;
  }
}

/** 云之家适配器 */
export class YunzhijiaAdapter {
  private accounts: Map<string, AccountState> = new Map();
  private defaultAccountId?: string;
  private deduplicator = new MessageDeduplicator();
  private messageHandler?: MessageHandler;
  private sendResponse?: SendResponseFunc;
  private _status: 'inactive' | 'starting' | 'active' | 'error' = 'inactive';

  get status(): string {
    return this._status;
  }

  /** 初始化适配器 */
  async initialize(config: YunzhijiaChannelConfig): Promise<void> {
    this.defaultAccountId = config.defaultAccount;

    if (config.accounts) {
      for (const [accountId, accountConfig] of Object.entries(config.accounts)) {
        if (accountConfig.enabled) {
          this.accounts.set(accountId, {
            config: accountConfig,
            reconnectAttempts: 0,
          });
        }
      }
    }

    this._status = 'inactive';
    console.log(`[YunzhijiaAdapter] Initialized with ${this.accounts.size} accounts`);
  }

  /** 设置消息处理器 */
  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  /** 设置发送响应函数 */
  onSendResponse(handler: SendResponseFunc): void {
    this.sendResponse = handler;
  }

  /** 启动适配器 */
  async start(): Promise<void> {
    this._status = 'starting';

    const startPromises = Array.from(this.accounts.entries()).map(
      ([accountId, state]) => this.connectWebSocket(accountId, state)
    );

    await Promise.allSettled(startPromises);
    this._status = 'active';
    console.log(`[YunzhijiaAdapter] Started with ${this.accounts.size} accounts`);
  }

  /** 停止适配器 */
  async stop(): Promise<void> {
    for (const [accountId, state] of this.accounts) {
      this.stopAccount(accountId, state);
    }
    this._status = 'inactive';
    console.log('[YunzhijiaAdapter] Stopped');
  }

  /** 发送消息到云之家 */
  async sendMessage(accountId: string, text: string): Promise<void> {
    const state = this.accounts.get(accountId);
    if (!state) {
      throw new Error(`Account not found: ${accountId}`);
    }

    const payload = { content: text };
    await this.sendToCloud(state.config, payload);
  }

  /** 发送回复（公共接口） */
  async sendResponseMessage(accountId: string, content: string): Promise<void> {
    await this.sendMessage(accountId, content);
  }

  /** 连接 WebSocket */
  private async connectWebSocket(accountId: string, state: AccountState): Promise<void> {
    const wsUrl = this.deriveWebSocketUrl(state.config.sendMsgUrl);
    state.wsUrl = wsUrl;

    return new Promise((resolve, reject) => {
      try {
        state.ws = new WebSocket(wsUrl);

        state.ws.on('open', () => {
          state.reconnectAttempts = 0;
          this.startHeartbeat(accountId, state);
          console.log(`[YunzhijiaAdapter] Account "${accountId}" connected`);
          resolve();
        });

        state.ws.on('message', (data) => {
          console.log(`[YunzhijiaAdapter] Raw message for ${accountId}:`, data.toString().substring(0, 500));
          this.handleWebSocketMessage(accountId, state, data);
        });

        state.ws.on('close', () => {
          this.stopHeartbeat(state);
          this.scheduleReconnect(accountId, state);
        });

        state.ws.on('error', (error) => {
          console.error(`[YunzhijiaAdapter] Account "${accountId}" error:`, error.message);
        });
      } catch (error) {
        console.error(`[YunzhijiaAdapter] Failed to connect account "${accountId}":`, error);
        reject(error);
      }
    });
  }

  /** 推导 WebSocket URL */
  private deriveWebSocketUrl(sendMsgUrl: string): string {
    const url = new URL(sendMsgUrl);
    const host = url.host;
    const yzjtoken = url.searchParams.get('yzjtoken');
    return `wss://${host}/xuntong/websocket?yzjtoken=${yzjtoken}`;
  }

  /** 心跳保活 */
  private startHeartbeat(accountId: string, state: AccountState): void {
    const interval = state.config.heartbeatInterval || 30000;
    state.heartbeatTimer = setInterval(() => {
      if (state.ws?.readyState === WebSocket.OPEN) {
        state.ws.ping();
      }
    }, interval);
  }

  private stopHeartbeat(state: AccountState): void {
    if (state.heartbeatTimer) {
      clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = undefined;
    }
  }

  /** 断线重连（指数退避） */
  private scheduleReconnect(accountId: string, state: AccountState): void {
    const maxDelay = state.config.reconnectMaxDelay || 30000;
    const delay = Math.min(1000 * Math.pow(2, state.reconnectAttempts), maxDelay);
    state.reconnectAttempts++;

    console.log(`[YunzhijiaAdapter] Account "${accountId}" reconnecting in ${delay}ms (attempt ${state.reconnectAttempts})`);

    state.reconnectTimer = setTimeout(() => {
      this.connectWebSocket(accountId, state).catch((err) => {
        console.error(`[YunzhijiaAdapter] Reconnect failed for "${accountId}":`, err.message);
      });
    }, delay);
  }

  /** 停止单个账户 */
  private stopAccount(accountId: string, state: AccountState): void {
    this.stopHeartbeat(state);
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = undefined;
    }
    state.ws?.close();
    console.log(`[YunzhijiaAdapter] Account "${accountId}" stopped`);
  }

  /** 处理 WebSocket 消息 */
  private async handleWebSocketMessage(accountId: string, state: AccountState, data: WebSocket.RawData): Promise<void> {
    try {
      const rawData = data.toString();
      const wrapper = JSON.parse(rawData) as { msg?: Record<string, unknown> };

      if (!wrapper.msg) {
        console.log(`[YunzhijiaAdapter] No msg field in message: ${rawData.substring(0, 100)}`);
        return;
      }

      const msgData = wrapper.msg;

      // 检查 msgType（可能是数字或字符串）
      const msgType = Number(msgData.msgType);
      console.log(`[YunzhijiaAdapter] Message received, msgType: ${msgType}, content: ${(msgData.content as string)?.substring(0, 30)}`);

      // 只处理文本消息（msgType=2）
      if (msgType !== 2) {
        console.log(`[YunzhijiaAdapter] Ignoring non-text message, msgType: ${msgType}`);
        return;
      }

      const msgId = (msgData.msgId as string) || `${Date.now()}-${Math.random()}`;

      // 去重检查
      if (this.deduplicator.isDuplicate(msgId)) {
        console.log(`[YunzhijiaAdapter] Duplicate message ignored: ${msgId}`);
        return;
      }

      // 转换为内部格式
      const message = {
        accountId,
        robotId: (msgData.robotId as string) || '',
        robotName: (msgData.robotName as string) || '',
        senderId: (msgData.openId as string) || '',
        senderName: (msgData.operatorName as string) || (msgData.robotName as string) || 'Unknown',
        content: (msgData.content as string) || '',
        chatType: (msgData.groupType as number) === -3 ? 'private' : 'group',
        chatId: (msgData.groupId as string) || (msgData.openId as string),
        msgId,
      };

      console.log(`[YunzhijiaAdapter] Message received: ${message.content.substring(0, 50)} from ${message.senderName}`);

      // 调用消息处理器
      if (this.messageHandler) {
        try {
          await this.messageHandler(message);
        } catch (error) {
          console.error(`[YunzhijiaAdapter] Message handler error:`, error);
        }
      }
    } catch (error) {
      console.error(`[YunzhijiaAdapter] Failed to process message for "${accountId}":`, error);
    }
  }

  /** 发送消息到云之家 */
  private async sendToCloud(config: YunzhijiaAccountConfig, payload: unknown): Promise<void> {
    const timeout = (config.timeout || 10) * 1000;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(config.sendMsgUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }
    } catch (error) {
      console.error(`[YunzhijiaAdapter] Fetch error:`, error);
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** 获取所有账户 ID */
  getAccountIds(): string[] {
    return Array.from(this.accounts.keys());
  }

  /** 获取账户连接状态 */
  getAccountStatus(accountId: string): 'connected' | 'disconnected' | 'disabled' {
    const state = this.accounts.get(accountId);
    if (!state || !state.config.enabled) {
      return 'disabled';
    }
    return state.ws?.readyState === WebSocket.OPEN ? 'connected' : 'disconnected';
  }
}

/** 云之家签名验证 */
export class YunzhijiaSignatureVerifier {
  static verify(body: string, signature: string, secret: string): boolean {
    if (!signature || !secret) return false;

    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(body, 'utf8');
    const expectedSignature = hmac.digest('hex');

    return crypto.timingSafeEqual(
      Buffer.from(signature, 'utf8'),
      Buffer.from(expectedSignature, 'utf8')
    );
  }

  static extractSignature(headers: Record<string, string | undefined>): string | null {
    const signatureHeaders = [
      'x-yunzhijia-signature',
      'x-yunzhijia-sign',
      'x-signature',
      'signature',
    ];

    for (const header of signatureHeaders) {
      const value = headers[header] || headers[header.toLowerCase()];
      if (value) {
        if (value.includes('=')) {
          return value.split('=')[1];
        }
        return value;
      }
    }

    return null;
  }
}
