import Database from 'better-sqlite3';
import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync } from 'fs';
import type { SiteKnowledge, AgentSession, SemanticPageModel } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// SiteMemoryStore — The browser's long-term memory
//
// Three learning mechanisms:
// 1. Page model cache — skip LLM on repeat visits to identical pages
// 2. Selector library — remember which CSS selectors reliably work per action
// 3. Site profiles — accumulated knowledge injected back into LLM prompts
//
// This is what makes the browser permanently smarter about sites over time.
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 1000 * 60 * 30; // 30 minutes — pages don't change that fast

export class SiteMemoryStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const path = dbPath ?? this.defaultPath();
    mkdirSync(join(path, '..'), { recursive: true });
    this.db = new Database(path);
    this.init();
  }

  private defaultPath(): string {
    return join(homedir(), '.agentbrowser', 'memory.db');
  }

  private init(): void {
    this.db.exec(`
      -- Per-domain accumulated knowledge
      CREATE TABLE IF NOT EXISTS site_knowledge (
        domain        TEXT PRIMARY KEY,
        data          TEXT NOT NULL,
        last_updated  INTEGER NOT NULL,
        visit_count   INTEGER NOT NULL DEFAULT 0
      );

      -- Cached semantic page models (skip LLM on repeat visits)
      CREATE TABLE IF NOT EXISTS page_model_cache (
        url_pattern   TEXT PRIMARY KEY,
        domain        TEXT NOT NULL,
        model_json    TEXT NOT NULL,
        hit_count     INTEGER NOT NULL DEFAULT 0,
        last_updated  INTEGER NOT NULL
      );

      -- Selector success/failure tracking
      CREATE TABLE IF NOT EXISTS selector_library (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        domain        TEXT NOT NULL,
        action_name   TEXT NOT NULL,
        selector      TEXT NOT NULL,
        success_count INTEGER NOT NULL DEFAULT 0,
        fail_count    INTEGER NOT NULL DEFAULT 0,
        last_used     INTEGER NOT NULL,
        UNIQUE(domain, action_name, selector)
      );

      -- Per-domain profiles for LLM context injection
      CREATE TABLE IF NOT EXISTS site_profiles (
        domain        TEXT PRIMARY KEY,
        page_types    TEXT NOT NULL DEFAULT '[]',
        auth_info     TEXT,
        notes         TEXT NOT NULL DEFAULT '[]',
        last_updated  INTEGER NOT NULL
      );

      -- Sessions
      CREATE TABLE IF NOT EXISTS sessions (
        id          TEXT PRIMARY KEY,
        data        TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        last_active INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_selector_domain ON selector_library(domain, action_name);
      CREATE INDEX IF NOT EXISTS idx_cache_domain ON page_model_cache(domain);
    `);
  }

  // ─── Page Model Cache ──────────────────────────────────────────────────────

  getCachedModel(url: string): SemanticPageModel | null {
    const pattern = this.normalizeUrl(url);
    const row = this.db
      .prepare('SELECT model_json, last_updated FROM page_model_cache WHERE url_pattern = ?')
      .get(pattern) as { model_json: string; last_updated: number } | undefined;

    if (!row) return null;

    // Expired
    if (Date.now() - row.last_updated > CACHE_TTL_MS) return null;

    // Increment hit count
    this.db
      .prepare('UPDATE page_model_cache SET hit_count = hit_count + 1 WHERE url_pattern = ?')
      .run(pattern);

    return JSON.parse(row.model_json) as SemanticPageModel;
  }

  cacheModel(url: string, model: SemanticPageModel): void {
    const pattern = this.normalizeUrl(url);
    const domain = this.getDomain(url);

    this.db
      .prepare(`
        INSERT INTO page_model_cache (url_pattern, domain, model_json, last_updated)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(url_pattern) DO UPDATE SET
          model_json   = excluded.model_json,
          last_updated = excluded.last_updated
      `)
      .run(pattern, domain, JSON.stringify(model), Date.now());
  }

  invalidateCache(domain: string): void {
    this.db
      .prepare('DELETE FROM page_model_cache WHERE domain = ?')
      .run(domain);
  }

  // ─── Selector Library ──────────────────────────────────────────────────────

  recordSelectorOutcome(
    domain: string,
    actionName: string,
    selector: string,
    success: boolean,
  ): void {
    if (!selector) return;

    this.db
      .prepare(`
        INSERT INTO selector_library (domain, action_name, selector, success_count, fail_count, last_used)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(domain, action_name, selector) DO UPDATE SET
          success_count = success_count + ?,
          fail_count    = fail_count + ?,
          last_used     = ?
      `)
      .run(
        domain, actionName, selector,
        success ? 1 : 0, success ? 0 : 1, Date.now(),
        success ? 1 : 0, success ? 0 : 1, Date.now(),
      );
  }

  getBestSelector(domain: string, actionName: string): string | null {
    const row = this.db
      .prepare(`
        SELECT selector,
               CAST(success_count AS REAL) / (success_count + fail_count) AS rate,
               success_count + fail_count AS attempts
        FROM selector_library
        WHERE domain = ? AND action_name = ? AND success_count + fail_count >= 2
        ORDER BY rate DESC, attempts DESC
        LIMIT 1
      `)
      .get(domain, actionName) as { selector: string; rate: number } | undefined;

    if (!row || row.rate < 0.5) return null;
    return row.selector;
  }

  getKnownSelectors(domain: string): Record<string, string> {
    // Return best selector per action for this domain
    const rows = this.db
      .prepare(`
        SELECT action_name,
               selector,
               CAST(success_count AS REAL) / (success_count + fail_count) AS rate
        FROM selector_library
        WHERE domain = ? AND success_count + fail_count >= 2
        GROUP BY action_name
        HAVING rate >= 0.5
        ORDER BY action_name, rate DESC
      `)
      .all(domain) as { action_name: string; selector: string; rate: number }[];

    const result: Record<string, string> = {};
    const seen = new Set<string>();
    for (const row of rows) {
      if (!seen.has(row.action_name)) {
        result[row.action_name] = row.selector;
        seen.add(row.action_name);
      }
    }
    return result;
  }

  // ─── Site Profile ──────────────────────────────────────────────────────────

  updateSiteProfile(domain: string, pageType: string, note?: string): void {
    const existing = this.db
      .prepare('SELECT page_types, notes FROM site_profiles WHERE domain = ?')
      .get(domain) as { page_types: string; notes: string } | undefined;

    const pageTypes: string[] = existing ? JSON.parse(existing.page_types) : [];
    const notes: string[] = existing ? JSON.parse(existing.notes) : [];

    if (!pageTypes.includes(pageType)) pageTypes.push(pageType);
    if (note && !notes.includes(note)) {
      notes.push(note);
      // Keep last 20 notes
      if (notes.length > 20) notes.shift();
    }

    this.db
      .prepare(`
        INSERT INTO site_profiles (domain, page_types, notes, last_updated)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(domain) DO UPDATE SET
          page_types   = excluded.page_types,
          notes        = excluded.notes,
          last_updated = excluded.last_updated
      `)
      .run(domain, JSON.stringify(pageTypes), JSON.stringify(notes), Date.now());
  }

  // ─── LLM Context Builder ───────────────────────────────────────────────────
  // This is the key method — builds the context string injected into the
  // LLM prompt for known sites. Makes analysis more accurate over time.

  buildLLMContext(domain: string): string | undefined {
    const profile = this.db
      .prepare('SELECT page_types, notes FROM site_profiles WHERE domain = ?')
      .get(domain) as { page_types: string; notes: string } | undefined;

    const knowledge = this.getSiteKnowledge(domain);
    const knownSelectors = this.getKnownSelectors(domain);
    const visitCount = knowledge?.visit_count ?? 0;

    if (!profile && visitCount === 0 && Object.keys(knownSelectors).length === 0) {
      return undefined; // No knowledge yet
    }

    const lines: string[] = [];

    if (visitCount > 0) {
      lines.push(`This domain has been visited ${visitCount} times.`);
    }

    if (profile) {
      const pageTypes: string[] = JSON.parse(profile.page_types);
      if (pageTypes.length > 0) {
        lines.push(`Known page types on this domain: ${pageTypes.join(', ')}`);
      }

      const notes: string[] = JSON.parse(profile.notes);
      if (notes.length > 0) {
        lines.push(`Site notes: ${notes.join('; ')}`);
      }
    }

    if (Object.keys(knownSelectors).length > 0) {
      lines.push('Proven CSS selectors for this domain (use these for _internal fields):');
      for (const [action, selector] of Object.entries(knownSelectors)) {
        lines.push(`  - ${action}: ${selector}`);
      }
    }

    return lines.length > 0 ? lines.join('\n') : undefined;
  }

  // ─── Site Knowledge (legacy, kept for compatibility) ───────────────────────

  getSiteKnowledge(domain: string): SiteKnowledge | null {
    const row = this.db
      .prepare('SELECT data FROM site_knowledge WHERE domain = ?')
      .get(domain) as { data: string } | undefined;

    if (!row) return null;
    return JSON.parse(row.data) as SiteKnowledge;
  }

  saveSiteKnowledge(knowledge: SiteKnowledge): void {
    this.db
      .prepare(`
        INSERT INTO site_knowledge (domain, data, last_updated, visit_count)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(domain) DO UPDATE SET
          data         = excluded.data,
          last_updated = excluded.last_updated,
          visit_count  = visit_count + 1
      `)
      .run(knowledge.domain, JSON.stringify(knowledge), Date.now(), knowledge.visit_count);
  }

  incrementVisitCount(domain: string): void {
    this.db
      .prepare(`
        INSERT INTO site_knowledge (domain, data, last_updated, visit_count)
        VALUES (?, '{}', ?, 1)
        ON CONFLICT(domain) DO UPDATE SET
          visit_count  = visit_count + 1,
          last_updated = excluded.last_updated
      `)
      .run(domain, Date.now());
  }

  // ─── Sessions ──────────────────────────────────────────────────────────────

  saveSession(session: AgentSession): void {
    this.db
      .prepare(`
        INSERT INTO sessions (id, data, created_at, last_active)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          data        = excluded.data,
          last_active = excluded.last_active
      `)
      .run(session.id, JSON.stringify(session), session.created_at, session.last_active);
  }

  getSession(id: string): AgentSession | null {
    const row = this.db
      .prepare('SELECT data FROM sessions WHERE id = ?')
      .get(id) as { data: string } | undefined;

    if (!row) return null;
    return JSON.parse(row.data) as AgentSession;
  }

  listSessions(): AgentSession[] {
    const rows = this.db
      .prepare('SELECT data FROM sessions ORDER BY last_active DESC')
      .all() as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as AgentSession);
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  // ─── Stats ─────────────────────────────────────────────────────────────────

  getStats(): {
    domains: number;
    sessions: number;
    actions: number;
    cached_pages: number;
    known_selectors: number;
  } {
    const get = (sql: string) =>
      (this.db.prepare(sql).get() as { n: number }).n;

    return {
      domains: get('SELECT COUNT(*) as n FROM site_knowledge'),
      sessions: get('SELECT COUNT(*) as n FROM sessions'),
      actions: get('SELECT COUNT(*) as n FROM selector_library'),
      cached_pages: get('SELECT COUNT(*) as n FROM page_model_cache'),
      known_selectors: get(
        'SELECT COUNT(*) as n FROM selector_library WHERE success_count + fail_count >= 2',
      ),
    };
  }

  // ─── Utilities ─────────────────────────────────────────────────────────────

  private normalizeUrl(url: string): string {
    try {
      const u = new URL(url);
      // Normalize: remove query params that are session-specific
      const path = u.pathname.replace(/\/$/, '') || '/';
      return `${u.hostname}${path}`;
    } catch {
      return url;
    }
  }

  private getDomain(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }

  close(): void {
    this.db.close();
  }
}
