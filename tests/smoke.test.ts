import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AgentBrowser, SiteMemoryStore } from '../src/index.js';
import type { SemanticPageModel } from '../src/index.js';

// Mock the Anthropic SDK so tests run without a real API key
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = {
        create: vi.fn().mockResolvedValue({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                page_type: 'login',
                task_status: 'ready for authentication',
                key_data: { site: 'test' },
                available_actions: [
                  {
                    name: 'authenticate',
                    description: 'Log in with credentials',
                    parameters: [
                      { name: 'email', type: 'string', description: 'Email address', required: true },
                      { name: 'password', type: 'string', description: 'Password', required: true },
                    ],
                    returns: 'Authenticated session state',
                  },
                ],
                warnings: [],
                navigation: [],
                forms: [
                  {
                    name: 'login_form',
                    purpose: 'User authentication',
                    fields: [
                      { name: 'email', label: 'Email', type: 'email', required: true, selector: 'input[name="email"]' },
                      { name: 'password', label: 'Password', type: 'password', required: true, selector: 'input[name="password"]' },
                    ],
                    submit_action: 'authenticate',
                  },
                ],
              }),
            },
          ],
        }),
      };
    },
  };
});

const config = {
  anthropic_api_key: 'test-key',
  headless: true,
  stealth: false,
  memory_db_path: '/tmp/agentbrowser-test.db',
};

describe('AgentBrowser smoke tests', () => {
  let browser: AgentBrowser;

  beforeAll(async () => {
    browser = new AgentBrowser(config);
    await browser.launch();
  });

  afterAll(async () => {
    await browser.close();
  });

  it('launches without error', () => {
    expect(browser).toBeDefined();
  });

  it('navigate returns a SemanticPageModel', async () => {
    const html = `data:text/html,<html><body>
      <form>
        <input type="email" name="email"/>
        <input type="password" name="password"/>
        <button type="submit">Login</button>
      </form>
    </body></html>`;

    const model = await browser.navigate(html);

    expect(model).toBeDefined();
    expect(model.url).toBeTruthy();
    expect(model.timestamp).toBeGreaterThan(0);
    expect(model.page_type).toBe('login');
    expect(Array.isArray(model.available_actions)).toBe(true);
    expect(model.available_actions[0]?.name).toBe('authenticate');
    expect(Array.isArray(model.warnings)).toBe(true);
    expect(Array.isArray(model.forms)).toBe(true);
  });

  it('state() returns current page model', async () => {
    const state = await browser.state();
    expect(state).toBeDefined();
    expect(state.url).toBeTruthy();
    expect(state.page_type).toBe('login');
  });

  it('extract() returns structured data', async () => {
    const data = await browser.extract({ site: 'site name' });
    expect(data).toBeDefined();
    expect(typeof data).toBe('object');
  });

  it('memory stats returns counts', () => {
    const stats = browser.getMemoryStats();
    expect(stats).toHaveProperty('domains');
    expect(stats).toHaveProperty('sessions');
    expect(stats).toHaveProperty('actions');
    expect(typeof stats.domains).toBe('number');
  });

  it('save and restore session works', async () => {
    const sessionId = await browser.saveSession('test-session');
    expect(sessionId).toBe('test-session');

    await browser.restoreSession('test-session');
    const state = await browser.state();
    expect(state).toBeDefined();
  });
});

describe('SiteMemoryStore unit tests', () => {
  let store: SiteMemoryStore;

  beforeAll(() => {
    store = new SiteMemoryStore('/tmp/agentbrowser-unit-test.db');
  });

  afterAll(() => {
    store.close();
  });

  it('saves and retrieves site knowledge', () => {
    store.saveSiteKnowledge({
      domain: 'example.com',
      last_updated: Date.now(),
      visit_count: 1,
      known_page_types: {},
    });

    const knowledge = store.getSiteKnowledge('example.com');
    expect(knowledge).not.toBeNull();
    expect(knowledge?.domain).toBe('example.com');
  });

  it('returns null for unknown domain', () => {
    const knowledge = store.getSiteKnowledge('unknown-domain-xyz.com');
    expect(knowledge).toBeNull();
  });

  it('records action outcomes and retrieves best selector', () => {
    store.recordSelectorOutcome('shop.com', 'add_to_cart', '#add-btn', true);
    store.recordSelectorOutcome('shop.com', 'add_to_cart', '#add-btn', true);
    store.recordSelectorOutcome('shop.com', 'add_to_cart', '.old-btn', false);

    const best = store.getBestSelector('shop.com', 'add_to_cart');
    expect(best).toBe('#add-btn');
  });

  it('stats returns correct counts', () => {
    const stats = store.getStats();
    expect(stats.domains).toBeGreaterThan(0);
    expect(typeof stats.sessions).toBe('number');
    expect(typeof stats.actions).toBe('number');
  });
});
