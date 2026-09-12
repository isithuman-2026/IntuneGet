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
import type { AppUpdatePolicy, AppUpdatePolicyInput } from '@/types/update-policies';

export interface NotificationPreferencesRow {
  id: string;
  user_id: string;
  email_enabled: boolean;
  email_frequency: 'immediate' | 'daily' | 'weekly';
  email_address: string | null;
  notify_critical_only: boolean;
  webhook_enabled: boolean;
  notify_on_update_available: boolean;
  notify_on_deployed: boolean;
  notify_on_error: boolean;
  created_at: string;
  updated_at: string;
}

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
 * SQLite-only: list every upload_history row across all users.
 * Not part of DatabaseAdapter - Supabase mode has no reason to list all users'
 * deployments at once outside its own batched cron. Single-tenant SQLite mode
 * has exactly one effective "user scope": every row in upload_history.
 */
export function sqliteListAllUploadHistory(): UploadHistoryRecord[] {
  const database = getDb();
  return database.prepare('SELECT * FROM upload_history').all() as UploadHistoryRecord[];
}

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
 * Parse an app_update_policies row from SQLite into an AppUpdatePolicy
 */
function parseUpdatePolicyRow(row: Record<string, unknown>): AppUpdatePolicy {
  return {
    ...row,
    deployment_config: row.deployment_config ? JSON.parse(row.deployment_config as string) : null,
    is_enabled: Boolean(row.is_enabled),
  } as unknown as AppUpdatePolicy;
}

/**
 * SQLite-only update policy storage for automated update management.
 * Not part of DatabaseAdapter - this is update-detection feature-specific.
 */
export const sqliteUpdatePolicies = {
  async listByUser(userId: string, tenantId?: string): Promise<AppUpdatePolicy[]> {
    const database = getDb();
    const rows = tenantId
      ? database.prepare('SELECT * FROM app_update_policies WHERE user_id = ? AND tenant_id = ? ORDER BY updated_at DESC').all(userId, tenantId)
      : database.prepare('SELECT * FROM app_update_policies WHERE user_id = ? ORDER BY updated_at DESC').all(userId);
    return (rows as Record<string, unknown>[]).map(parseUpdatePolicyRow);
  },

  async getByApp(userId: string, tenantId: string, wingetId: string): Promise<AppUpdatePolicy | null> {
    const database = getDb();
    const row = database
      .prepare('SELECT * FROM app_update_policies WHERE user_id = ? AND tenant_id = ? AND winget_id = ?')
      .get(userId, tenantId, wingetId) as Record<string, unknown> | undefined;
    return row ? parseUpdatePolicyRow(row) : null;
  },

  async getById(id: string, userId: string): Promise<AppUpdatePolicy | null> {
    const database = getDb();
    const row = database
      .prepare('SELECT * FROM app_update_policies WHERE id = ? AND user_id = ?')
      .get(id, userId) as Record<string, unknown> | undefined;
    return row ? parseUpdatePolicyRow(row) : null;
  },

  async upsert(
    userId: string,
    input: AppUpdatePolicyInput & { delay_days?: number }
  ): Promise<{ policy: AppUpdatePolicy; created: boolean }> {
    const database = getDb();
    const existing = await this.getByApp(userId, input.tenant_id, input.winget_id);
    const now = new Date().toISOString();

    if (existing) {
      database
        .prepare(`
          UPDATE app_update_policies
          SET policy_type = ?, pinned_version = ?, deployment_config = ?,
              original_upload_history_id = ?, delay_days = ?, is_enabled = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(
          input.policy_type,
          input.policy_type === 'pin_version' ? (input.pinned_version || null) : null,
          input.deployment_config ? JSON.stringify(input.deployment_config) : null,
          input.original_upload_history_id || null,
          input.delay_days ?? existing.delay_days ?? 0,
          input.is_enabled ?? true ? 1 : 0,
          now,
          existing.id
        );
      return { policy: (await this.getById(existing.id, userId)) as AppUpdatePolicy, created: false };
    }

    const id = crypto.randomUUID();
    database
      .prepare(`
        INSERT INTO app_update_policies (
          id, user_id, tenant_id, winget_id, policy_type, pinned_version,
          deployment_config, original_upload_history_id, delay_days, is_enabled,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        userId,
        input.tenant_id,
        input.winget_id,
        input.policy_type,
        input.policy_type === 'pin_version' ? (input.pinned_version || null) : null,
        input.deployment_config ? JSON.stringify(input.deployment_config) : null,
        input.original_upload_history_id || null,
        input.delay_days ?? 0,
        input.is_enabled ?? true ? 1 : 0,
        now,
        now
      );
    return { policy: (await this.getById(id, userId)) as AppUpdatePolicy, created: true };
  },

  async update(
    id: string,
    userId: string,
    data: Partial<AppUpdatePolicyInput> & {
      delay_days?: number;
      is_enabled?: boolean;
      consecutive_failures?: number;
      last_auto_update_at?: string;
      last_auto_update_version?: string;
    }
  ): Promise<AppUpdatePolicy | null> {
    const database = getDb();
    const sets: string[] = ['updated_at = ?'];
    const values: unknown[] = [new Date().toISOString()];

    if (data.policy_type !== undefined) { sets.push('policy_type = ?'); values.push(data.policy_type); }
    if (data.pinned_version !== undefined) { sets.push('pinned_version = ?'); values.push(data.pinned_version); }
    if (data.deployment_config !== undefined) { sets.push('deployment_config = ?'); values.push(JSON.stringify(data.deployment_config)); }
    if (data.original_upload_history_id !== undefined) { sets.push('original_upload_history_id = ?'); values.push(data.original_upload_history_id); }
    if (data.delay_days !== undefined) { sets.push('delay_days = ?'); values.push(data.delay_days); }
    if (data.last_auto_update_at !== undefined) { sets.push('last_auto_update_at = ?'); values.push(data.last_auto_update_at); }
    if (data.last_auto_update_version !== undefined) { sets.push('last_auto_update_version = ?'); values.push(data.last_auto_update_version); }
    if (data.is_enabled !== undefined) {
      sets.push('is_enabled = ?');
      values.push(data.is_enabled ? 1 : 0);
      if (data.is_enabled === true) { sets.push('consecutive_failures = 0'); }
    }

    values.push(id, userId);
    const result = database
      .prepare(`UPDATE app_update_policies SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
      .run(...values);
    if (result.changes === 0) return null;
    return this.getById(id, userId);
  },

  async delete(id: string, userId: string): Promise<boolean> {
    const database = getDb();
    const result = database
      .prepare('DELETE FROM app_update_policies WHERE id = ? AND user_id = ?')
      .run(id, userId);
    return result.changes > 0;
  },

  async incrementFailureCount(id: string): Promise<void> {
    const database = getDb();
    database
      .prepare('UPDATE app_update_policies SET consecutive_failures = consecutive_failures + 1, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
  },
};

export interface UpdateCheckInsert {
  user_id: string;
  tenant_id: string;
  winget_id: string;
  intune_app_id: string;
  display_name: string;
  current_version: string;
  latest_version: string;
  is_critical: boolean;
  is_managed: boolean;
  notified_at: string | null;
  detected_at: string;
  updated_at: string;
}

export interface UpdateCheckRow extends UpdateCheckInsert {
  id: string;
  dismissed_at: string | null;
}

function parseUpdateCheckRow(row: Record<string, unknown>): UpdateCheckRow {
  return {
    ...row,
    is_critical: Boolean(row.is_critical),
    is_managed: Boolean(row.is_managed),
  } as UpdateCheckRow;
}

/**
 * SQLite-only update check results storage for managing detected app updates.
 * Stores individual package versions detected on user devices and update dismissals.
 */
export const sqliteUpdateChecks = {
  async listByUser(
    userId: string,
    opts: { tenantId?: string; includeDismissed?: boolean; criticalOnly?: boolean } = {}
  ): Promise<UpdateCheckRow[]> {
    const database = getDb();
    const conditions = ['user_id = ?'];
    const values: unknown[] = [userId];
    if (opts.tenantId) { conditions.push('tenant_id = ?'); values.push(opts.tenantId); }
    if (!opts.includeDismissed) { conditions.push('dismissed_at IS NULL'); }
    if (opts.criticalOnly) { conditions.push('is_critical = 1'); }
    const rows = database
      .prepare(`SELECT * FROM update_check_results WHERE ${conditions.join(' AND ')} ORDER BY detected_at DESC`)
      .all(...values) as Record<string, unknown>[];
    return rows.map(parseUpdateCheckRow);
  },

  async getOne(userId: string, tenantId: string, wingetId: string): Promise<UpdateCheckRow | null> {
    const database = getDb();
    const row = database
      .prepare('SELECT * FROM update_check_results WHERE user_id = ? AND tenant_id = ? AND winget_id = ?')
      .get(userId, tenantId, wingetId) as Record<string, unknown> | undefined;
    return row ? parseUpdateCheckRow(row) : null;
  },

  async upsertMany(rows: UpdateCheckInsert[]): Promise<void> {
    if (rows.length === 0) return;
    const database = getDb();
    const stmt = database.prepare(`
      INSERT INTO update_check_results (
        id, user_id, tenant_id, winget_id, intune_app_id, display_name,
        current_version, latest_version, is_critical, is_managed,
        notified_at, detected_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, tenant_id, winget_id, intune_app_id) DO UPDATE SET
        display_name = excluded.display_name,
        current_version = excluded.current_version,
        latest_version = excluded.latest_version,
        is_critical = excluded.is_critical,
        is_managed = excluded.is_managed,
        notified_at = excluded.notified_at,
        detected_at = excluded.detected_at,
        updated_at = excluded.updated_at
    `);
    const insertAll = database.transaction((items: UpdateCheckInsert[]) => {
      for (const r of items) {
        stmt.run(
          crypto.randomUUID(), r.user_id, r.tenant_id, r.winget_id, r.intune_app_id,
          r.display_name, r.current_version, r.latest_version,
          r.is_critical ? 1 : 0, r.is_managed ? 1 : 0, r.notified_at, r.detected_at, r.updated_at
        );
      }
    });
    insertAll(rows);
  },

  async deleteStale(userId: string, activeKeys: Set<string>): Promise<number> {
    const database = getDb();
    const rows = database
      .prepare('SELECT id, winget_id, intune_app_id FROM update_check_results WHERE user_id = ?')
      .all(userId) as Array<{ id: string; winget_id: string; intune_app_id: string }>;
    const staleIds = rows
      .filter((r) => !activeKeys.has(`${r.winget_id}:${r.intune_app_id}`))
      .map((r) => r.id);
    if (staleIds.length === 0) return 0;
    const placeholders = staleIds.map(() => '?').join(', ');
    const result = database.prepare(`DELETE FROM update_check_results WHERE id IN (${placeholders})`).run(...staleIds);
    return result.changes;
  },

  async deleteOlderThan(cutoffIso: string): Promise<number> {
    const database = getDb();
    const result = database.prepare('DELETE FROM update_check_results WHERE detected_at < ?').run(cutoffIso);
    return result.changes;
  },

  async dismiss(userId: string, ids: string[], dismissed: boolean): Promise<number> {
    if (ids.length === 0) return 0;
    const database = getDb();
    const placeholders = ids.map(() => '?').join(', ');
    const now = new Date().toISOString();
    const result = database
      .prepare(`UPDATE update_check_results SET dismissed_at = ?, updated_at = ? WHERE id IN (${placeholders}) AND user_id = ?`)
      .run(dismissed ? now : null, now, ...ids, userId);
    return result.changes;
  },
};

/**
 * SQLite-only auto-update history tracking for deployed package updates.
 * Records the history of automatic updates triggered by policies, from
 * packaging through deployment.
 */
export const sqliteAutoUpdateHistory = {
  async create(policyId: string, fromVersion: string, toVersion: string, updateType: string): Promise<{ id: string }> {
    const database = getDb();
    const id = crypto.randomUUID();
    database
      .prepare(`
        INSERT INTO auto_update_history (id, policy_id, from_version, to_version, update_type, status, triggered_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?)
      `)
      .run(id, policyId, fromVersion, toVersion, updateType, new Date().toISOString());
    return { id };
  },

  async updateStatus(
    id: string,
    status: string,
    extra: { packagingJobId?: string; errorMessage?: string; completedAt?: string } = {}
  ): Promise<void> {
    const database = getDb();
    const sets = ['status = ?'];
    const values: unknown[] = [status];
    if (extra.packagingJobId !== undefined) { sets.push('packaging_job_id = ?'); values.push(extra.packagingJobId); }
    if (extra.errorMessage !== undefined) { sets.push('error_message = ?'); values.push(extra.errorMessage); }
    if (extra.completedAt !== undefined) { sets.push('completed_at = ?'); values.push(extra.completedAt); }
    values.push(id);
    database.prepare(`UPDATE auto_update_history SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  },

  async countSince(policyIds: string[], sinceIso: string, statusFilter?: string): Promise<number> {
    if (policyIds.length === 0) return 0;
    const database = getDb();
    const placeholders = policyIds.map(() => '?').join(', ');
    const statusClause = statusFilter ? 'AND status = ?' : '';
    const row = database
      .prepare(`SELECT COUNT(*) as count FROM auto_update_history WHERE policy_id IN (${placeholders}) AND triggered_at >= ? ${statusClause}`)
      .get(...policyIds, sinceIso, ...(statusFilter ? [statusFilter] : [])) as { count: number };
    return row.count;
  },

  async hasRecentForPolicy(policyId: string, sinceIso: string): Promise<boolean> {
    const database = getDb();
    const row = database
      .prepare('SELECT id FROM auto_update_history WHERE policy_id = ? AND triggered_at >= ? LIMIT 1')
      .get(policyId, sinceIso);
    return Boolean(row);
  },

  async listByUser(
    userId: string,
    opts: { tenantId?: string; wingetId?: string; status?: string; limit: number; offset: number }
  ): Promise<Array<{
    id: string; policy_id: string; packaging_job_id: string | null; from_version: string;
    to_version: string; update_type: string; status: string; error_message: string | null;
    triggered_at: string; completed_at: string | null;
    policy: { winget_id: string; tenant_id: string }; display_name?: string;
  }>> {
    const database = getDb();
    const policyConditions = ['user_id = ?'];
    const policyValues: unknown[] = [userId];
    if (opts.tenantId) { policyConditions.push('tenant_id = ?'); policyValues.push(opts.tenantId); }
    if (opts.wingetId) { policyConditions.push('winget_id = ?'); policyValues.push(opts.wingetId); }
    const policies = database
      .prepare(`SELECT id, winget_id, tenant_id FROM app_update_policies WHERE ${policyConditions.join(' AND ')}`)
      .all(...policyValues) as Array<{ id: string; winget_id: string; tenant_id: string }>;

    if (policies.length === 0) return [];
    const policyMap = new Map(policies.map((p) => [p.id, p]));
    const policyIds = policies.map((p) => p.id);
    const placeholders = policyIds.map(() => '?').join(', ');

    const statusClause = opts.status ? 'AND status = ?' : '';
    const rows = database
      .prepare(`
        SELECT * FROM auto_update_history
        WHERE policy_id IN (${placeholders}) ${statusClause}
        ORDER BY triggered_at DESC
        LIMIT ? OFFSET ?
      `)
      .all(...policyIds, ...(opts.status ? [opts.status] : []), opts.limit, opts.offset) as Array<Record<string, unknown>>;

    const jobIds = rows.map((r) => r.packaging_job_id).filter((id): id is string => typeof id === 'string');
    const jobNames = new Map<string, string>();
    if (jobIds.length > 0) {
      const jobPlaceholders = jobIds.map(() => '?').join(', ');
      const jobs = database
        .prepare(`SELECT id, display_name FROM packaging_jobs WHERE id IN (${jobPlaceholders})`)
        .all(...jobIds) as Array<{ id: string; display_name: string }>;
      jobs.forEach((j) => jobNames.set(j.id, j.display_name));
    }

    return rows.map((r) => {
      const policy = policyMap.get(r.policy_id as string)!;
      return {
        id: r.id as string,
        policy_id: r.policy_id as string,
        packaging_job_id: r.packaging_job_id as string | null,
        from_version: r.from_version as string,
        to_version: r.to_version as string,
        update_type: r.update_type as string,
        status: r.status as string,
        error_message: r.error_message as string | null,
        triggered_at: r.triggered_at as string,
        completed_at: r.completed_at as string | null,
        policy: { winget_id: policy.winget_id, tenant_id: policy.tenant_id },
        display_name: r.packaging_job_id ? jobNames.get(r.packaging_job_id as string) : undefined,
      };
    });
  },
};

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
 * Parse a notification_preferences row from SQLite into a NotificationPreferencesRow
 */
function parseNotificationPreferencesRow(row: Record<string, unknown>): NotificationPreferencesRow {
  return {
    ...row,
    email_enabled: Boolean(row.email_enabled),
    notify_critical_only: Boolean(row.notify_critical_only),
    webhook_enabled: Boolean(row.webhook_enabled),
    notify_on_update_available: Boolean(row.notify_on_update_available),
    notify_on_deployed: Boolean(row.notify_on_deployed),
    notify_on_error: Boolean(row.notify_on_error),
  } as NotificationPreferencesRow;
}

/**
 * SQLite-only notification preferences storage.
 * Handles user notification settings and preferences.
 */
export const sqliteNotificationPreferences = {
  async get(userId: string): Promise<NotificationPreferencesRow | null> {
    const database = getDb();
    const row = database
      .prepare('SELECT * FROM notification_preferences WHERE user_id = ?')
      .get(userId) as Record<string, unknown> | undefined;
    return row ? parseNotificationPreferencesRow(row) : null;
  },

  async upsert(userId: string, data: Partial<NotificationPreferencesRow>): Promise<NotificationPreferencesRow> {
    const database = getDb();
    const existing = await this.get(userId);
    const now = new Date().toISOString();

    if (existing) {
      const sets: string[] = ['updated_at = ?'];
      const values: unknown[] = [now];
      const boolFields = ['email_enabled', 'notify_critical_only', 'webhook_enabled', 'notify_on_update_available', 'notify_on_deployed', 'notify_on_error'] as const;
      const textFields = ['email_frequency', 'email_address'] as const;
      for (const f of boolFields) {
        if (data[f] !== undefined) { sets.push(`${f} = ?`); values.push(data[f] ? 1 : 0); }
      }
      for (const f of textFields) {
        if (data[f] !== undefined) { sets.push(`${f} = ?`); values.push(data[f]); }
      }
      values.push(userId);
      database.prepare(`UPDATE notification_preferences SET ${sets.join(', ')} WHERE user_id = ?`).run(...values);
      return (await this.get(userId)) as NotificationPreferencesRow;
    }

    const id = crypto.randomUUID();
    database
      .prepare(`
        INSERT INTO notification_preferences (
          id, user_id, email_enabled, email_frequency, email_address, notify_critical_only,
          webhook_enabled, notify_on_update_available, notify_on_deployed, notify_on_error,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id, userId,
        data.email_enabled ? 1 : 0,
        data.email_frequency || 'daily',
        data.email_address ?? null,
        data.notify_critical_only ? 1 : 0,
        data.webhook_enabled === undefined ? 1 : (data.webhook_enabled ? 1 : 0),
        data.notify_on_update_available === undefined ? 1 : (data.notify_on_update_available ? 1 : 0),
        data.notify_on_deployed === undefined ? 1 : (data.notify_on_deployed ? 1 : 0),
        data.notify_on_error === undefined ? 1 : (data.notify_on_error ? 1 : 0),
        now, now
      );
    return (await this.get(userId)) as NotificationPreferencesRow;
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
