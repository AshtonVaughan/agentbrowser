import { chromium, Browser, BrowserContext, Page } from 'playwright';
import type {
  AgentBrowserConfig,
  AgentSession,
  PlaywrightStorageState,
} from '../types.js';
import { randomUUID } from 'crypto';

// ─────────────────────────────────────────────────────────────────────────────
// BrowserEngine — Playwright wrapper with agent-native lifecycle
// Agents never touch this directly. They go through the Task Runtime.
// ─────────────────────────────────────────────────────────────────────────────

export class BrowserEngine {
  private browser: Browser | null = null;
  private contexts: Map<string, BrowserContext> = new Map();
  private pages: Map<string, Page> = new Map();
  private config: AgentBrowserConfig;

  constructor(config: AgentBrowserConfig) {
    this.config = config;
  }

  async launch(): Promise<void> {
    const launchArgs: string[] = [];

    if (this.config.stealth) {
      launchArgs.push(
        '--disable-blink-features=AutomationControlled',
        '--disable-web-security',
        '--no-sandbox',
        '--disable-setuid-sandbox',
      );
    }

    this.browser = await chromium.launch({
      headless: this.config.headless ?? true,
      args: launchArgs,
    });
  }

  async close(): Promise<void> {
    for (const ctx of this.contexts.values()) {
      await ctx.close();
    }
    this.contexts.clear();
    this.pages.clear();
    await this.browser?.close();
    this.browser = null;
  }

  // ─── Session Management ────────────────────────────────────────────────────

  async createSession(session?: Partial<AgentSession>): Promise<string> {
    if (!this.browser) throw new Error('Browser not launched');

    const sessionId = session?.id ?? randomUUID();
    const storageState = session?.storage_state as PlaywrightStorageState | undefined;

    const context = await this.browser.newContext({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      storageState: storageState ? (storageState as any) : undefined,
      userAgent: this.config.stealth ? getRandomUserAgent() : undefined,
      viewport: { width: 1280, height: 800 },
      // Make automation harder to detect
      extraHTTPHeaders: this.config.stealth
        ? { 'Accept-Language': 'en-US,en;q=0.9' }
        : undefined,
    });

    if (this.config.stealth) {
      await this.applyStealthPatches(context);
    }

    const page = await context.newPage();
    this.contexts.set(sessionId, context);
    this.pages.set(sessionId, page);

    return sessionId;
  }

  async destroySession(sessionId: string): Promise<void> {
    const ctx = this.contexts.get(sessionId);
    if (ctx) await ctx.close();
    this.contexts.delete(sessionId);
    this.pages.delete(sessionId);
  }

  async exportSessionState(sessionId: string): Promise<PlaywrightStorageState> {
    const ctx = this.contexts.get(sessionId);
    if (!ctx) throw new Error(`Session ${sessionId} not found`);
    return await ctx.storageState() as unknown as PlaywrightStorageState;
  }

  async branchSession(sourceId: string): Promise<string> {
    const state = await this.exportSessionState(sourceId);
    return this.createSession({ storage_state: state });
  }

  // ─── Navigation ────────────────────────────────────────────────────────────

  async navigate(sessionId: string, url: string): Promise<void> {
    const page = this.getPage(sessionId);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await this.waitForStability(page);
  }

  async getCurrentUrl(sessionId: string): Promise<string> {
    return this.getPage(sessionId).url();
  }

  // ─── DOM Operations (internal only — not exposed to agents) ───────────────

  async getPageHTML(sessionId: string): Promise<string> {
    const page = this.getPage(sessionId);
    return await page.content();
  }

  async getAccessibilityTree(sessionId: string): Promise<string> {
    const page = this.getPage(sessionId);
    // Use ARIA snapshot (Playwright 1.46+) — structured, compact, meaningful
    try {
      const snapshot = await page.evaluate(() => {
        // Collect interactive and semantic elements as a lightweight tree
        const elements: Record<string, string>[] = [];
        const selectors = 'input, button, select, textarea, a[href], [role], h1, h2, h3, label, form';
        document.querySelectorAll(selectors).forEach((el) => {
          const role = el.getAttribute('role') ?? el.tagName.toLowerCase();
          const text = (el as HTMLElement).innerText?.slice(0, 100) ?? '';
          const label = el.getAttribute('aria-label') ?? el.getAttribute('placeholder') ?? '';
          const name = el.getAttribute('name') ?? el.getAttribute('id') ?? '';
          const type = el.getAttribute('type') ?? '';
          if (text || label || name) {
            elements.push({ role, text, label, name, type });
          }
        });
        return JSON.stringify(elements);
      });
      return snapshot;
    } catch {
      return '';
    }
  }

  async click(sessionId: string, selector: string): Promise<void> {
    const page = this.getPage(sessionId);
    await page.click(selector, { timeout: 10_000 });
    await this.waitForStability(page);
  }

  async fill(sessionId: string, selector: string, value: string): Promise<void> {
    const page = this.getPage(sessionId);
    await page.fill(selector, value, { timeout: 10_000 });
  }

  async select(sessionId: string, selector: string, value: string): Promise<void> {
    const page = this.getPage(sessionId);
    await page.selectOption(selector, value, { timeout: 10_000 });
  }

  async evaluate<T>(sessionId: string, fn: string): Promise<T> {
    const page = this.getPage(sessionId);
    return await page.evaluate(fn) as T;
  }

  async screenshot(sessionId: string): Promise<Buffer> {
    const page = this.getPage(sessionId);
    return await page.screenshot({ type: 'png' });
  }

  async checkForCaptcha(sessionId: string): Promise<boolean> {
    const page = this.getPage(sessionId);
    const url = page.url();
    const title = await page.title();
    const html = await page.content();

    return (
      url.includes('captcha') ||
      url.includes('challenge') ||
      title.toLowerCase().includes('captcha') ||
      html.includes('cf-challenge') ||
      html.includes('g-recaptcha') ||
      html.includes('hcaptcha')
    );
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private getPage(sessionId: string): Page {
    const page = this.pages.get(sessionId);
    if (!page) throw new Error(`Session ${sessionId} not found or not initialized`);
    return page;
  }

  private async waitForStability(page: Page): Promise<void> {
    // Wait for network to be idle and no pending navigations
    try {
      await Promise.race([
        page.waitForLoadState('networkidle', { timeout: 5_000 }),
        new Promise((resolve) => setTimeout(resolve, 3_000)),
      ]);
    } catch {
      // Timeout is fine — page may have long-running requests
    }
  }

  private async applyStealthPatches(context: BrowserContext): Promise<void> {
    await context.addInitScript(() => {
      // Remove webdriver flag
      Object.defineProperty(navigator, 'webdriver', { get: () => false });

      // Fake plugins
      Object.defineProperty(navigator, 'plugins', {
        get: () => [{ name: 'Chrome PDF Plugin' }, { name: 'Chrome PDF Viewer' }],
      });

      // Fake languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
      });
    });
  }
}

// ─── Utilities ─────────────────────────────────────────────────────────────

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];

function getRandomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]!;
}
