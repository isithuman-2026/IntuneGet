/**
 * SQLite Database Implementation for Self-Hosted Mode
 * Provides a simple, zero-dependency database for true self-hosting
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type { DatabaseAdapter, PackagingJob, UploadHistoryRecord } from './types';
import type { WebhookConfiguration, WebhookConfigurationInput, WebhookConfigurationUpdate } from '@/types/notifications';
import type { ClaimedApp } from '@/types/unmanaged';

// Singleton database instance
let db: Database.Database | null = null;

/**
 * Get or create the SQLite database instance
 */
function getDb(): Database.Database {
  if (db) return db;

  const dbPath = process.env.DATABASE_PATH || './data/intuneget.db';
  const dbDir = path.dirname(dbPath);

  // Ensure the data directory exists
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = new Database(dbPath);

  // Enable WAL mode for better concurrent access
  db.pragma('journal_mode = WAL');

  // Initialize schema
  initializeSchema(db);

  return db;
}

/**
 * Initialize the database schema
 */
function initializeSchema(db: Database.Database): void {
  // Create packaging_jobs table
  db.exec(`
    CREATE TABLE IF NOT EXISTS packaging_jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      user_email TEXT,
      tenant_id TEXT,
      winget_id TEXT NOT NULL,
      version TEXT NOT NULL,
      display_name TEXT NOT NULL,
      publisher TEXT,
      architecture TEXT,
      installer_type TEXT NOT NULL,
      installer_url TEXT NOT NULL,
      installer_sha256 TEXT,
      install_command TEXT,
      uninstall_command TEXT,
      install_scope TEXT,
      silent_switches TEXT,
      detection_rules TEXT,
      package_config TEXT,
      github_run_id TEXT,
      github_run_url TEXT,
      intunewin_url TEXT,
      intunewin_size_bytes INTEGER,
      unencrypted_content_size INTEGER,
      encryption_info TEXT,
      intune_app_id TEXT,
      intune_app_url TEXT,
      app_source TEXT DEFAULT 'win32',
      status TEXT NOT NULL DEFAULT 'queued',
      status_message TEXT,
      progress_percent INTEGER DEFAULT 0,
      progress_message TEXT,
      error_message TEXT,
      error_stage TEXT,
      error_category TEXT,
      error_code TEXT,
      error_details TEXT,
      warnings TEXT,
      execution_profile_sha256 TEXT,
      presentation_profile_sha256 TEXT,
      qa_candidate_id TEXT,
      qa_requested_at TEXT,
      qa_completed_at TEXT,
      packager_id TEXT,
      packager_heartbeat_at TEXT,
      claimed_at TEXT,
      packaging_started_at TEXT,
      packaging_completed_at TEXT,
      upload_started_at TEXT,
      completed_at TEXT,
      cancelled_at TEXT,
      cancelled_by TEXT,
      archived_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const existingColumns = new Set(
    (db.pragma('table_info(packaging_jobs)') as Array<{ name: string }>).map((column) => column.name),
  );
  const compatibleColumns: Record<string, string> = {
    app_source: "TEXT DEFAULT 'win32'",
    error_stage: 'TEXT',
    error_category: 'TEXT',
    error_code: 'TEXT',
    error_details: 'TEXT',
    warnings: 'TEXT',
    archived_at: 'TEXT',
    execution_profile_sha256: 'TEXT',
    presentation_profile_sha256: 'TEXT',
    qa_candidate_id: 'TEXT',
    qa_requested_at: 'TEXT',
    qa_completed_at: 'TEXT',
  };
  for (const [column, definition] of Object.entries(compatibleColumns)) {
    if (!existingColumns.has(column)) {
      db.exec(`ALTER TABLE packaging_jobs ADD COLUMN ${column} ${definition}`);
    }
  }

  // Create index for status queries
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_packaging_jobs_status ON packaging_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_packaging_jobs_user_id ON packaging_jobs(user_id);
    CREATE INDEX IF NOT EXISTS idx_packaging_jobs_created_at ON packaging_jobs(created_at);
    CREATE INDEX IF NOT EXISTS idx_packaging_jobs_packager_heartbeat ON packaging_jobs(packager_heartbeat_at);
  `);

  // Create upload_history table
  db.exec(`
    CREATE TABLE IF NOT EXISTS upload_history (
      id TEXT PRIMARY KEY,
      packaging_job_id TEXT,
      user_id TEXT NOT NULL,
      winget_id TEXT NOT NULL,
      version TEXT NOT NULL,
      display_name TEXT NOT NULL,
      publisher TEXT,
      intune_app_id TEXT NOT NULL,
      intune_app_url TEXT,
      intune_tenant_id TEXT,
      deployed_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (packaging_job_id) REFERENCES packaging_jobs(id)
    )
  `);

  // Create index for upload_history
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_upload_history_user_id ON upload_history(user_id);
    CREATE INDEX IF NOT EXISTS idx_upload_history_deployed_at ON upload_history(deployed_at);
  `);

  // Create webhook_configurations table
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_configurations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      webhook_type TEXT NOT NULL,
      secret TEXT,
      headers TEXT,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      failure_count INTEGER NOT NULL DEFAULT 0,
      last_failure_at TEXT,
      last_success_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_webhook_configurations_user_id ON webhook_configurations(user_id);
  `);

  // Create claimed_apps table. No user_profiles FK here - that table is
  // Supabase-only plumbing SQLite mode has no equivalent for.
  db.exec(`
    CREATE TABLE IF NOT EXISTS claimed_apps (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      discovered_app_id TEXT NOT NULL,
      discovered_app_name TEXT NOT NULL,
      winget_package_id TEXT,
      intune_app_id TEXT,
      device_count_at_claim INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      claimed_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_claimed_apps_tenant_id ON claimed_apps(tenant_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_claimed_apps_tenant_discovered ON claimed_apps(tenant_id, discovered_app_id);
  `);

  // Create update_check_results table
  db.exec(`
    CREATE TABLE IF NOT EXISTS update_check_results (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      winget_id TEXT NOT NULL,
      intune_app_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      current_version TEXT NOT NULL,
      latest_version TEXT NOT NULL,
      is_critical INTEGER NOT NULL DEFAULT 0,
      is_managed INTEGER NOT NULL DEFAULT 1,
      notified_at TEXT,
      dismissed_at TEXT,
      detected_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, tenant_id, winget_id, intune_app_id)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_update_check_results_user ON update_check_results(user_id, tenant_id);
  `);

  // Create app_update_policies table
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_update_policies (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      winget_id TEXT NOT NULL,
      policy_type TEXT NOT NULL DEFAULT 'notify',
      pinned_version TEXT,
      deployment_config TEXT,
      original_upload_history_id TEXT,
      delay_days INTEGER NOT NULL DEFAULT 0,
      last_auto_update_at TEXT,
      last_auto_update_version TEXT,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, tenant_id, winget_id)
    )
  `);

  // Create auto_update_history table
  db.exec(`
    CREATE TABLE IF NOT EXISTS auto_update_history (
      id TEXT PRIMARY KEY,
      policy_id TEXT NOT NULL,
      packaging_job_id TEXT,
      from_version TEXT NOT NULL,
      to_version TEXT NOT NULL,
      update_type TEXT NOT NULL,
      status TEXT NOT NULL,
      error_message TEXT,
      triggered_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_auto_update_history_policy ON auto_update_history(policy_id);
  `);

  // Create notification_preferences table
  db.exec(`
    CREATE TABLE IF NOT EXISTS notification_preferences (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      email_enabled INTEGER NOT NULL DEFAULT 0,
      email_frequency TEXT NOT NULL DEFAULT 'daily',
      email_address TEXT,
      notify_critical_only INTEGER NOT NULL DEFAULT 0,
      webhook_enabled INTEGER NOT NULL DEFAULT 1,
      notify_on_update_available INTEGER NOT NULL DEFAULT 1,
      notify_on_deployed INTEGER NOT NULL DEFAULT 1,
      notify_on_error INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

/**
 * Parse JSON fields from database row
 */
function parseJobRow(row: Record<string, unknown>): PackagingJob {
  return {
    ...row,
    detection_rules: row.detection_rules ? JSON.parse(row.detection_rules as string) : null,
    package_config: row.package_config ? JSON.parse(row.package_config as string) : null,
    encryption_info: row.encryption_info ? JSON.parse(row.encryption_info as string) : null,
    error_details: row.error_details ? JSON.parse(row.error_details as string) : null,
    warnings: row.warnings ? JSON.parse(row.warnings as string) : null,
  } as PackagingJob;
}

/**
 * SQLite implementation of the database adapter
 */
export const sqliteDb: DatabaseAdapter = {
  jobs: {
    /**
     * Get jobs by status
     */
    async getByStatus(status: string, limit: number = 10, ascending: boolean = true): Promise<PackagingJob[]> {
      const database = getDb();
      const order = ascending ? 'ASC' : 'DESC';
      const stmt = database.prepare(`
        SELECT * FROM packaging_jobs
        WHERE status = ? AND archived_at IS NULL
        ORDER BY created_at ${order}
        LIMIT ?
      `);
      const rows = stmt.all(status, limit) as Record<string, unknown>[];
      return rows.map(parseJobRow);
    },

    /**
     * Get a job by ID
     */
    async getById(id: string): Promise<PackagingJob | null> {
      const database = getDb();
      const stmt = database.prepare('SELECT * FROM packaging_jobs WHERE id = ?');
      const row = stmt.get(id) as Record<string, unknown> | undefined;
      return row ? parseJobRow(row) : null;
    },

    /**
     * Get jobs by user ID
     * Auto-excludes terminal-state jobs older than 7 days
     */
    async getByUserId(userId: string, limit: number = 50): Promise<PackagingJob[]> {
      const database = getDb();
      // Return the most recent jobs for the user with no age cutoff, so the
      // Uploads (all activities) view shows older completed deployments too.
      const stmt = database.prepare(`
        SELECT * FROM packaging_jobs
        WHERE user_id = ? AND archived_at IS NULL
        ORDER BY created_at DESC
        LIMIT ?
      `);
      const rows = stmt.all(userId, limit) as Record<string, unknown>[];
      return rows.map(parseJobRow);
    },

    async getByTenantId(tenantId: string, limit: number = 50): Promise<PackagingJob[]> {
      const database = getDb();
      // Every user's jobs in this tenant, most recent first, no age cutoff.
      const stmt = database.prepare(`
        SELECT * FROM packaging_jobs
        WHERE tenant_id = ? AND archived_at IS NULL
        ORDER BY created_at DESC
        LIMIT ?
      `);
      const rows = stmt.all(tenantId, limit) as Record<string, unknown>[];
      return rows.map(parseJobRow);
    },

    /**
     * Create a new job
     */
    async create(job: Partial<PackagingJob>): Promise<PackagingJob> {
      const database = getDb();
      const id = job.id || crypto.randomUUID();
      const now = new Date().toISOString();

      const stmt = database.prepare(`
        INSERT INTO packaging_jobs (
          id, user_id, user_email, tenant_id, winget_id, version, display_name,
          publisher, architecture, installer_type, installer_url, installer_sha256,
          install_command, uninstall_command, install_scope, detection_rules,
          package_config, app_source, status, status_message, progress_percent,
          error_stage, error_category, error_code, execution_profile_sha256,
          presentation_profile_sha256, qa_candidate_id, qa_requested_at,
          qa_completed_at, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `);

      stmt.run(
        id,
        job.user_id,
        job.user_email || null,
        job.tenant_id || null,
        job.winget_id,
        job.version,
        job.display_name,
        job.publisher || null,
        job.architecture || null,
        job.installer_type,
        job.installer_url,
        job.installer_sha256 || null,
        job.install_command || null,
        job.uninstall_command || null,
        job.install_scope || null,
        job.detection_rules ? JSON.stringify(job.detection_rules) : null,
        job.package_config ? JSON.stringify(job.package_config) : null,
        job.app_source || 'win32',
        job.status || 'queued',
        job.status_message || null,
        job.progress_percent || 0,
        job.error_stage || null,
        job.error_category || null,
        job.error_code || null,
        job.execution_profile_sha256 || null,
        job.presentation_profile_sha256 || null,
        job.qa_candidate_id || null,
        job.qa_requested_at || null,
        job.qa_completed_at || null,
        now,
        now
      );

      return this.getById(id) as Promise<PackagingJob>;
    },

    /**
     * Update a job
     */
    async update(id: string, data: Partial<PackagingJob>, conditions?: Record<string, unknown>): Promise<PackagingJob | null> {
      const database = getDb();
      const now = new Date().toISOString();

      // Build the SET clause
      const updates: string[] = ['updated_at = ?'];
      const values: unknown[] = [now];

      for (const [key, value] of Object.entries(data)) {
        if (key === 'detection_rules' || key === 'package_config' || key === 'encryption_info' || key === 'warnings' || key === 'error_details') {
          updates.push(`${key} = ?`);
          values.push(value ? JSON.stringify(value) : null);
        } else {
          updates.push(`${key} = ?`);
          values.push(value);
        }
      }

      // Build the WHERE clause
      let whereClause = 'id = ?';
      values.push(id);

      if (conditions) {
        for (const [key, value] of Object.entries(conditions)) {
          if (value === null) {
            whereClause += ` AND ${key} IS NULL`;
          } else {
            whereClause += ` AND ${key} = ?`;
            values.push(value);
          }
        }
      }

      const stmt = database.prepare(`
        UPDATE packaging_jobs
        SET ${updates.join(', ')}
        WHERE ${whereClause}
      `);

      const result = stmt.run(...values);

      // Check if the update was successful
      if (result.changes === 0) {
        return null;
      }

      return this.getById(id);
    },

    /**
     * Claim a job atomically (only if status is 'queued')
     */
    async claim(jobId: string, packagerId: string): Promise<PackagingJob | null> {
      const now = new Date().toISOString();

      return this.update(
        jobId,
        {
          status: 'packaging',
          packager_id: packagerId,
          packager_heartbeat_at: now,
          claimed_at: now,
          packaging_started_at: now,
        },
        { status: 'queued' }
      );
    },

    /**
     * Release a job back to queued state
     */
    async release(jobId: string, packagerId: string): Promise<PackagingJob | null> {
      return this.update(
        jobId,
        {
          status: 'queued',
          packager_id: null,
          packager_heartbeat_at: null,
          claimed_at: null,
          packaging_started_at: null,
        },
        { packager_id: packagerId }
      );
    },

    /**
     * Force release a stale job back to queued state (no packager_id check)
     */
    async forceRelease(jobId: string): Promise<PackagingJob | null> {
      const database = getDb();
      const stmt = database.prepare(`
        UPDATE packaging_jobs
        SET status = 'queued',
            packager_id = NULL,
            packager_heartbeat_at = NULL,
            claimed_at = NULL,
            packaging_started_at = NULL,
            updated_at = ?
        WHERE id = ?
      `);

      const result = stmt.run(new Date().toISOString(), jobId);

      if (result.changes === 0) {
        return null;
      }

      return this.getById(jobId);
    },

    /**
     * Get stale jobs (packaging status with old heartbeat)
     */
    async getStaleJobs(staleThreshold: Date): Promise<PackagingJob[]> {
      const database = getDb();
      const stmt = database.prepare(`
        SELECT * FROM packaging_jobs
        WHERE status = 'packaging'
        AND packager_heartbeat_at < ?
      `);
      const rows = stmt.all(staleThreshold.toISOString()) as Record<string, unknown>[];
      return rows.map(parseJobRow);
    },

    /**
     * Get job statistics
     */
    async getStats(): Promise<{
      queued: number;
      packaging: number;
      uploading: number;
      deployed: number;
      failed: number;
      cancelled: number;
    }> {
      const database = getDb();
      const stmt = database.prepare(`
        SELECT status, COUNT(*) as count
        FROM packaging_jobs
        WHERE archived_at IS NULL
        GROUP BY status
      `);
      const rows = stmt.all() as Array<{ status: string; count: number }>;

      const stats = {
        queued: 0,
        packaging: 0,
        uploading: 0,
        deployed: 0,
        failed: 0,
        cancelled: 0,
      };

      for (const row of rows) {
        if (row.status in stats) {
          stats[row.status as keyof typeof stats] = row.count;
        }
      }

      return stats;
    },

    /** Soft-archive a single job by ID. */
    async deleteById(id: string): Promise<boolean> {
      const database = getDb();
      const now = new Date().toISOString();
      const stmt = database.prepare(
        'UPDATE packaging_jobs SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL',
      );
      const result = stmt.run(now, now, id);
      return result.changes > 0;
    },

    /** Bulk-archive jobs matching a user ID and a set of statuses. */
    async deleteByUserIdAndStatuses(userId: string, statuses: string[]): Promise<number> {
      const database = getDb();
      const placeholders = statuses.map(() => '?').join(', ');
      const stmt = database.prepare(`
        UPDATE packaging_jobs
        SET archived_at = ?, updated_at = ?
        WHERE user_id = ? AND status IN (${placeholders}) AND archived_at IS NULL
      `);
      const now = new Date().toISOString();
      const result = stmt.run(now, now, userId, ...statuses);
      return result.changes;
    },
  },

  uploadHistory: {
    /**
     * Create an upload history record
     */
    async create(record: Partial<UploadHistoryRecord>): Promise<UploadHistoryRecord> {
      const database = getDb();
      const id = record.id || crypto.randomUUID();
      const now = new Date().toISOString();

      const stmt = database.prepare(`
        INSERT INTO upload_history (
          id, packaging_job_id, user_id, winget_id, version, display_name,
          publisher, intune_app_id, intune_app_url, intune_tenant_id, deployed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        id,
        record.packaging_job_id || null,
        record.user_id,
        record.winget_id,
        record.version,
        record.display_name,
        record.publisher || null,
        record.intune_app_id,
        record.intune_app_url || null,
        record.intune_tenant_id || null,
        record.deployed_at || now
      );

      const result = database.prepare('SELECT * FROM upload_history WHERE id = ?').get(id);
      return result as UploadHistoryRecord;
    },

    /**
     * Get upload history by user ID
     */
    async getByUserId(userId: string, limit: number = 50): Promise<UploadHistoryRecord[]> {
      const database = getDb();
      const stmt = database.prepare(`
        SELECT * FROM upload_history
        WHERE user_id = ?
        ORDER BY deployed_at DESC
        LIMIT ?
      `);
      return stmt.all(userId, limit) as UploadHistoryRecord[];
    },
  },
};

/**
 * Parse a webhook_configurations row from SQLite into a WebhookConfiguration
 */
function parseWebhookRow(row: Record<string, unknown>): WebhookConfiguration {
  return {
    ...row,
    headers: row.headers ? JSON.parse(row.headers as string) : {},
    is_enabled: Boolean(row.is_enabled),
  } as WebhookConfiguration;
}

/**
 * SQLite-only webhook configuration storage.
 * Not part of DatabaseAdapter - Supabase mode still talks to
 * webhook_configurations directly via createServerClient(), so this stays
 * a standalone module the webhook routes branch to in SQLite mode.
 */
export const sqliteWebhooks = {
  async listByUser(userId: string): Promise<WebhookConfiguration[]> {
    const database = getDb();
    const stmt = database.prepare(`
      SELECT * FROM webhook_configurations
      WHERE user_id = ?
      ORDER BY created_at DESC
    `);
    const rows = stmt.all(userId) as Record<string, unknown>[];
    return rows.map(parseWebhookRow);
  },

  async countByUser(userId: string): Promise<number> {
    const database = getDb();
    const row = database
      .prepare('SELECT COUNT(*) as count FROM webhook_configurations WHERE user_id = ?')
      .get(userId) as { count: number };
    return row.count;
  },

  async getById(id: string, userId: string): Promise<WebhookConfiguration | null> {
    const database = getDb();
    const row = database
      .prepare('SELECT * FROM webhook_configurations WHERE id = ? AND user_id = ?')
      .get(id, userId) as Record<string, unknown> | undefined;
    return row ? parseWebhookRow(row) : null;
  },

  async create(userId: string, input: WebhookConfigurationInput): Promise<WebhookConfiguration> {
    const database = getDb();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    database
      .prepare(`
        INSERT INTO webhook_configurations (
          id, user_id, name, url, webhook_type, secret, headers,
          is_enabled, failure_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      `)
      .run(
        id,
        userId,
        input.name.trim(),
        input.url,
        input.webhook_type,
        input.secret || null,
        JSON.stringify(input.headers || {}),
        input.is_enabled ?? true ? 1 : 0,
        now,
        now
      );

    return (await this.getById(id, userId)) as WebhookConfiguration;
  },

  async update(
    id: string,
    userId: string,
    data: WebhookConfigurationUpdate & {
      failure_count?: number;
      last_failure_at?: string | null;
      last_success_at?: string | null;
    }
  ): Promise<WebhookConfiguration | null> {
    const database = getDb();
    const now = new Date().toISOString();

    const updates: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];

    if (data.name !== undefined) { updates.push('name = ?'); values.push(data.name.trim()); }
    if (data.url !== undefined) { updates.push('url = ?'); values.push(data.url); }
    if (data.webhook_type !== undefined) { updates.push('webhook_type = ?'); values.push(data.webhook_type); }
    if (data.headers !== undefined) { updates.push('headers = ?'); values.push(JSON.stringify(data.headers)); }
    if (data.is_enabled !== undefined) { updates.push('is_enabled = ?'); values.push(data.is_enabled ? 1 : 0); }
    if ('secret' in data) { updates.push('secret = ?'); values.push(data.secret ?? null); }
    if (data.failure_count !== undefined) { updates.push('failure_count = ?'); values.push(data.failure_count); }
    if (data.last_failure_at !== undefined) { updates.push('last_failure_at = ?'); values.push(data.last_failure_at); }
    if (data.last_success_at !== undefined) { updates.push('last_success_at = ?'); values.push(data.last_success_at); }

    values.push(id, userId);

    const result = database
      .prepare(`UPDATE webhook_configurations SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`)
      .run(...values);

    if (result.changes === 0) return null;
    return this.getById(id, userId);
  },

  async remove(id: string, userId: string): Promise<boolean> {
    const database = getDb();
    const result = database
      .prepare('DELETE FROM webhook_configurations WHERE id = ? AND user_id = ?')
      .run(id, userId);
    return result.changes > 0;
  },
};

/**
 * Parse a claimed_apps row from SQLite into a ClaimedApp
 */
function parseClaimedAppRow(row: Record<string, unknown>): ClaimedApp {
  return {
    id: row.id,
    userId: row.user_id,
    tenantId: row.tenant_id,
    discoveredAppId: row.discovered_app_id,
    discoveredAppName: row.discovered_app_name,
    wingetPackageId: row.winget_package_id,
    intuneAppId: row.intune_app_id,
    deviceCountAtClaim: row.device_count_at_claim,
    claimedAt: row.claimed_at,
    status: row.status,
  } as ClaimedApp;
}

/**
 * SQLite-only claimed-app storage (Discovered Apps -> claim flow).
 * Not part of DatabaseAdapter - Supabase mode still talks to claimed_apps
 * directly via createServerClient(), so this stays a standalone module the
 * claim route branches to in SQLite mode. No user_profiles FK, unlike the
 * Supabase schema - SQLite mode has no equivalent table for that.
 */
export const sqliteClaims = {
  async listByTenant(tenantId: string): Promise<ClaimedApp[]> {
    const database = getDb();
    const rows = database
      .prepare('SELECT * FROM claimed_apps WHERE tenant_id = ? ORDER BY claimed_at DESC')
      .all(tenantId) as Record<string, unknown>[];
    return rows.map(parseClaimedAppRow);
  },

  async getByTenantAndDiscoveredId(tenantId: string, discoveredAppId: string): Promise<ClaimedApp | null> {
    const database = getDb();
    const row = database
      .prepare('SELECT * FROM claimed_apps WHERE tenant_id = ? AND discovered_app_id = ?')
      .get(tenantId, discoveredAppId) as Record<string, unknown> | undefined;
    return row ? parseClaimedAppRow(row) : null;
  },

  /**
   * Create a new claim, or re-claim (update) an existing one for the same
   * tenant + discovered app id - mirrors the Supabase route's upsert logic.
   */
  async upsertClaim(params: {
    userId: string;
    tenantId: string;
    discoveredAppId: string;
    discoveredAppName: string;
    wingetPackageId: string;
    deviceCount: number;
  }): Promise<ClaimedApp> {
    const database = getDb();
    const existing = await this.getByTenantAndDiscoveredId(params.tenantId, params.discoveredAppId);
    const now = new Date().toISOString();

    if (existing) {
      database
        .prepare(`
          UPDATE claimed_apps
          SET user_id = ?, winget_package_id = ?, device_count_at_claim = ?, status = 'pending', claimed_at = ?
          WHERE id = ?
        `)
        .run(params.userId, params.wingetPackageId, params.deviceCount, now, existing.id);
      return (await this.getByTenantAndDiscoveredId(params.tenantId, params.discoveredAppId)) as ClaimedApp;
    }

    const id = crypto.randomUUID();
    database
      .prepare(`
        INSERT INTO claimed_apps (
          id, user_id, tenant_id, discovered_app_id, discovered_app_name,
          winget_package_id, device_count_at_claim, status, claimed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `)
      .run(id, params.userId, params.tenantId, params.discoveredAppId, params.discoveredAppName, params.wingetPackageId, params.deviceCount, now);

    return (await this.getByTenantAndDiscoveredId(params.tenantId, params.discoveredAppId)) as ClaimedApp;
  },

  /**
   * Mark any pending claim(s) for this tenant + winget package as deployed,
   * once a packaging job for that package reaches a terminal success state
   * (deployed, or duplicate_skipped - the app is already in Intune either
   * way). Called from the package callback route, not the claim route.
   */
  async markDeployedByWingetPackage(tenantId: string, wingetPackageId: string, intuneAppId: string | null): Promise<number> {
    const database = getDb();
    const result = database
      .prepare(`
        UPDATE claimed_apps
        SET status = 'deployed', intune_app_id = COALESCE(?, intune_app_id)
        WHERE tenant_id = ? AND winget_package_id = ? AND status = 'pending'
      `)
      .run(intuneAppId, tenantId, wingetPackageId);
    return result.changes;
  },

  async updateStatus(claimId: string, tenantId: string, updates: { status?: string; intuneAppId?: string }): Promise<ClaimedApp | null> {
    const database = getDb();
    const sets: string[] = [];
    const values: unknown[] = [];
    if (updates.status !== undefined) { sets.push('status = ?'); values.push(updates.status); }
    if (updates.intuneAppId !== undefined) { sets.push('intune_app_id = ?'); values.push(updates.intuneAppId); }
    if (sets.length === 0) return null;

    values.push(claimId, tenantId);
    const result = database
      .prepare(`UPDATE claimed_apps SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`)
      .run(...values);
    if (result.changes === 0) return null;

    const row = database.prepare('SELECT * FROM claimed_apps WHERE id = ?').get(claimId) as Record<string, unknown> | undefined;
    return row ? parseClaimedAppRow(row) : null;
  },
};

/**
 * Close the database connection (for cleanup)
 */
export function closeSqliteDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
