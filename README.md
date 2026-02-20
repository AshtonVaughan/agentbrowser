# AgentBrowser

**A browser runtime built for AI agents. Not humans.**

Every existing browser automation tool — Playwright, Puppeteer, Selenium, browser-use — was built for humans first and retrofitted for agents. They speak in DOM operations. Agents think in tasks.

AgentBrowser inverts this. The browser speaks the agent's language.

---

## The Core Difference

**Every other tool:**
```typescript
// Agent receives 8,000 tokens of HTML noise
// Agent guesses what "#submit-btn-v2" means
// Agent issues a DOM command and hopes
await page.click('#submit-btn-v2')
await page.fill('input[name="email"]', email)
```

**AgentBrowser:**
```typescript
// Agent receives 50 tokens of structured meaning
// Agent sees exactly what it can do
// Agent calls a semantic action
const state = await browser.navigate('https://example.com/login')
// state.page_type        → 'login'
// state.available_actions → ['authenticate', 'signup', 'forgot_password']
// state.key_data         → { site: 'Example', sso_available: true }

await browser.action('authenticate', { email, password })
// result.state_change.summary → 'Navigated from login to dashboard'
// result.next_available_actions → ['view_profile', 'settings', 'logout']
```

---

## Features

**Semantic observation** — Agents never see HTML. Every page navigation returns a structured model: what type of page it is, what data it contains, what actions are available. Token cost drops ~95%.

**Dynamic tool registry** — The available tools change as the page changes. On a login page, `authenticate()` appears. On a checkout page, `submit_order()` appears. The agent always sees exactly what it can do — nothing more.

**Site memory** — The browser learns permanently. First visit to a site: full LLM analysis. Second visit: cache hit, 7x faster, zero LLM cost. Tenth visit: the LLM gets injected context of proven selectors and known page flows, producing more accurate results from the start.

**Self-healing execution** — CAPTCHA detection, stale selector recovery, and post-action state verification are handled silently. Agents see task outcomes, not infrastructure failures.

**Session persistence** — Sessions are first-class objects. Save, restore, and branch browser state across agent runs. Auth state survives restarts.

**MCP server** — Ships as a Model Context Protocol server. Any MCP-compatible agent (Claude Code, LangChain, AutoGen, custom) connects without integration work.

**Parallel tasks** — Declare goals, not tabs. The runtime manages contexts, isolation, and result aggregation.

---

## Installation

```bash
git clone https://github.com/AshtonVaughan/agentbrowser
cd agentbrowser
npm install
npx playwright install chromium
npm run build
```

Set your Anthropic API key:
```bash
cp .env.example .env
# Edit .env and set ANTHROPIC_API_KEY
```

---

## Usage

### As a library

```typescript
import { AgentBrowser } from './src/index.js'

const browser = new AgentBrowser({
  anthropic_api_key: process.env.ANTHROPIC_API_KEY,
  headless: true,
  stealth: true,
})

await browser.launch()

// Navigate — returns semantic model, not HTML
const state = await browser.navigate('https://news.ycombinator.com')
console.log(state.page_type)          // 'listing'
console.log(state.available_actions)  // ['read_story', 'submit', 'login', ...]
console.log(state.key_data)           // { story_count: 30, top_story: '...' }

// Execute actions by name
await browser.action('read_story', { rank: 1 })

// Extract structured data
const data = await browser.extract({
  top_story: 'title of the #1 story',
  points: 'upvote count of top story',
  author: 'username of top story submitter',
})

// Save session (auth state, cookies)
await browser.saveSession('hn-logged-in')

// Restore later
await browser.restoreSession('hn-logged-in')

await browser.close()
```

### As an MCP server

Add to your Claude Code config (`~/.claude.json`):

```json
{
  "mcpServers": {
    "agentbrowser": {
      "command": "node",
      "args": ["/path/to/agentbrowser/dist/server/mcp.js"],
      "env": {
        "ANTHROPIC_API_KEY": "your-key-here",
        "AGENTBROWSER_HEADLESS": "true",
        "AGENTBROWSER_STEALTH": "true"
      }
    }
  }
}
```

Then in any conversation, Claude has access to:

| Tool | Description |
|------|-------------|
| `navigate` | Go to a URL, get semantic page state |
| `get_page_state` | Current page type, data, available actions |
| `page__<action>` | Dynamic tools generated from current page |
| `extract` | Pull structured data via schema |
| `fill_form` | Fill a named form by field labels |
| `start_session` | Begin a new browser session |
| `save_session` | Persist cookies and auth state |
| `restore_session` | Resume a saved session |
| `run_parallel` | Execute multiple tasks simultaneously |
| `get_memory_stats` | View accumulated site knowledge |

---

## How the Learning Works

```
First visit to stripe.com/login
  → Full LLM analysis (3-4 seconds)
  → Stores: page model, page type, selectors

Second visit (within 30 min)
  → Cache hit (< 500ms, zero LLM cost)

Third visit (cache expired)
  → LLM gets injected context:
      "This domain has been visited 8 times.
       Known page types: login, dashboard, billing, settings
       Proven selectors:
         authenticate.email:    input[id='email']
         authenticate.password: input[type='password']
         authenticate.submit:   button[data-qa='submit']"
  → More accurate output, correct selectors from the start

After each successful action
  → Winning selector saved to selector library
  → Site profile updated with transition knowledge
  → Cache invalidated on navigation
```

The browser gets permanently smarter about each site. Knowledge compounds across sessions and agents.

---

## Architecture

```
Agent
  │
  │  semantic intent (not DOM commands)
  ▼
┌─────────────────────────────────────┐
│           Task Runtime              │  ← self-healing, parallel, recovery
│  ┌───────────────────────────────┐  │
│  │      Site Memory Store        │  │  ← SQLite: cache, selectors, profiles
│  └───────────────────────────────┘  │
│  ┌───────────────────────────────┐  │
│  │      Semantic Analyzer        │  │  ← Claude Haiku: page → structured model
│  └───────────────────────────────┘  │
│  ┌───────────────────────────────┐  │
│  │       Browser Engine          │  │  ← Playwright: stealth Chromium
│  └───────────────────────────────┘  │
└─────────────────────────────────────┘
  │
  │  HTTP
  ▼
 Web
```

| Component | File | Role |
|-----------|------|------|
| Types | `src/types.ts` | `SemanticPageModel`, `ActionDefinition`, `AgentSession` |
| Browser Engine | `src/engine/browser.ts` | Playwright wrapper, stealth, sessions |
| Semantic Analyzer | `src/semantic/analyzer.ts` | LLM page analysis with site context injection |
| Site Memory | `src/memory/store.ts` | SQLite: page cache, selector library, site profiles |
| Task Executor | `src/runtime/executor.ts` | Self-healing execution, learning feedback loop |
| MCP Server | `src/server/mcp.ts` | Dynamic tool registry over MCP protocol |
| Public API | `src/index.ts` | `AgentBrowser` convenience class |

---

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `anthropic_api_key` | required | Anthropic API key for semantic analysis |
| `headless` | `true` | Run browser headlessly |
| `stealth` | `true` | Enable anti-bot detection bypass |
| `memory_db_path` | `~/.agentbrowser/memory.db` | SQLite database path |
| `semantic_max_tokens` | `2048` | Max tokens for page analysis |
| `mcp_port` | `3100` | MCP server port |

---

## Why Not Just Use Playwright?

Playwright is exceptional at what it does. But it was built to automate what humans do manually — and it shows. Agents using Playwright must:

- Parse thousands of tokens of HTML noise to find the one thing they care about
- Re-learn every site from scratch on every session
- Translate between intent ("log in") and DOM operations ("find input, fill, click") on every action
- Handle CAPTCHA, popups, and stale selectors themselves
- Manage tab state manually for parallel work

AgentBrowser is not a wrapper around Playwright. It's a different abstraction layer — one where the browser's mental model matches the agent's mental model from the ground up.

---

## License

MIT
