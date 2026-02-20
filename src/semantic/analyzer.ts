import Anthropic from '@anthropic-ai/sdk';
import type {
  SemanticPageModel,
  PageType,
  ActionDefinition,
  AgentBrowserConfig,
} from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// SemanticAnalyzer — Turns raw DOM into a semantic page model
//
// Token cost of raw HTML:     ~2000-8000 tokens
// Token cost of semantic model: ~50-200 tokens
//
// When site context is available (repeat visit), the LLM gets enriched
// knowledge: known selectors, page types, auth flows. This makes the output
// more accurate and reduces selector guessing on known sites.
// ─────────────────────────────────────────────────────────────────────────────

const buildPrompt = (siteContext?: string) => `You are analyzing a web page for an AI agent. Convert the page into a structured semantic model.

${siteContext ? `KNOWN SITE CONTEXT (use this to improve accuracy):\n${siteContext}\n` : ''}

Return ONLY valid JSON with this exact structure:
{
  "page_type": "<one of: login|signup|dashboard|search|product|checkout|cart|form|article|listing|profile|settings|error|captcha|unknown>",
  "task_status": "<brief status, e.g. 'ready to checkout', 'awaiting login', 'showing 42 results'>",
  "key_data": { <most important data on the page as key-value pairs, max 10 items> },
  "available_actions": [
    {
      "name": "<snake_case action name>",
      "description": "<what this action does>",
      "parameters": [
        { "name": "<param>", "type": "<string|number|boolean>", "description": "<what it is>", "required": true }
      ],
      "returns": "<what the agent gets back>",
      "_internal": {
        "type": "<click|fill|form|navigate>",
        "selector": "<CSS selector for click actions>",
        "field_map": { "<param_name>": "<CSS selector for that field>" },
        "submit_selector": "<CSS selector for submit button, for form actions>"
      }
    }
  ],
  "warnings": ["<any warnings: session expiry, rate limits, CAPTCHA risk, etc>"],
  "navigation": [
    { "label": "<link text>", "url": "<href value>", "type": "<primary|secondary|breadcrumb>" }
  ],
  "forms": [
    {
      "name": "<form name>",
      "purpose": "<what it does>",
      "fields": [
        { "name": "<field name>", "label": "<visible label>", "type": "<input type>", "required": true, "selector": "<CSS selector>" }
      ],
      "submit_action": "<name of action that submits this form>"
    }
  ]
}

CRITICAL RULES:
- _internal MUST have real CSS selectors from the actual page HTML.
- SELECTOR PRIORITY (use highest available): id (#id) > name (input[name=x]) > aria-label ([aria-label=x]) > href (a[href='/path']) > type+placeholder > class combinations
- NEVER use :contains() — it is jQuery-only and will break execution. Use :has-text() or attribute selectors instead.
- For links/navigation: ALWAYS use a[href='value'] with the ACTUAL href from the HTML (e.g. a[href='newest'], a[href='/ask'], a[href='https://...']). NEVER use [text=...].
- For buttons: prefer button[type=submit], button[name=x], or button[aria-label=x]
- For inputs: prefer input[name=x], input[type=x], input[id=x], input[placeholder=x]
- For form actions (login, signup, fill): use type="form", populate field_map AND submit_selector
- For button/link clicks: use type="click", populate selector
- For navigation (links that take you to a new page): use type="navigate", selector = a[href='actualHref'] from the HTML
- available_actions should only include things actually possible on this page
- key_data should contain prices, counts, names, statuses — whatever is most decision-relevant
- Keep all text values concise`;

export class SemanticAnalyzer {
  private client: Anthropic;
  private maxTokens: number;

  constructor(config: AgentBrowserConfig) {
    this.client = new Anthropic({ apiKey: config.anthropic_api_key });
    this.maxTokens = config.semantic_max_tokens ?? 2048;
  }

  async analyze(
    url: string,
    html: string,
    accessibilityTree: string,
    siteContext?: string,
  ): Promise<SemanticPageModel> {
    const input = this.prepareInput(html, accessibilityTree);

    const response = await this.client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: this.maxTokens,
      messages: [
        {
          role: 'user',
          content: `${buildPrompt(siteContext)}\n\nPage URL: ${url}\n\nPage content:\n${input}`,
        },
      ],
    });

    const content = response.content[0];
    if (content?.type !== 'text') return this.fallbackModel(url);

    try {
      const parsed = JSON.parse(this.extractJSON(content.text));
      return this.buildModel(url, parsed);
    } catch {
      return this.fallbackModel(url);
    }
  }

  /** Quick re-analysis after an action — only what changed */
  async analyzeChanges(
    url: string,
    previousModel: SemanticPageModel,
    html: string,
    siteContext?: string,
  ): Promise<SemanticPageModel> {
    if (url !== previousModel.url) {
      return this.analyze(url, html, '', siteContext);
    }

    const prompt = `The following page was just updated after an agent action.
Previous page type: ${previousModel.page_type}
Previous status: ${previousModel.task_status}
${siteContext ? `\nKnown site context:\n${siteContext}` : ''}

New page HTML (truncated): ${html.slice(0, 4000)}

What changed? Return the same JSON structure as before but updated. Include real CSS selectors in _internal fields.`;

    const response = await this.client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: this.maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });

    const content = response.content[0];
    if (content?.type !== 'text') return previousModel;

    try {
      const parsed = JSON.parse(this.extractJSON(content.text));
      return this.buildModel(url, parsed);
    } catch {
      return previousModel;
    }
  }

  // ─── Utilities ─────────────────────────────────────────────────────────────

  private prepareInput(html: string, accessibilityTree: string): string {
    // Prefer accessibility tree — structured and much smaller than raw HTML
    if (accessibilityTree && accessibilityTree.length > 50) {
      // Include both: a11y tree for semantics, minimal HTML for selectors
      const stripped = this.stripHTML(html).slice(0, 3000);
      return `Accessibility tree:\n${accessibilityTree.slice(0, 5000)}\n\nHTML snippet (for selector extraction):\n${stripped}`;
    }
    return `HTML:\n${this.stripHTML(html).slice(0, 8000)}`;
  }

  private stripHTML(html: string): string {
    return html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      // Remove modal/overlay elements before LLM analysis so they don't mislead classification
      .replace(/<[^>]+(class|id)="[^"]*(?:modal|overlay|consent|gdpr|cookie|signup-wall|join-now)[^"]*"[^>]*>[\s\S]*?<\/[a-z]+>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private extractJSON(text: string): string {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (match) return match[1]!;
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) return text.slice(start, end + 1);
    return text;
  }

  private buildModel(url: string, parsed: Record<string, unknown>): SemanticPageModel {
    return {
      url,
      page_type: (parsed.page_type as PageType) ?? 'unknown',
      title: (parsed.title as string) ?? '',
      task_status: (parsed.task_status as string) ?? '',
      key_data: (parsed.key_data as Record<string, unknown>) ?? {},
      available_actions: (parsed.available_actions as ActionDefinition[]) ?? [],
      warnings: (parsed.warnings as string[]) ?? [],
      navigation: (parsed.navigation as SemanticPageModel['navigation']) ?? [],
      forms: (parsed.forms as SemanticPageModel['forms']) ?? [],
      timestamp: Date.now(),
    };
  }

  private fallbackModel(url: string): SemanticPageModel {
    return {
      url,
      page_type: 'unknown',
      title: '',
      task_status: 'page loaded, analysis failed',
      key_data: {},
      available_actions: [
        {
          name: 'extract_raw',
          description: 'Extract raw text content from the page',
          parameters: [],
          returns: 'Raw text content of the page',
        },
      ],
      warnings: ['semantic analysis failed — falling back to raw extraction'],
      navigation: [],
      forms: [],
      timestamp: Date.now(),
    };
  }
}
