// ─────────────────────────────────────────────────────────────────────────────
// AgentBrowser — Public API
// A browser runtime purpose-built for AI agents, not humans.
// ─────────────────────────────────────────────────────────────────────────────

export { BrowserEngine } from './engine/browser.js';
export { SemanticAnalyzer } from './semantic/analyzer.js';
export { SiteMemoryStore } from './memory/store.js';
export { TaskExecutor } from './runtime/executor.js';
export { AgentBrowserMCPServer } from './server/mcp.js';

export type {
  SemanticPageModel,
  ActionDefinition,
  ActionResult,
  StateChange,
  AgentTask,
  TaskResult,
  AgentSession,
  SiteKnowledge,
  AgentBrowserConfig,
  PageType,
} from './types.js';

// ─── High-level convenience API ────────────────────────────────────────────

import { BrowserEngine } from './engine/browser.js';
import { SemanticAnalyzer } from './semantic/analyzer.js';
import { SiteMemoryStore } from './memory/store.js';
import { TaskExecutor } from './runtime/executor.js';
import type { AgentBrowserConfig, SemanticPageModel, ActionResult } from './types.js';

/**
 * AgentBrowser — the main class.
 *
 * Usage:
 * ```typescript
 * const browser = new AgentBrowser({ anthropic_api_key: '...' });
 * await browser.launch();
 *
 * const state = await browser.navigate('https://example.com');
 * console.log(state.page_type);       // 'login'
 * console.log(state.available_actions); // ['authenticate', 'signup']
 *
 * const result = await browser.action('authenticate', {
 *   email: 'user@example.com',
 *   password: 'secret'
 * });
 * console.log(result.state_change.summary); // 'Navigated from login to dashboard'
 *
 * await browser.close();
 * ```
 */
export class AgentBrowser {
  private engine: BrowserEngine;
  private analyzer: SemanticAnalyzer;
  private memory: SiteMemoryStore;
  private executor: TaskExecutor;
  private sessionId: string | null = null;

  constructor(config: AgentBrowserConfig) {
    this.engine = new BrowserEngine(config);
    this.analyzer = new SemanticAnalyzer(config);
    this.memory = new SiteMemoryStore(config.memory_db_path);
    this.executor = new TaskExecutor(this.engine, this.analyzer, this.memory);
  }

  async launch(): Promise<void> {
    await this.engine.launch();
    this.sessionId = await this.engine.createSession();
  }

  async close(): Promise<void> {
    if (this.sessionId) {
      await this.engine.destroySession(this.sessionId);
    }
    await this.engine.close();
    this.memory.close();
  }

  async navigate(url: string): Promise<SemanticPageModel> {
    this.ensureSession();
    return this.executor.navigate(this.sessionId!, url);
  }

  async state(): Promise<SemanticPageModel> {
    this.ensureSession();
    return this.executor.getPageState(this.sessionId!);
  }

  async action(name: string, params: Record<string, unknown> = {}): Promise<ActionResult> {
    this.ensureSession();
    return this.executor.executeAction(this.sessionId!, name, params);
  }

  async fill(formName: string, data: Record<string, string>): Promise<ActionResult> {
    this.ensureSession();
    return this.executor.fillForm(this.sessionId!, formName, data);
  }

  async extract(schema: Record<string, string>): Promise<Record<string, unknown>> {
    this.ensureSession();
    return this.executor.extract(this.sessionId!, schema);
  }

  async saveSession(id?: string): Promise<string> {
    this.ensureSession();
    const state = await this.engine.exportSessionState(this.sessionId!);
    const session = {
      id: id ?? this.sessionId!,
      created_at: Date.now(),
      last_active: Date.now(),
      auth_domains: [],
      storage_state: state,
      history: [],
    };
    this.memory.saveSession(session);
    return session.id;
  }

  async restoreSession(id: string): Promise<void> {
    const saved = this.memory.getSession(id);
    if (!saved) throw new Error(`Session '${id}' not found`);
    if (this.sessionId) await this.engine.destroySession(this.sessionId);
    this.sessionId = await this.engine.createSession(saved);
  }

  getMemoryStats() {
    return this.memory.getStats();
  }

  private ensureSession(): void {
    if (!this.sessionId) throw new Error('Browser not launched. Call launch() first.');
  }
}
