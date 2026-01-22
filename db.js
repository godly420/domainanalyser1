/**
 * Database module for Domain Price Searcher
 * Stores search sessions, results, and publisher master list
 */

const Database = require('better-sqlite3');
const path = require('path');

// Use /data mount in production (Fly.io), local path otherwise
const DB_PATH = process.env.NODE_ENV === 'production'
  ? '/data/price-scraper.db'
  : path.join(__dirname, 'price-scraper.db');

let db;

/**
 * Initialize database and create tables
 */
function init() {
  try {
    db = new Database(DB_PATH);
    db.pragma('foreign_keys = ON');

    // Search sessions table
    db.exec(`
      CREATE TABLE IF NOT EXISTS search_sessions (
        id TEXT PRIMARY KEY,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        domains_count INTEGER DEFAULT 0,
        results_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'running'
      )
    `);

    // Search results table
    db.exec(`
      CREATE TABLE IF NOT EXISTS search_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        domain TEXT NOT NULL,
        guest_post_price REAL,
        link_insertion_price REAL,
        sponsored_post_price REAL,
        homepage_link_price REAL,
        casino_price REAL,
        casino_accepted TEXT DEFAULT 'no',
        currency TEXT DEFAULT 'USD',
        source_email TEXT,
        subject TEXT,
        account TEXT,
        confidence TEXT,
        notes TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES search_sessions(id)
      )
    `);

    // Publishers master table - stores unique domains with latest pricing
    db.exec(`
      CREATE TABLE IF NOT EXISTS publishers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        domain TEXT UNIQUE NOT NULL,
        guest_post_price REAL,
        link_insertion_price REAL,
        sponsored_post_price REAL,
        homepage_link_price REAL,
        casino_price REAL,
        casino_accepted TEXT DEFAULT 'no',
        currency TEXT DEFAULT 'USD',
        contact_email TEXT,
        contact_name TEXT,
        source_account TEXT,
        confidence TEXT,
        notes TEXT,
        first_found TEXT DEFAULT CURRENT_TIMESTAMP,
        last_updated TEXT DEFAULT CURRENT_TIMESTAMP,
        last_refreshed TEXT DEFAULT CURRENT_TIMESTAMP,
        search_count INTEGER DEFAULT 1,
        is_favorite INTEGER DEFAULT 0,
        tags TEXT
      )
    `);

    // Tasks table - batch domain searches
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        total_domains INTEGER DEFAULT 0,
        completed_domains INTEGER DEFAULT 0,
        successful_domains INTEGER DEFAULT 0,
        failed_domains INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        started_at TEXT,
        completed_at TEXT,
        paused_at TEXT
      )
    `);

    // Task domains table - individual domains within a task
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_domains (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        domain TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        guest_post_price REAL,
        casino_price REAL,
        currency TEXT,
        contact_email TEXT,
        confidence TEXT,
        error_message TEXT,
        started_at TEXT,
        completed_at TEXT,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      )
    `);

    // Indexes
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_results_session ON search_results(session_id);
      CREATE INDEX IF NOT EXISTS idx_results_domain ON search_results(domain);
      CREATE INDEX IF NOT EXISTS idx_publishers_domain ON publishers(domain);
      CREATE INDEX IF NOT EXISTS idx_publishers_updated ON publishers(last_updated);
      CREATE INDEX IF NOT EXISTS idx_task_domains_task ON task_domains(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_domains_status ON task_domains(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    `);

    console.log('Database initialized:', DB_PATH);
    return db;
  } catch (error) {
    console.error('Database init error:', error);
    throw error;
  }
}

/**
 * Create a new search session
 * @param {string} sessionId - UUID for the session
 * @param {number} domainsCount - Number of domains to search
 */
function createSession(sessionId, domainsCount) {
  const stmt = db.prepare(`
    INSERT INTO search_sessions (id, domains_count, status)
    VALUES (?, ?, 'running')
  `);
  stmt.run(sessionId, domainsCount);
}

/**
 * Save a search result
 * @param {string} sessionId - Session ID
 * @param {Object} result - Result data
 */
function saveResult(sessionId, result) {
  const stmt = db.prepare(`
    INSERT INTO search_results (
      session_id, domain, guest_post_price, link_insertion_price,
      sponsored_post_price, homepage_link_price, casino_price, casino_accepted,
      currency, source_email, subject, account, confidence, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    sessionId,
    result.domain,
    result.guest_post_price,
    result.link_insertion_price,
    result.sponsored_post_price,
    result.homepage_link_price,
    result.casino_price,
    result.casino_accepted || 'no',
    result.currency || 'USD',
    result.source_email,
    result.subject,
    result.account,
    result.confidence,
    result.notes
  );

  // Update results count
  db.prepare(`
    UPDATE search_sessions
    SET results_count = results_count + 1
    WHERE id = ?
  `).run(sessionId);
}

/**
 * Mark session as complete
 * @param {string} sessionId - Session ID
 */
function completeSession(sessionId) {
  db.prepare(`
    UPDATE search_sessions SET status = 'complete' WHERE id = ?
  `).run(sessionId);
}

/**
 * Get all results for a session
 * @param {string} sessionId - Session ID
 * @returns {Array} Results array
 */
function getResults(sessionId) {
  return db.prepare(`
    SELECT * FROM search_results WHERE session_id = ? ORDER BY created_at
  `).all(sessionId);
}

/**
 * Get session info
 * @param {string} sessionId - Session ID
 * @returns {Object} Session data
 */
function getSession(sessionId) {
  return db.prepare(`
    SELECT * FROM search_sessions WHERE id = ?
  `).get(sessionId);
}

/**
 * Export results to CSV format
 * @param {string} sessionId - Session ID
 * @returns {string} CSV string
 */
function exportToCsv(sessionId) {
  const results = getResults(sessionId);

  if (results.length === 0) {
    return '';
  }

  const headers = [
    'Domain',
    'Guest Post Price',
    'Link Insertion Price',
    'Sponsored Post Price',
    'Homepage Link Price',
    'Casino Price',
    'Casino Accepted',
    'Currency',
    'Contact Email',
    'Source Account',
    'Subject',
    'Confidence',
    'Notes'
  ];

  const escapeCSV = (value) => {
    if (value === null || value === undefined) return '';
    const str = String(value);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const rows = results.map(r => [
    r.domain,
    r.guest_post_price,
    r.link_insertion_price,
    r.sponsored_post_price,
    r.homepage_link_price,
    r.casino_price,
    r.casino_accepted,
    r.currency,
    r.source_email,
    r.account,
    r.subject,
    r.confidence,
    r.notes
  ].map(escapeCSV).join(','));

  return [headers.join(','), ...rows].join('\n');
}

/**
 * Close database connection
 */
function close() {
  if (db) {
    db.close();
  }
}

// ============================================
// PUBLISHER FUNCTIONS
// ============================================

/**
 * Save or update a publisher in the master list
 * @param {Object} result - Search result data
 */
function savePublisher(result) {
  // Extract contact name from email if present
  const contactName = result.source_email ?
    result.source_email.match(/^([^<]+)</)?.[1]?.trim() || null : null;
  const contactEmail = result.source_email ?
    result.source_email.match(/<([^>]+)>/)?.[1] || result.source_email : result.source_email;

  // Check if publisher exists
  const existing = db.prepare('SELECT * FROM publishers WHERE domain = ?').get(result.domain);

  if (existing) {
    // Confidence ranking: high > medium > low
    const confidenceRank = { 'high': 3, 'medium': 2, 'low': 1 };
    const existingRank = confidenceRank[existing.confidence] || 0;
    const newRank = confidenceRank[result.confidence] || 0;

    // Only update pricing if:
    // 1. New confidence is equal or better, OR
    // 2. Existing has no price but new one does
    const shouldUpdatePricing = newRank >= existingRank ||
      (existing.guest_post_price === null && result.guest_post_price !== null);

    if (shouldUpdatePricing) {
      // Update with new data (better or equal source)
      const stmt = db.prepare(`
        UPDATE publishers SET
          guest_post_price = COALESCE(?, guest_post_price),
          link_insertion_price = COALESCE(?, link_insertion_price),
          sponsored_post_price = COALESCE(?, sponsored_post_price),
          homepage_link_price = COALESCE(?, homepage_link_price),
          casino_price = COALESCE(?, casino_price),
          casino_accepted = COALESCE(?, casino_accepted),
          currency = COALESCE(?, currency),
          contact_email = COALESCE(?, contact_email),
          contact_name = COALESCE(?, contact_name),
          source_account = COALESCE(?, source_account),
          confidence = COALESCE(?, confidence),
          notes = COALESCE(?, notes),
          last_updated = CURRENT_TIMESTAMP,
          last_refreshed = CURRENT_TIMESTAMP,
          search_count = search_count + 1
        WHERE domain = ?
      `);
      stmt.run(
        result.guest_post_price,
        result.link_insertion_price,
        result.sponsored_post_price,
        result.homepage_link_price,
        result.casino_price,
        result.casino_accepted,
        result.currency,
        contactEmail,
        contactName,
        result.account,
        result.confidence,
        result.notes,
        result.domain
      );
    } else {
      // Keep existing better data, only update search count and refresh timestamp
      const stmt = db.prepare(`
        UPDATE publishers SET
          last_refreshed = CURRENT_TIMESTAMP,
          search_count = search_count + 1
        WHERE domain = ?
      `);
      stmt.run(result.domain);
      console.log(`Kept existing ${existing.confidence} data for ${result.domain} (new: ${result.confidence})`);
    }
  } else {
    // Insert new publisher
    const stmt = db.prepare(`
      INSERT INTO publishers (
        domain, guest_post_price, link_insertion_price, sponsored_post_price,
        homepage_link_price, casino_price, casino_accepted, currency,
        contact_email, contact_name, source_account, confidence, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      result.domain,
      result.guest_post_price,
      result.link_insertion_price,
      result.sponsored_post_price,
      result.homepage_link_price,
      result.casino_price,
      result.casino_accepted || 'no',
      result.currency || 'USD',
      contactEmail,
      contactName,
      result.account,
      result.confidence,
      result.notes
    );
  }
}

/**
 * Get all publishers with optional filtering
 * @param {Object} options - Filter options
 * @returns {Array} Publishers array
 */
function getPublishers(options = {}) {
  let query = 'SELECT * FROM publishers WHERE 1=1';
  const params = [];

  // Search filter
  if (options.search) {
    query += ' AND (domain LIKE ? OR contact_email LIKE ? OR contact_name LIKE ?)';
    const searchTerm = `%${options.search}%`;
    params.push(searchTerm, searchTerm, searchTerm);
  }

  // Casino accepted filter
  if (options.casinoAccepted !== undefined && options.casinoAccepted !== 'all') {
    query += ' AND casino_accepted = ?';
    params.push(options.casinoAccepted);
  }

  // Guest post price range filters
  if (options.minPrice) {
    query += ' AND guest_post_price >= ?';
    params.push(options.minPrice);
  }
  if (options.maxPrice) {
    query += ' AND guest_post_price <= ?';
    params.push(options.maxPrice);
  }

  // Link insertion price range filters
  if (options.minLiPrice) {
    query += ' AND link_insertion_price >= ?';
    params.push(options.minLiPrice);
  }
  if (options.maxLiPrice) {
    query += ' AND link_insertion_price <= ?';
    params.push(options.maxLiPrice);
  }

  // Casino price range filters
  if (options.minCasinoPrice) {
    query += ' AND casino_price >= ?';
    params.push(options.minCasinoPrice);
  }
  if (options.maxCasinoPrice) {
    query += ' AND casino_price <= ?';
    params.push(options.maxCasinoPrice);
  }

  // Date range filters
  if (options.dateFrom) {
    query += ' AND last_updated >= ?';
    params.push(options.dateFrom);
  }
  if (options.dateTo) {
    query += ' AND last_updated <= ?';
    params.push(options.dateTo + ' 23:59:59');
  }

  // Favorites filter
  if (options.favoritesOnly) {
    query += ' AND is_favorite = 1';
  }

  // Sorting
  const sortColumn = options.sortBy || 'last_updated';
  const sortOrder = options.sortOrder === 'asc' ? 'ASC' : 'DESC';
  const validColumns = ['domain', 'guest_post_price', 'casino_price', 'last_updated', 'first_found', 'search_count'];
  if (validColumns.includes(sortColumn)) {
    query += ` ORDER BY ${sortColumn} ${sortOrder}`;
  } else {
    query += ' ORDER BY last_updated DESC';
  }

  // Pagination
  if (options.limit) {
    query += ' LIMIT ?';
    params.push(options.limit);
    if (options.offset) {
      query += ' OFFSET ?';
      params.push(options.offset);
    }
  }

  return db.prepare(query).all(...params);
}

/**
 * Get total publisher count for pagination
 * @param {Object} options - Filter options
 * @returns {number} Total count
 */
function getPublisherCount(options = {}) {
  let query = 'SELECT COUNT(*) as count FROM publishers WHERE 1=1';
  const params = [];

  if (options.search) {
    query += ' AND (domain LIKE ? OR contact_email LIKE ? OR contact_name LIKE ?)';
    const searchTerm = `%${options.search}%`;
    params.push(searchTerm, searchTerm, searchTerm);
  }

  if (options.casinoAccepted !== undefined && options.casinoAccepted !== 'all') {
    query += ' AND casino_accepted = ?';
    params.push(options.casinoAccepted);
  }

  if (options.minPrice) {
    query += ' AND guest_post_price >= ?';
    params.push(options.minPrice);
  }
  if (options.maxPrice) {
    query += ' AND guest_post_price <= ?';
    params.push(options.maxPrice);
  }

  if (options.minLiPrice) {
    query += ' AND link_insertion_price >= ?';
    params.push(options.minLiPrice);
  }
  if (options.maxLiPrice) {
    query += ' AND link_insertion_price <= ?';
    params.push(options.maxLiPrice);
  }

  if (options.minCasinoPrice) {
    query += ' AND casino_price >= ?';
    params.push(options.minCasinoPrice);
  }
  if (options.maxCasinoPrice) {
    query += ' AND casino_price <= ?';
    params.push(options.maxCasinoPrice);
  }

  if (options.dateFrom) {
    query += ' AND last_updated >= ?';
    params.push(options.dateFrom);
  }
  if (options.dateTo) {
    query += ' AND last_updated <= ?';
    params.push(options.dateTo + ' 23:59:59');
  }

  if (options.favoritesOnly) {
    query += ' AND is_favorite = 1';
  }

  return db.prepare(query).get(...params).count;
}

/**
 * Get a single publisher by domain
 * @param {string} domain - Domain name
 * @returns {Object|null} Publisher data
 */
function getPublisher(domain) {
  return db.prepare('SELECT * FROM publishers WHERE domain = ?').get(domain);
}

/**
 * Delete a publisher
 * @param {string} domain - Domain to delete
 */
function deletePublisher(domain) {
  db.prepare('DELETE FROM publishers WHERE domain = ?').run(domain);
}

/**
 * Toggle favorite status
 * @param {string} domain - Domain name
 * @returns {boolean} New favorite status
 */
function toggleFavorite(domain) {
  const publisher = getPublisher(domain);
  if (!publisher) return false;

  const newStatus = publisher.is_favorite ? 0 : 1;
  db.prepare('UPDATE publishers SET is_favorite = ? WHERE domain = ?').run(newStatus, domain);
  return newStatus === 1;
}

/**
 * Update publisher's last refreshed timestamp
 * @param {string} domain - Domain name
 */
function markRefreshed(domain) {
  db.prepare('UPDATE publishers SET last_refreshed = CURRENT_TIMESTAMP WHERE domain = ?').run(domain);
}

/**
 * Export all publishers to CSV
 * @param {Object} options - Filter options
 * @returns {string} CSV string
 */
function exportPublishersToCsv(options = {}) {
  const publishers = getPublishers(options);

  if (publishers.length === 0) {
    return '';
  }

  const headers = [
    'Domain',
    'Guest Post Price',
    'Link Insertion Price',
    'Casino Price',
    'Casino Accepted',
    'Currency',
    'Contact Email',
    'Contact Name',
    'Source Account',
    'Confidence',
    'First Found',
    'Last Updated',
    'Search Count',
    'Notes'
  ];

  const escapeCSV = (value) => {
    if (value === null || value === undefined) return '';
    const str = String(value);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const rows = publishers.map(p => [
    p.domain,
    p.guest_post_price,
    p.link_insertion_price,
    p.casino_price,
    p.casino_accepted,
    p.currency,
    p.contact_email,
    p.contact_name,
    p.source_account,
    p.confidence,
    p.first_found,
    p.last_updated,
    p.search_count,
    p.notes
  ].map(escapeCSV).join(','));

  return [headers.join(','), ...rows].join('\n');
}

/**
 * Get publisher statistics
 * @returns {Object} Stats object
 */
function getPublisherStats() {
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      COUNT(CASE WHEN casino_accepted = 'yes' THEN 1 END) as casino_count,
      AVG(guest_post_price) as avg_guest_post,
      MIN(guest_post_price) as min_guest_post,
      MAX(guest_post_price) as max_guest_post,
      AVG(casino_price) as avg_casino,
      COUNT(CASE WHEN is_favorite = 1 THEN 1 END) as favorites
    FROM publishers
  `).get();

  return stats;
}

// ============================================
// TASK FUNCTIONS
// ============================================

/**
 * Create a new task with domains
 * @param {string} name - Task name
 * @param {Array<string>} domains - Array of domain names
 * @returns {Object} Created task with id
 */
function createTask(name, domains) {
  const stmt = db.prepare(`
    INSERT INTO tasks (name, total_domains, status)
    VALUES (?, ?, 'pending')
  `);
  const result = stmt.run(name, domains.length);
  const taskId = result.lastInsertRowid;

  // Insert domains
  const insertDomain = db.prepare(`
    INSERT INTO task_domains (task_id, domain, status)
    VALUES (?, ?, 'pending')
  `);

  const insertMany = db.transaction((domains) => {
    for (const domain of domains) {
      insertDomain.run(taskId, domain.trim().toLowerCase());
    }
  });
  insertMany(domains);

  return { id: taskId, name, total_domains: domains.length, status: 'pending' };
}

/**
 * Get all tasks with optional filtering
 * @param {Object} options - Filter options
 * @returns {Array} Tasks array
 */
function getTasks(options = {}) {
  let query = 'SELECT * FROM tasks WHERE 1=1';
  const params = [];

  if (options.status && options.status !== 'all') {
    query += ' AND status = ?';
    params.push(options.status);
  }

  if (options.search) {
    query += ' AND name LIKE ?';
    params.push(`%${options.search}%`);
  }

  query += ' ORDER BY created_at DESC';

  if (options.limit) {
    query += ' LIMIT ?';
    params.push(options.limit);
    if (options.offset) {
      query += ' OFFSET ?';
      params.push(options.offset);
    }
  }

  return db.prepare(query).all(...params);
}

/**
 * Get a single task by ID
 * @param {number} taskId - Task ID
 * @returns {Object|null} Task data
 */
function getTask(taskId) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
}

/**
 * Get all domains for a task
 * @param {number} taskId - Task ID
 * @param {string} status - Optional status filter
 * @returns {Array} Task domains
 */
function getTaskDomains(taskId, status = null) {
  if (status) {
    return db.prepare('SELECT * FROM task_domains WHERE task_id = ? AND status = ? ORDER BY id').all(taskId, status);
  }
  return db.prepare('SELECT * FROM task_domains WHERE task_id = ? ORDER BY id').all(taskId);
}

/**
 * Update task status
 * @param {number} taskId - Task ID
 * @param {string} status - New status
 */
function updateTaskStatus(taskId, status) {
  const updates = { status };

  if (status === 'running') {
    db.prepare('UPDATE tasks SET status = ?, started_at = COALESCE(started_at, CURRENT_TIMESTAMP), paused_at = NULL WHERE id = ?')
      .run(status, taskId);
  } else if (status === 'paused') {
    db.prepare('UPDATE tasks SET status = ?, paused_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(status, taskId);
  } else if (status === 'completed' || status === 'cancelled') {
    db.prepare('UPDATE tasks SET status = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(status, taskId);
  } else {
    db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, taskId);
  }
}

/**
 * Update a task domain's status and result
 * @param {number} domainId - Task domain ID
 * @param {string} status - New status
 * @param {Object} result - Optional result data
 */
function updateTaskDomain(domainId, status, result = null) {
  if (status === 'running') {
    db.prepare('UPDATE task_domains SET status = ?, started_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(status, domainId);
  } else if (status === 'completed' && result) {
    db.prepare(`
      UPDATE task_domains SET
        status = ?,
        guest_post_price = ?,
        casino_price = ?,
        currency = ?,
        contact_email = ?,
        confidence = ?,
        completed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(status, result.guest_post_price, result.casino_price, result.currency, result.source_email, result.confidence, domainId);
  } else if (status === 'failed') {
    db.prepare('UPDATE task_domains SET status = ?, error_message = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(status, result?.error || 'Unknown error', domainId);
  } else {
    db.prepare('UPDATE task_domains SET status = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(status, domainId);
  }
}

/**
 * Increment task progress counters
 * @param {number} taskId - Task ID
 * @param {string} type - 'successful' or 'failed'
 */
function incrementTaskProgress(taskId, type) {
  if (type === 'successful') {
    db.prepare('UPDATE tasks SET completed_domains = completed_domains + 1, successful_domains = successful_domains + 1 WHERE id = ?')
      .run(taskId);
  } else if (type === 'failed') {
    db.prepare('UPDATE tasks SET completed_domains = completed_domains + 1, failed_domains = failed_domains + 1 WHERE id = ?')
      .run(taskId);
  }
}

/**
 * Reset failed domains to pending for retry
 * @param {number} taskId - Task ID
 * @returns {number} Number of domains reset
 */
function retryFailedDomains(taskId) {
  const result = db.prepare(`
    UPDATE task_domains
    SET status = 'pending', error_message = NULL, started_at = NULL, completed_at = NULL
    WHERE task_id = ? AND status = 'failed'
  `).run(taskId);

  // Update task counters
  db.prepare(`
    UPDATE tasks
    SET completed_domains = completed_domains - ?,
        failed_domains = 0,
        status = CASE WHEN status = 'completed' THEN 'pending' ELSE status END
    WHERE id = ?
  `).run(result.changes, taskId);

  return result.changes;
}

/**
 * Mark remaining pending domains as skipped (for cancel)
 * @param {number} taskId - Task ID
 */
function skipRemainingDomains(taskId) {
  db.prepare(`
    UPDATE task_domains
    SET status = 'skipped', completed_at = CURRENT_TIMESTAMP
    WHERE task_id = ? AND status IN ('pending', 'running')
  `).run(taskId);
}

/**
 * Delete a task and its domains
 * @param {number} taskId - Task ID
 */
function deleteTask(taskId) {
  db.prepare('DELETE FROM task_domains WHERE task_id = ?').run(taskId);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
}

/**
 * Get task count
 * @param {Object} options - Filter options
 * @returns {number} Total count
 */
function getTaskCount(options = {}) {
  let query = 'SELECT COUNT(*) as count FROM tasks WHERE 1=1';
  const params = [];

  if (options.status && options.status !== 'all') {
    query += ' AND status = ?';
    params.push(options.status);
  }

  return db.prepare(query).get(...params).count;
}

/**
 * Export task results to CSV
 * @param {number} taskId - Task ID
 * @returns {string} CSV string
 */
function exportTaskToCsv(taskId) {
  const domains = getTaskDomains(taskId);

  if (domains.length === 0) return '';

  const headers = ['Domain', 'Status', 'Guest Post Price', 'Casino Price', 'Currency', 'Contact Email', 'Confidence', 'Error'];

  const escapeCSV = (value) => {
    if (value === null || value === undefined) return '';
    const str = String(value);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const rows = domains.map(d => [
    d.domain,
    d.status,
    d.guest_post_price,
    d.casino_price,
    d.currency,
    d.contact_email,
    d.confidence,
    d.error_message
  ].map(escapeCSV).join(','));

  return [headers.join(','), ...rows].join('\n');
}

module.exports = {
  init,
  createSession,
  saveResult,
  completeSession,
  getResults,
  getSession,
  exportToCsv,
  close,
  // Publisher functions
  savePublisher,
  getPublishers,
  getPublisherCount,
  getPublisher,
  deletePublisher,
  toggleFavorite,
  markRefreshed,
  exportPublishersToCsv,
  getPublisherStats,
  // Task functions
  createTask,
  getTasks,
  getTask,
  getTaskDomains,
  updateTaskStatus,
  updateTaskDomain,
  incrementTaskProgress,
  retryFailedDomains,
  skipRemainingDomains,
  deleteTask,
  getTaskCount,
  exportTaskToCsv
};
