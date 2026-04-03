/**
 * 云之家渠道模块导出
 */
export { YunzhijiaAdapter } from './adapters/yunzhijia.js';
export { YunzhijiaSignatureVerifier } from './adapters/yunzhijia.js';
export { YunzhijiaManager, getYunzhijiaManager, initYunzhijia, stopYunzhijia } from './manager.js';

export type {
  YunzhijiaChannelConfig,
  YunzhijiaAccountConfig,
  YunzhijiaMessage,
  MessageHandler,
  SendResponseFunc,
} from './adapters/yunzhijia.js';
