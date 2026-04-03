/**
 * 云之家消息处理器
 * 接收消息 → 调用 Claude Code → 返回结果
 */
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { getYunzhijiaManager } from './manager.js';

/** Claude Code 配置 */
interface ClaudeCodeConfig {
  claudeBinPath?: string;
  workDir?: string;
}

// ESM 下获取 __dirname 的等价方法
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** 消息处理器 */
export class MessageProcessor {
  private config: ClaudeCodeConfig;
  private processing = false;
  private claudeProcess?: ReturnType<typeof spawn>;
  private messageQueue: Array<{
    accountId: string;
    senderName: string;
    content: string;
    msgId: string;
  }> = [];

  constructor(config: ClaudeCodeConfig = {}) {
    // 查找 Claude Code 可执行文件
    const rootDir = path.resolve(__dirname, '../..');
    const claudeBin = config.claudeBinPath || path.join(rootDir, 'bin', 'claude-haha');

    this.config = {
      claudeBinPath: fs.existsSync(claudeBin) ? claudeBin : 'claude',
      workDir: config.workDir || rootDir,
    };

    console.log('[MessageProcessor] Config:', {
      claudeBinPath: this.config.claudeBinPath,
      workDir: this.config.workDir,
    });
  }

  /** 调用一次 Claude Code */
  private async callClaudeOnce(prompt: string): Promise<{
    output: string;
    hasToolCall: boolean;
    toolCalls: Array<{ name: string; args: string }>;
  }> {
    return new Promise((resolve, reject) => {
      console.log(`[MessageProcessor] Calling Claude Code: "${prompt.substring(0, 30)}..."`);

      // 使用临时文件传递 prompt，解决中文编码问题
      const tmpDir = os.tmpdir();
      const promptFile = path.join(tmpDir, `claude-prompt-${Date.now()}.txt`);
      fs.writeFileSync(promptFile, prompt, 'utf-8');
      const cmd = `& '${this.config.claudeBinPath}' -p --output-format text --dangerously-skip-permissions --allowed-tools 'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch' < '${promptFile}'`;

      const proc = spawn(cmd, [], {
        cwd: this.config.workDir,
        shell: true,
      });

      let output = '';
      let errorOutput = '';

      proc.stdout.on('data', (data) => {
        // 尝试 UTF-8 解码，如果失败则使用默认编码
        let text: string;
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(data);
        } catch {
          text = data.toString('utf-8');
        }
        output += text;
        process.stdout.write(`[Claude Code] ${text}`);
      });

      proc.stderr.on('data', (data) => {
        let text: string;
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(data);
        } catch {
          text = data.toString('utf-8');
        }
        errorOutput += text;
        process.stderr.write(`[Claude Code Error] ${text}`);
      });

      proc.on('close', (code) => {
        // 清理临时文件
        try {
          fs.unlinkSync(promptFile);
        } catch {}

        console.log(`[MessageProcessor] Claude Code exited with code ${code}, output length: ${output.length}, error length: ${errorOutput.length}`);

        // 即使 code 是 0，如果有错误输出也需要检查
        if (code === 0 && output.trim()) {
          // 检查是否有常见错误信息在输出中
          const combined = output + errorOutput;
          if (combined.includes('require is not defined') || combined.includes('ReferenceError')) {
            console.error('[MessageProcessor] Detected JavaScript error in output');
            reject(new Error(`Claude Code 执行出错: ${combined.substring(0, 200)}`));
            return;
          }

          const cleanOutput = this.stripAnsi(output);
          const toolCalls = this.extractToolCalls(cleanOutput);
          resolve({
            output: cleanOutput,
            hasToolCall: toolCalls.length > 0,
            toolCalls,
          });
        } else if (errorOutput.trim()) {
          reject(new Error(errorOutput.trim()));
        } else {
          reject(new Error(`Claude Code exited with code ${code}, no output`));
        }
      });

      proc.on('error', (error) => {
        try { fs.unlinkSync(promptFile); } catch {}
        reject(error);
      });

      // 60秒超时
      setTimeout(() => {
        proc.kill();
        try { fs.unlinkSync(promptFile); } catch {}
        reject(new Error('Claude Code timeout (60s)'));
      }, 60000);
    });
  }

  /** 从输出中提取工具调用 */
  private extractToolCalls(output: string): Array<{ name: string; args: string }> {
    const toolCalls: Array<{ name: string; args: string }> = [];
    const regex = /<invoke name="([^"]+)">([\s\S]*?)<\/invoke>/g;
    let match;

    while ((match = regex.exec(output)) !== null) {
      toolCalls.push({
        name: match[1],
        args: match[2].trim(),
      });
    }

    if (toolCalls.length > 0) {
      console.log('[MessageProcessor] Detected tool calls:', toolCalls.map(t => t.name).join(', '));
    }

    return toolCalls;
  }

  /** 执行工具调用 */
  private async executeTool(name: string, args: string): Promise<string> {
    console.log(`[MessageProcessor] Executing tool: ${name}`);

    // 敏感操作不允许执行
    const dangerousTools = ['rm', 'rmdir', 'del', 'delete', 'rm -rf', 'TaskStop', 'kill'];
    if (dangerousTools.some(d => name.toLowerCase().includes(d.toLowerCase()))) {
      return `[拒绝执行] 工具 ${name} 被认为是敏感操作`;
    }

    try {
      // 解析参数
      let parsedArgs: Record<string, unknown>;
      try {
        parsedArgs = JSON.parse(args);
      } catch {
        parsedArgs = { _raw: args };
      }

      // 执行对应工具
      const result = await this.runToolFunction(name, parsedArgs);
      return JSON.stringify(result);
    } catch (error) {
      return `[工具执行失败] ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** 工具函数映射 */
  private async runToolFunction(name: string, args: Record<string, unknown>): Promise<unknown> {
    const toolName = name.toLowerCase();

    // WebSearch
    if (toolName === 'websearch') {
      const { query } = args as { query?: string };
      if (!query) return { error: '缺少 query 参数' };
      return { results: `WebSearch 结果 for: ${query}`, note: 'WebSearch 需要集成实际搜索API' };
    }

    // WebFetch
    if (toolName === 'webfetch') {
      const { url, prompt } = args as { url?: string; prompt?: string };
      if (!url) return { error: '缺少 url 参数' };
      return { content: `WebFetch: ${url}`, prompt };
    }

    // Read
    if (toolName === 'read') {
      const { file_path } = args as { file_path?: string };
      if (!file_path) return { error: '缺少 file_path 参数' };
      try {
        const content = fs.readFileSync(file_path, 'utf-8');
        return { content: content.substring(0, 5000) };
      } catch {
        return { error: `无法读取文件: ${file_path}` };
      }
    }

    // Glob
    if (toolName === 'glob') {
      const { pattern, path: globPath } = args as { pattern?: string; path?: string };
      if (!pattern) return { error: '缺少 pattern 参数' };
      return { files: [`${globPath || '.'}/${pattern} mock result`], note: 'Glob 需要集成实际搜索' };
    }

    // Grep
    if (toolName === 'grep') {
      const { pattern, path: grepPath } = args as { pattern?: string; path?: string };
      if (!pattern) return { error: '缺少 pattern 参数' };
      return { matches: [`${grepPath || '.'}/${pattern} mock result`], note: 'Grep 需要集成实际搜索' };
    }

    return { error: `未知工具: ${name}` };
  }

  /** 使用 Claude Code 处理消息（支持多轮工具调用） */
  async processWithClaudeCode(message: {
    accountId: string;
    senderName: string;
    content: string;
    msgId: string;
  }): Promise<string> {
    const maxRounds = 5;
    let context = message.content;

    for (let round = 0; round < maxRounds; round++) {
      console.log(`[MessageProcessor] Round ${round + 1}/${maxRounds}`);

      const { output, hasToolCall, toolCalls } = await this.callClaudeOnce(context);

      if (!hasToolCall) {
        // 没有工具调用，返回最终回复
        return this.extractReplyText(output);
      }

      // 有工具调用，执行并把结果加到上下文
      for (const toolCall of toolCalls) {
        const result = await this.executeTool(toolCall.name, toolCall.args);
        context += `\n\n[工具 ${toolCall.name} 执行结果]\n${result}\n\n请继续处理...`;
      }
    }

    // 达到最大轮次
    return this.extractReplyText(context) || '已达到最大处理轮次';
  }

  /** 去除 ANSI 颜色代码 */
  private stripAnsi(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
  }

  /** 提取纯文本回复（去除思考过程） */
  private extractReplyText(fullOutput: string): string {
    console.log('[extractReplyText] raw input:', JSON.stringify(fullOutput));

    // 查找最后一个 ]]> 的位置（Claude Code 的 thinking 结束标签）
    const thinkEndTag = '</think>';
    const thinkEnd = fullOutput.lastIndexOf(thinkEndTag);

    let replyText: string;
    if (thinkEnd !== -1) {
      // 获取 ]]> 之后的内容
      replyText = fullOutput.substring(thinkEnd + thinkEndTag.length);
    } else {
      // 如果没有思考块，直接返回
      replyText = fullOutput;
    }

    // 清理残留的特殊字符
    replyText = replyText
      .replace(/^[\n\r\s]+/g, '')  // 开头的换行和空格
      .replace(/[\n\r\s]+$/g, ''); // 结尾的换行和空格

    console.log('[extractReplyText] cleaned:', JSON.stringify(replyText));
    return replyText;
  }

  /** 处理单条消息 */
  async processMessage(message: {
    accountId: string;
    senderName: string;
    content: string;
    msgId: string;
  }): Promise<void> {
    console.log(`[MessageProcessor] Processing: "${message.content}" from ${message.senderName}`);

    try {
      // 调用 Claude Code 处理
      const replyText = await this.processWithClaudeCode(message);

      console.log(`[MessageProcessor] Claude Code response: ${replyText.substring(0, 50)}...`);

      // 发送回复
      await this.sendReply(message.accountId, replyText);

    } catch (error) {
      console.error('[MessageProcessor] Claude Code error:', error);
      await this.sendReply(message.accountId, `处理出错: ${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  /** 发送回复到云之家 */
  private async sendReply(accountId: string, content: string): Promise<void> {
    const manager = getYunzhijiaManager();

    try {
      await manager.sendResponse(accountId, content);
      console.log(`[MessageProcessor] Reply sent to ${accountId}: ${content.substring(0, 30)}...`);
    } catch (error) {
      console.error('[MessageProcessor] Failed to send reply:', error);
    }
  }

  /** 启动消息处理循环 */
  start(): void {
    console.log('[MessageProcessor] Starting message processing loop');

    // 每2秒检查一次待处理消息
    setInterval(async () => {
      // 防止重复处理
      if (this.processing) {
        console.log('[MessageProcessor] Still processing, skip this round');
        return;
      }

      const manager = getYunzhijiaManager();
      const messages = manager.getPendingMessages();

      if (messages.length === 0) return;

      // 处理最早的消息
      const msg = messages[0];
      this.processing = true;

      try {
        await this.processMessage({
          accountId: msg.accountId,
          senderName: msg.senderName,
          content: msg.content,
          msgId: msg.id,
        });

        // 标记消息已处理
        manager.markMessageProcessed(msg.id);
      } catch (error) {
        console.error('[MessageProcessor] Error processing message:', error);
      } finally {
        this.processing = false;
      }
    }, 2000);
  }
}

/** 全局消息处理器 */
let messageProcessor: MessageProcessor | null = null;

/** 初始化消息处理器 */
export function initMessageProcessor(config?: ClaudeCodeConfig): MessageProcessor {
  messageProcessor = new MessageProcessor(config);
  messageProcessor.start();
  return messageProcessor;
}

/** 获取消息处理器 */
export function getMessageProcessor(): MessageProcessor | null {
  return messageProcessor;
}
