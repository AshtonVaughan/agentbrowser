// ─────────────────────────────────────────────────────────────────────────────
// AgentBrowser — Core Types
// The browser speaks the agent's language, not the DOM's language.
// ─────────────────────────────────────────────────────────────────────────────

/** What an agent receives instead of HTML — semantic, compressed, actionable */
export interface SemanticPageModel {
  url: string;
  page_type: PageType;
  title: string;
  task_status: string;
  key_data: Record<string, unknown>;
  available_actions: ActionDefinition[];
  warnings: string[];
  navigation: NavigationLink[];
  forms: FormDefinition[];
  timestamp: number;
}

export type PageType =
  | 'login'
  | 'signup'
  | 'dashboard'
  | 'search'
  | 'product'
  | 'checkout'
  | 'cart'
  | 'form'
  | 'article'
  | 'listing'
  | 'profile'
  | 'settings'
  | 'error'
  | 'captcha'
  | 'unknown';

export interface ActionDefinition {
  name: string;
  description: string;
  parameters: ParameterDefinition[];
  returns: string;
  /** Internal DOM selector or action hint — never exposed to agent */
  _internal?: ActionInternal;
}

export interface ParameterDefinition {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  required: boolean;
  example?: unknown;
}

export interface ActionInternal {
  type: 'click' | 'fill' | 'form' | 'select' | 'navigate' | 'scroll' | 'custom';
  selector?: string;
  field_map?: Record<string, string>; // param name → CSS selector
  submit_selector?: string;           // CSS selector for form submit button
}

export interface NavigationLink {
  label: string;
  url: string;
  type: 'primary' | 'secondary' | 'breadcrumb';
}

export interface FormDefinition {
  name: string;
  purpose: string;
  fields: FormField[];
  submit_action: string;
}

export interface FormField {
  name: string;
  label: string;
  type: string;
  required: boolean;
  placeholder?: string;
  selector: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Action results — what the agent gets back after calling a tool
// ─────────────────────────────────────────────────────────────────────────────

export interface ActionResult {
  success: boolean;
  /** What actually changed on the page — agent never needs to re-snapshot */
  state_change: StateChange;
  /** Structured data returned by the action (if applicable) */
  data?: unknown;
  /** Human-readable explanation if failed */
  error?: string;
  /** What the agent can do next */
  next_available_actions: string[];
}

export interface StateChange {
  navigated_to?: string;
  page_type_changed?: { from: PageType; to: PageType };
  elements_changed?: string[];
  form_submitted?: boolean;
  auth_state_changed?: boolean;
  summary: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tasks — what agents think in
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentTask {
  id: string;
  goal: string;
  url: string;
  context?: Record<string, unknown>;
  /** Expected output schema (Zod or JSON Schema) */
  output_schema?: Record<string, unknown>;
}

export interface TaskResult {
  task_id: string;
  success: boolean;
  output?: unknown;
  steps_taken: number;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Session — first-class persistent objects
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentSession {
  id: string;
  created_at: number;
  last_active: number;
  origin_url?: string;
  auth_domains: string[];
  /** Serialized Playwright storage state */
  storage_state?: PlaywrightStorageState;
  history: SessionHistoryEntry[];
  /** Branch source if this session was forked */
  branched_from?: string;
}

export interface SessionHistoryEntry {
  timestamp: number;
  action: string;
  url: string;
  result_summary: string;
}

export interface PlaywrightStorageState {
  cookies: unknown[];
  origins: unknown[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Site Memory — accumulated knowledge graph per domain
// ─────────────────────────────────────────────────────────────────────────────

export interface SiteKnowledge {
  domain: string;
  last_updated: number;
  visit_count: number;
  known_page_types: Record<string, PageKnowledge>;
  auth_flow?: AuthFlowKnowledge;
}

export interface PageKnowledge {
  url_pattern: string;
  page_type: PageType;
  reliable_selectors: Record<string, string>; // action → selector
  known_forms: Record<string, FormKnowledge>;
  success_count: number;
}

export interface FormKnowledge {
  field_selectors: Record<string, string>;
  submit_selector: string;
  success_indicator: string;
}

export interface AuthFlowKnowledge {
  login_url: string;
  steps: AuthStep[];
  session_indicator_selector: string;
}

export interface AuthStep {
  page_type: PageType;
  action: string;
  field_map: Record<string, string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentBrowserConfig {
  /** Anthropic API key for semantic analysis */
  anthropic_api_key: string;
  /** Path to SQLite DB for site memory */
  memory_db_path?: string;
  /** Playwright launch options */
  headless?: boolean;
  /** Max tokens for semantic analysis (default: 1024) */
  semantic_max_tokens?: number;
  /** Enable stealth mode (anti-bot) */
  stealth?: boolean;
  /** MCP server port (default: 3100) */
  mcp_port?: number;
}
