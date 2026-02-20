import type {
  SemanticPageModel,
  ActionResult,
  StateChange,
  AgentTask,
  TaskResult,
  ActionDefinition,
} from '../types.js';
import { BrowserEngine } from '../engine/browser.js';
import { SemanticAnalyzer } from '../semantic/analyzer.js';
import { SiteMemoryStore } from '../memory/store.js';
import { randomUUID } from 'crypto';

// ─────────────────────────────────────────────────────────────────────────────
// TaskExecutor — Self-healing task runtime with site learning
//
// Learning loop:
//   navigate → check cache → inject site context → analyze (LLM)
//   → execute action → record outcome → update site profile
//
// On repeat visits: faster (cache hit), cheaper (no LLM call), more accurate
// (LLM gets known selectors as context).
// ─────────────────────────────────────────────────────────────────────────────

export class TaskExecutor {
  private engine: BrowserEngine;
  private analyzer: SemanticAnalyzer;
  private memory: SiteMemoryStore;
  private pageModels: Map<string, SemanticPageModel> = new Map();

  constructor(
    engine: BrowserEngine,
    analyzer: SemanticAnalyzer,
    memory: SiteMemoryStore,
  ) {
    this.engine = engine;
    this.analyzer = analyzer;
    this.memory = memory;
  }

  // ─── Navigate + Analyze ───────────────────────────────────────────────────

  async navigate(sessionId: string, url: string): Promise<SemanticPageModel> {
    await this.engine.navigate(sessionId, url);
    return this.refreshModel(sessionId);
  }

  async getPageState(sessionId: string): Promise<SemanticPageModel> {
    return this.pageModels.get(sessionId) ?? this.refreshModel(sessionId);
  }

  async refreshModel(sessionId: string): Promise<SemanticPageModel> {
    const url = await this.engine.getCurrentUrl(sessionId);

    if (await this.engine.checkForCaptcha(sessionId)) {
      return this.buildCaptchaModel(url);
    }

    const domain = this.getDomain(url);

    // ── 1. Check page model cache ────────────────────────────────────────────
    const cached = this.memory.getCachedModel(url);
    if (cached) {
      this.pageModels.set(sessionId, cached);
      return cached;
    }

    // ── 2. Build site context from accumulated knowledge ─────────────────────
    const siteContext = this.memory.buildLLMContext(domain);

    // ── 3. Fetch page content ────────────────────────────────────────────────
    const html = await this.engine.getPageHTML(sessionId);
    const accessTree = await this.engine.getAccessibilityTree(sessionId);

    // ── 4. Analyze with LLM (enriched by site context on repeat visits) ──────
    const model = await this.analyzer.analyze(url, html, accessTree, siteContext);

    // ── 5. Learn from this visit ─────────────────────────────────────────────
    this.memory.incrementVisitCount(domain);
    this.memory.updateSiteProfile(domain, model.page_type);
    this.memory.cacheModel(url, model);

    this.pageModels.set(sessionId, model);
    return model;
  }

  // ─── Execute an action ────────────────────────────────────────────────────

  async executeAction(
    sessionId: string,
    actionName: string,
    params: Record<string, unknown>,
  ): Promise<ActionResult> {
    const model = await this.getPageState(sessionId);
    const action = model.available_actions.find((a) => a.name === actionName);

    if (!action) {
      return this.errorResult(
        `Action '${actionName}' not available. Available: ${model.available_actions.map((a) => a.name).join(', ')}`,
        model,
      );
    }

    const urlBefore = await this.engine.getCurrentUrl(sessionId);
    const domain = this.getDomain(urlBefore);

    try {
      await this.performAction(sessionId, action, params, domain);

      await new Promise((r) => setTimeout(r, 500));

      if (await this.engine.checkForCaptcha(sessionId)) {
        return this.errorResult('CAPTCHA appeared after action.', model);
      }

      const urlAfter = await this.engine.getCurrentUrl(sessionId);

      // Invalidate cache on navigation (page definitely changed)
      if (urlAfter !== urlBefore) {
        this.memory.invalidateCache(domain);
      }

      const newModel = await this.refreshModel(sessionId);

      // ── Learn: record successful selectors ─────────────────────────────────
      this.learnFromAction(domain, actionName, action, true);
      this.memory.updateSiteProfile(
        domain,
        newModel.page_type,
        `action '${actionName}' on ${model.page_type} leads to ${newModel.page_type}`,
      );

      return {
        success: true,
        state_change: this.buildStateChange(urlBefore, urlAfter, model, newModel),
        next_available_actions: newModel.available_actions.map((a) => a.name),
      };
    } catch (err) {
      this.learnFromAction(domain, actionName, action, false);

      return this.errorResult(
        `Action '${actionName}' failed: ${(err as Error).message}`,
        model,
      );
    }
  }

  // ─── Fill a form ──────────────────────────────────────────────────────────

  async fillForm(
    sessionId: string,
    formName: string,
    data: Record<string, string>,
  ): Promise<ActionResult> {
    const model = await this.getPageState(sessionId);
    const form = model.forms.find(
      (f) => f.name.toLowerCase() === formName.toLowerCase(),
    );

    if (!form) {
      return this.errorResult(
        `Form '${formName}' not found. Available: ${model.forms.map((f) => f.name).join(', ')}`,
        model,
      );
    }

    const urlBefore = await this.engine.getCurrentUrl(sessionId);
    const domain = this.getDomain(urlBefore);
    const errors: string[] = [];

    for (const [fieldName, value] of Object.entries(data)) {
      const field = form.fields.find(
        (f) =>
          f.name.toLowerCase() === fieldName.toLowerCase() ||
          f.label.toLowerCase() === fieldName.toLowerCase(),
      );

      if (!field) {
        errors.push(`Field '${fieldName}' not found`);
        continue;
      }

      const selector = field.selector ||
        this.memory.getBestSelector(domain, `fill_${fieldName}`);

      if (!selector) {
        errors.push(`No selector for '${fieldName}'`);
        continue;
      }

      try {
        await this.engine.fill(sessionId, selector, value);
        this.memory.recordSelectorOutcome(domain, `fill_${fieldName}`, selector, true);
      } catch {
        this.memory.recordSelectorOutcome(domain, `fill_${fieldName}`, selector, false);
        errors.push(`Could not fill '${fieldName}'`);
      }
    }

    const newModel = await this.refreshModel(sessionId);
    const urlAfter = await this.engine.getCurrentUrl(sessionId);

    return {
      success: errors.length === 0,
      state_change: this.buildStateChange(urlBefore, urlAfter, model, newModel),
      data: errors.length > 0 ? { errors } : undefined,
      next_available_actions: newModel.available_actions.map((a) => a.name),
    };
  }

  // ─── Extract structured data ──────────────────────────────────────────────

  async extract(
    sessionId: string,
    schema: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const model = await this.getPageState(sessionId);
    const result: Record<string, unknown> = {};

    for (const [key, description] of Object.entries(schema)) {
      // Search key_data by key similarity
      const found = Object.entries(model.key_data).find(
        ([k]) =>
          k.toLowerCase().includes(key.toLowerCase()) ||
          key.toLowerCase().includes(k.toLowerCase()),
      );

      if (found) {
        result[key] = found[1];
      } else {
        // Search in key_data values for the description match
        const byDesc = Object.entries(model.key_data).find(([k]) =>
          description.toLowerCase().split(' ').some((w) => w.length > 3 && k.toLowerCase().includes(w)),
        );
        result[key] = byDesc ? byDesc[1] : null;
      }
    }

    return result;
  }

  // ─── Parallel tasks ───────────────────────────────────────────────────────

  async runParallel(tasks: AgentTask[]): Promise<TaskResult[]> {
    return Promise.all(tasks.map((task) => this.runTask(task)));
  }

  async runTask(task: AgentTask): Promise<TaskResult> {
    const sessionId = await this.engine.createSession();
    try {
      const model = await this.navigate(sessionId, task.url);
      return {
        task_id: task.id ?? randomUUID(),
        success: true,
        output: { page_state: model, key_data: model.key_data },
        steps_taken: 1,
      };
    } catch (err) {
      return {
        task_id: task.id ?? randomUUID(),
        success: false,
        error: (err as Error).message,
        steps_taken: 0,
      };
    } finally {
      await this.engine.destroySession(sessionId);
    }
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private async performAction(
    sessionId: string,
    action: ActionDefinition,
    params: Record<string, unknown>,
    domain: string,
  ): Promise<void> {
    const internal = action._internal;

    // ── Strategy 1: Use LLM-provided internal selector ────────────────────
    if (internal) {
      if (internal.type === 'click' && internal.selector) {
        await this.engine.click(sessionId, internal.selector);
        return;
      }

      if ((internal.type === 'fill' || internal.type === 'form') && internal.field_map) {
        for (const [paramName, selector] of Object.entries(internal.field_map)) {
          const value = params[paramName];
          if (value !== undefined && selector) {
            await this.engine.fill(sessionId, selector, String(value));
          }
        }
        // Submit the form if submit_selector is available
        if (internal.submit_selector) {
          await this.engine.click(sessionId, internal.submit_selector);
          return;
        }
      }

      if (internal.type === 'navigate' && internal.selector) {
        const sel = internal.selector;
        // If selector is a real URL, use goto. Otherwise click the link element.
        if (sel.startsWith('http://') || sel.startsWith('https://')) {
          await this.engine.navigate(sessionId, sel);
        } else {
          await this.engine.click(sessionId, sel);
        }
        return;
      }
    }

    // ── Strategy 2: Use memory's best known selector ──────────────────────
    const remembered = this.memory.getBestSelector(domain, action.name);
    if (remembered) {
      await this.engine.click(sessionId, remembered);
      return;
    }

    throw new Error(
      `Cannot execute '${action.name}' — no selector available. ` +
      `This action needs to be executed at least once with explicit selectors to learn from.`,
    );
  }

  private learnFromAction(
    domain: string,
    actionName: string,
    action: ActionDefinition,
    success: boolean,
  ): void {
    const internal = action._internal;
    if (!internal) return;

    if (internal.selector) {
      this.memory.recordSelectorOutcome(domain, actionName, internal.selector, success);
    }

    if (internal.field_map) {
      for (const [paramName, selector] of Object.entries(internal.field_map)) {
        if (selector) {
          this.memory.recordSelectorOutcome(domain, `${actionName}.${paramName}`, selector, success);
        }
      }
    }

    if (internal.submit_selector) {
      this.memory.recordSelectorOutcome(domain, `${actionName}.submit`, internal.submit_selector, success);
    }
  }

  private buildStateChange(
    urlBefore: string,
    urlAfter: string,
    modelBefore: SemanticPageModel,
    modelAfter: SemanticPageModel,
  ): StateChange {
    const navigated = urlBefore !== urlAfter;
    const typeChanged = modelBefore.page_type !== modelAfter.page_type;

    return {
      navigated_to: navigated ? urlAfter : undefined,
      page_type_changed: typeChanged
        ? { from: modelBefore.page_type, to: modelAfter.page_type }
        : undefined,
      auth_state_changed:
        modelBefore.page_type === 'login' && modelAfter.page_type !== 'login',
      form_submitted: modelBefore.forms.length > 0 && navigated,
      summary: this.buildSummary(urlBefore, urlAfter, modelBefore, modelAfter),
    };
  }

  private buildSummary(
    urlBefore: string,
    urlAfter: string,
    before: SemanticPageModel,
    after: SemanticPageModel,
  ): string {
    if (urlBefore !== urlAfter) {
      return `Navigated from ${before.page_type} to ${after.page_type}. ${after.task_status}`;
    }
    if (before.page_type !== after.page_type) {
      return `Page changed from ${before.page_type} to ${after.page_type}`;
    }
    return `Action completed. Page: ${after.task_status}`;
  }

  private buildCaptchaModel(url: string): SemanticPageModel {
    return {
      url,
      page_type: 'captcha',
      title: 'CAPTCHA Challenge',
      task_status: 'blocked by CAPTCHA',
      key_data: {},
      available_actions: [],
      warnings: ['CAPTCHA detected — automated interaction blocked'],
      navigation: [],
      forms: [],
      timestamp: Date.now(),
    };
  }

  private errorResult(message: string, currentModel: SemanticPageModel): ActionResult {
    return {
      success: false,
      state_change: { summary: message },
      error: message,
      next_available_actions: currentModel.available_actions.map((a) => a.name),
    };
  }

  private getDomain(url: string): string {
    try { return new URL(url).hostname; }
    catch { return url; }
  }
}
