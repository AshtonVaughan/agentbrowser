import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { AgentBrowserConfig } from '../types.js';
import { BrowserEngine } from '../engine/browser.js';
import { SemanticAnalyzer } from '../semantic/analyzer.js';
import { SiteMemoryStore } from '../memory/store.js';
import { TaskExecutor } from '../runtime/executor.js';

// ─────────────────────────────────────────────────────────────────────────────
// AgentBrowser MCP Server
//
// Exposes the browser as a tool server. Any MCP-compatible agent connects here.
// Tools update dynamically as the page changes.
// ─────────────────────────────────────────────────────────────────────────────

export class AgentBrowserMCPServer {
  private server: Server;
  private engine: BrowserEngine;
  private analyzer: SemanticAnalyzer;
  private memory: SiteMemoryStore;
  private executor: TaskExecutor;
  private activeSession: string | null = null;

  constructor(config: AgentBrowserConfig) {
    this.engine = new BrowserEngine(config);
    this.analyzer = new SemanticAnalyzer(config);
    this.memory = new SiteMemoryStore(config.memory_db_path);
    this.executor = new TaskExecutor(this.engine, this.analyzer, this.memory);

    this.server = new Server(
      { name: 'agentbrowser', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );

    this.registerHandlers();
  }

  private registerHandlers(): void {
    // ── List Tools ────────────────────────────────────────────────────────────
    // Returns BOTH static tools + dynamic page-specific tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const staticTools = this.getStaticTools();

      // Add dynamic tools from current page state if a session is active
      if (this.activeSession) {
        try {
          const model = await this.executor.getPageState(this.activeSession);
          const dynamicTools = model.available_actions.map((action) => ({
            name: `page__${action.name}`,
            description: `[Current page: ${model.page_type}] ${action.description}`,
            inputSchema: {
              type: 'object' as const,
              properties: Object.fromEntries(
                action.parameters.map((p) => [
                  p.name,
                  { type: p.type, description: p.description },
                ]),
              ),
              required: action.parameters.filter((p) => p.required).map((p) => p.name),
            },
          }));

          return { tools: [...staticTools, ...dynamicTools] };
        } catch {
          // Fall through to static tools only
        }
      }

      return { tools: staticTools };
    });

    // ── Call Tool ─────────────────────────────────────────────────────────────
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        // Dynamic page action (prefixed with page__)
        if (name.startsWith('page__')) {
          return await this.handlePageAction(name.slice(6), args ?? {});
        }

        // Static tools
        switch (name) {
          case 'navigate':
            return await this.handleNavigate(args ?? {});
          case 'get_page_state':
            return await this.handleGetPageState();
          case 'extract':
            return await this.handleExtract(args ?? {});
          case 'fill_form':
            return await this.handleFillForm(args ?? {});
          case 'start_session':
            return await this.handleStartSession(args ?? {});
          case 'end_session':
            return await this.handleEndSession();
          case 'save_session':
            return await this.handleSaveSession(args ?? {});
          case 'restore_session':
            return await this.handleRestoreSession(args ?? {});
          case 'run_parallel':
            return await this.handleRunParallel(args ?? {});
          case 'get_memory_stats':
            return await this.handleGetMemoryStats();
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    });
  }

  // ─── Tool Handlers ─────────────────────────────────────────────────────────

  private async handleNavigate(args: Record<string, unknown>) {
    const { url, session_id } = z
      .object({ url: z.string().url(), session_id: z.string().optional() })
      .parse(args);

    if (!this.activeSession) {
      this.activeSession = await this.engine.createSession();
    }

    const model = await this.executor.navigate(this.activeSession, url);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              page_type: model.page_type,
              task_status: model.task_status,
              key_data: model.key_data,
              available_actions: model.available_actions.map((a) => ({
                name: a.name,
                description: a.description,
                parameters: a.parameters,
              })),
              warnings: model.warnings,
              url: model.url,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  private async handleGetPageState() {
    if (!this.activeSession) {
      return {
        content: [{ type: 'text', text: 'No active session. Call navigate or start_session first.' }],
        isError: true,
      };
    }

    const model = await this.executor.getPageState(this.activeSession);

    return {
      content: [{ type: 'text', text: JSON.stringify(model, null, 2) }],
    };
  }

  private async handleExtract(args: Record<string, unknown>) {
    if (!this.activeSession) throw new Error('No active session');

    const { schema } = z
      .object({ schema: z.record(z.string()) })
      .parse(args);

    const data = await this.executor.extract(this.activeSession, schema);

    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    };
  }

  private async handleFillForm(args: Record<string, unknown>) {
    if (!this.activeSession) throw new Error('No active session');

    const { form_name, data } = z
      .object({ form_name: z.string(), data: z.record(z.string()) })
      .parse(args);

    const result = await this.executor.fillForm(this.activeSession, form_name, data);

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }

  private async handlePageAction(actionName: string, args: Record<string, unknown>) {
    if (!this.activeSession) throw new Error('No active session');

    const result = await this.executor.executeAction(
      this.activeSession,
      actionName,
      args,
    );

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }

  private async handleStartSession(args: Record<string, unknown>) {
    const { session_id } = z
      .object({ session_id: z.string().optional() })
      .parse(args);

    if (this.activeSession) {
      await this.engine.destroySession(this.activeSession);
    }

    this.activeSession = await this.engine.createSession(
      session_id ? { id: session_id } : undefined,
    );

    return {
      content: [{ type: 'text', text: JSON.stringify({ session_id: this.activeSession }) }],
    };
  }

  private async handleEndSession() {
    if (this.activeSession) {
      await this.engine.destroySession(this.activeSession);
      this.activeSession = null;
    }
    return { content: [{ type: 'text', text: '{"success": true}' }] };
  }

  private async handleSaveSession(args: Record<string, unknown>) {
    if (!this.activeSession) throw new Error('No active session');

    const state = await this.engine.exportSessionState(this.activeSession);
    const session = {
      id: this.activeSession,
      created_at: Date.now(),
      last_active: Date.now(),
      auth_domains: [],
      storage_state: state,
      history: [],
    };

    this.memory.saveSession(session);

    return {
      content: [{ type: 'text', text: JSON.stringify({ saved: true, session_id: this.activeSession }) }],
    };
  }

  private async handleRestoreSession(args: Record<string, unknown>) {
    const { session_id } = z.object({ session_id: z.string() }).parse(args);
    const saved = this.memory.getSession(session_id);

    if (!saved) throw new Error(`Session ${session_id} not found in memory`);

    if (this.activeSession) {
      await this.engine.destroySession(this.activeSession);
    }

    this.activeSession = await this.engine.createSession(saved);

    return {
      content: [{ type: 'text', text: JSON.stringify({ restored: true, session_id: this.activeSession }) }],
    };
  }

  private async handleRunParallel(args: Record<string, unknown>) {
    const { tasks } = z
      .object({
        tasks: z.array(
          z.object({
            id: z.string().optional(),
            goal: z.string(),
            url: z.string().url(),
            context: z.record(z.unknown()).optional(),
          }),
        ),
      })
      .parse(args);

    const results = await this.executor.runParallel(
      tasks.map((t) => ({ ...t, id: t.id ?? crypto.randomUUID() })),
    );

    return {
      content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
    };
  }

  private async handleGetMemoryStats() {
    const stats = this.memory.getStats();
    return {
      content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }],
    };
  }

  // ─── Static Tool Definitions ───────────────────────────────────────────────

  private getStaticTools() {
    return [
      {
        name: 'navigate',
        description: 'Navigate to a URL. Returns the semantic page state — what the page is, what you can do, and what data it contains. No HTML returned.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            url: { type: 'string', description: 'Full URL to navigate to' },
          },
          required: ['url'],
        },
      },
      {
        name: 'get_page_state',
        description: 'Get the current semantic state of the page — page type, key data, available actions, warnings.',
        inputSchema: { type: 'object' as const, properties: {} },
      },
      {
        name: 'extract',
        description: 'Extract structured data from the current page using a schema. Returns typed values or null for missing fields.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            schema: {
              type: 'object',
              description: 'Key-value schema where keys are field names and values are descriptions of what to extract',
              additionalProperties: { type: 'string' },
            },
          },
          required: ['schema'],
        },
      },
      {
        name: 'fill_form',
        description: 'Fill a form on the current page by semantic name. Returns result including what changed.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            form_name: { type: 'string', description: 'Name of the form to fill' },
            data: {
              type: 'object',
              description: 'Field name/label → value mapping',
              additionalProperties: { type: 'string' },
            },
          },
          required: ['form_name', 'data'],
        },
      },
      {
        name: 'start_session',
        description: 'Start a new browser session. Returns session_id.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            session_id: { type: 'string', description: 'Optional: specific session ID to use' },
          },
        },
      },
      {
        name: 'end_session',
        description: 'End the current browser session.',
        inputSchema: { type: 'object' as const, properties: {} },
      },
      {
        name: 'save_session',
        description: 'Save the current session (cookies, auth state) to persistent memory for later restoration.',
        inputSchema: { type: 'object' as const, properties: {} },
      },
      {
        name: 'restore_session',
        description: 'Restore a previously saved session including auth state.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            session_id: { type: 'string', description: 'Session ID to restore' },
          },
          required: ['session_id'],
        },
      },
      {
        name: 'run_parallel',
        description: 'Run multiple browser tasks in parallel across separate sessions. Each task gets its own isolated browser context.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            tasks: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  goal: { type: 'string' },
                  url: { type: 'string' },
                  context: { type: 'object' },
                },
                required: ['goal', 'url'],
              },
            },
          },
          required: ['tasks'],
        },
      },
      {
        name: 'get_memory_stats',
        description: 'Get statistics about accumulated site knowledge — how many domains, sessions, and actions the system has learned.',
        inputSchema: { type: 'object' as const, properties: {} },
      },
    ];
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    await this.engine.launch();
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('AgentBrowser MCP server started');
  }

  async stop(): Promise<void> {
    if (this.activeSession) {
      await this.engine.destroySession(this.activeSession);
    }
    await this.engine.close();
    this.memory.close();
  }
}

// ─── Entry point when run directly ────────────────────────────────────────

const config: AgentBrowserConfig = {
  anthropic_api_key: process.env.ANTHROPIC_API_KEY ?? '',
  memory_db_path: process.env.AGENTBROWSER_DB_PATH,
  headless: process.env.AGENTBROWSER_HEADLESS !== 'false',
  stealth: process.env.AGENTBROWSER_STEALTH !== 'false',
};

const mcpServer = new AgentBrowserMCPServer(config);

process.on('SIGINT', async () => {
  await mcpServer.stop();
  process.exit(0);
});

await mcpServer.start();
