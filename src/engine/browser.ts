import { chromium as chromiumExtra } from 'playwright-extra';
import { createRequire } from 'module';
import type { Browser, BrowserContext, Page } from 'playwright';

// Load the stealth plugin (CommonJS) from an ESM module
const _require = createRequire(import.meta.url);
const StealthPlugin = _require('puppeteer-extra-plugin-stealth');
chromiumExtra.use(StealthPlugin());
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

    this.browser = await chromiumExtra.launch({
      headless: this.config.headless ?? true,
      args: launchArgs,
    }) as unknown as Browser;
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
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      hasTouch: false,
      extraHTTPHeaders: this.config.stealth
        ? {
            'Accept-Language': 'en-US,en;q=0.9',
            'sec-ch-ua': '"Chromium";v="121", "Not A(Brand";v="99"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
          }
        : undefined,
    });

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

    // Reddit's SPA aggressively blocks headless — transparently reroute to old.reddit.com
    const navigateUrl = url.match(/^https?:\/\/(www\.)?reddit\.com/)
      ? url.replace(/^(https?:\/\/)(www\.)?reddit\.com/, '$1old.reddit.com')
      : url;

    await page.goto(navigateUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await this.waitForStability(page);
    await this.dismissPopups(page);
    await this.forceRemoveOverlays(page);
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
    const normalized = this.normalizeSelector(selector);

    try {
      await page.click(normalized, { timeout: 10_000 });
    } catch (primaryErr) {
      // Fallback: if normalized selector still fails, try Playwright text-based locator
      const textMatch = normalized.match(/:has-text\("([^"]+)"\)/);
      if (textMatch) {
        const tagMatch = normalized.match(/^([a-zA-Z][a-zA-Z0-9]*)/);
        const tag = tagMatch ? tagMatch[1] : '*';
        const locator = page.locator(tag).filter({ hasText: textMatch[1]! }).first();
        try {
          await locator.click({ timeout: 10_000 });
        } catch {
          throw primaryErr; // surface original error
        }
      } else {
        throw primaryErr;
      }
    }

    await this.waitForStability(page);
  }

  async fill(sessionId: string, selector: string, value: string): Promise<void> {
    const page = this.getPage(sessionId);
    const normalized = this.normalizeSelector(selector);
    await page.fill(normalized, value, { timeout: 10_000 });
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

    // Only flag real CAPTCHA blocks — not cookie consent banners
    return (
      url.includes('/captcha') ||
      url.includes('/challenge') ||
      title.toLowerCase() === 'just a moment...' ||     // Cloudflare interstitial
      title.toLowerCase().includes('attention required') // Cloudflare block
    );
  }

  /** Auto-dismiss cookie consent banners, signup modals, and GDPR overlays */
  private async dismissPopups(page: Page): Promise<void> {
    const CONSENT_SELECTORS = [
      // OneTrust (BBC, many large sites)
      '#onetrust-accept-btn-handler',
      '.onetrust-accept-btn-handler',
      // Cookiebot
      '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
      '#CybotCookiebotDialogBodyButtonAccept',
      // Funding Choices (Google)
      '.fc-button.fc-cta-consent',
      '.fc-cta-consent',
      // Wikipedia cookie banner
      'button.cdx-button--action:has-text("Accept")',
      // Reddit (old.reddit.com) cookie consent
      '.cookie-policy-overlay button:has-text("Accept all")',
      'button[data-testid="GDPR-accept-button"]',
      'button:has-text("Accept all")',
      'button:has-text("Accept All")',
      'button:has-text("Accept non-essential cookies")',
      // Stack Overflow — close notice bar + modal
      '.js-notice-dismiss',
      'button[data-dismiss="modal"]',
      '.js-dismiss',
      '.js-close-button',
      'button[aria-label="Dismiss"]',
      // Generic
      '#accept-choices',
      '.accept-cookies',
      'button:has-text("I Accept")',
      'button:has-text("Got it")',
      'button:has-text("OK, I agree")',
      'button:has-text("Agree and continue")',
      '[aria-label="Accept all"]',
      '[aria-label="Accept cookies"]',
    ];

    // Wait for lazy-loaded popups to mount
    await page.waitForTimeout(1_500);

    for (const selector of CONSENT_SELECTORS) {
      try {
        const el = page.locator(selector).first();
        if (await el.isVisible({ timeout: 300 })) {
          await el.click({ timeout: 2_000 });
          await page.waitForTimeout(400);
          return;
        }
      } catch {
        // not present, try next
      }
    }

    try { await page.keyboard.press('Escape'); } catch { /* ignore */ }
  }

  /**
   * Force-remove overlays that block page content using JS.
   * Fallback when click-based dismissal doesn't find a button.
   */
  private async forceRemoveOverlays(page: Page): Promise<void> {
    try {
      await page.evaluate(() => {
        // Stack Overflow: signup interstitial and GDPR banners
        document.querySelectorAll(
          '.s-modal__backdrop, .s-modal, .js-consent-banner, ' +
          '#js-gdpr-consent-banner, .js-dismissable-hero, .ps-fixed',
        ).forEach((el) => el.remove());

        // Reddit old.reddit.com: cookie policy overlay
        document.querySelectorAll(
          '.cookie-policy-overlay, #cookie-policy-banner',
        ).forEach((el) => el.remove());

        // Generic: hide any fixed full-viewport overlay (modal backdrop)
        (document.querySelectorAll<HTMLElement>('*') as unknown as HTMLElement[]).forEach((el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          if (
            (style.position === 'fixed' || style.position === 'absolute') &&
            parseFloat(style.opacity ?? '1') > 0.3 &&
            rect.width > window.innerWidth * 0.85 &&
            rect.height > window.innerHeight * 0.75 &&
            !['BODY', 'HTML', 'HEADER', 'NAV', 'MAIN'].includes(el.tagName)
          ) {
            el.style.display = 'none';
          }
        });
      });
    } catch {
      // page may have navigated — ignore
    }
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /**
   * Normalize selectors for Playwright compatibility.
   * Converts non-standard pseudo-selectors to Playwright equivalents:
   *   :contains('text')  →  :has-text("text")
   *   [text='value']     →  :has-text("value")  (not a real CSS attribute)
   */
  private normalizeSelector(selector: string): string {
    return selector
      .replace(/:contains\(['"]([^'"]+)['"]\)/g, ':has-text("$1")')
      .replace(/\[text=['"]([^'"]+)['"]\]/g, ':has-text("$1")');
  }

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
