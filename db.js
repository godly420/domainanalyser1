/**
 * Database module for Domain Price Searcher
 * PostgreSQL version - stores search sessions, results, and publisher master list
 */

const { Pool } = require('pg');

// Connection string from environment variable
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/price_scraper';

let pool;

/**
 * Initialize database and create tables
 */
async function init() {
  try {
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });

    // Test connection
    await pool.query('SELECT NOW()');
    console.log('Database connected:', DATABASE_URL.replace(/:[^:@]+@/, ':****@'));

    // Search sessions table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS search_sessions (
        id TEXT PRIMARY KEY,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        domains_count INTEGER DEFAULT 0,
        results_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'running'
      )
    `);

    // Search results table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS search_results (
        id SERIAL PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES search_sessions(id),
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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Publishers master table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS publishers (
        id SERIAL PRIMARY KEY,
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
        first_found TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_refreshed TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        search_count INTEGER DEFAULT 1,
        is_favorite INTEGER DEFAULT 0,
        tags TEXT,
        last_task_id INTEGER
      )
    `);

    // Tasks table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        total_domains INTEGER DEFAULT 0,
        completed_domains INTEGER DEFAULT 0,
        successful_domains INTEGER DEFAULT 0,
        no_result_domains INTEGER DEFAULT 0,
        failed_domains INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        started_at TIMESTAMP,
        completed_at TIMESTAMP,
        paused_at TIMESTAMP
      )
    `);

    // Task domains table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS task_domains (
        id SERIAL PRIMARY KEY,
        task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        domain TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        guest_post_price REAL,
        casino_price REAL,
        currency TEXT,
        contact_email TEXT,
        confidence TEXT,
        error_message TEXT,
        started_at TIMESTAMP,
        completed_at TIMESTAMP
      )
    `);

    // Users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP
      )
    `);

    // Sessions table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NOT NULL
      )
    `);

    // Indexes
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_results_session ON search_results(session_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_results_domain ON search_results(domain)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_publishers_domain ON publishers(domain)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_publishers_updated ON publishers(last_updated)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_task_domains_task ON task_domains(task_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_task_domains_status ON task_domains(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`);

    console.log('Database initialized successfully');
    return pool;
  } catch (error) {
    console.error('Database init error:', error);
    throw error;
  }
}

/**
 * Create a new search session
 */
async function createSession(sessionId, domainsCount) {
  await pool.query(
    `INSERT INTO search_sessions (id, domains_count, status) VALUES ($1, $2, 'running')`,
    [sessionId, domainsCount]
  );
}

/**
 * Save a search result
 */
async function saveResult(sessionId, result) {
  await pool.query(
    `INSERT INTO search_results (
      session_id, domain, guest_post_price, link_insertion_price,
      sponsored_post_price, homepage_link_price, casino_price, casino_accepted,
      currency, source_email, subject, account, confidence, notes
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
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
    ]
  );

  await pool.query(
    `UPDATE search_sessions SET results_count = results_count + 1 WHERE id = $1`,
    [sessionId]
  );
}

/**
 * Mark session as complete
 */
async function completeSession(sessionId) {
  await pool.query(
    `UPDATE search_sessions SET status = 'complete' WHERE id = $1`,
    [sessionId]
  );
}

/**
 * Get all results for a session
 */
async function getResults(sessionId) {
  const result = await pool.query(
    `SELECT * FROM search_results WHERE session_id = $1 ORDER BY created_at`,
    [sessionId]
  );
  return result.rows;
}

/**
 * Get session info
 */
async function getSession(sessionId) {
  const result = await pool.query(
    `SELECT * FROM search_sessions WHERE id = $1`,
    [sessionId]
  );
  return result.rows[0];
}

/**
 * Export results to CSV format
 */
async function exportToCsv(sessionId) {
  const results = await getResults(sessionId);

  if (results.length === 0) {
    return '';
  }

  const headers = [
    'Domain', 'Guest Post Price', 'Link Insertion Price', 'Sponsored Post Price',
    'Homepage Link Price', 'Casino Price', 'Casino Accepted', 'Currency',
    'Contact Email', 'Source Account', 'Subject', 'Confidence', 'Notes'
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
    r.domain, r.guest_post_price, r.link_insertion_price, r.sponsored_post_price,
    r.homepage_link_price, r.casino_price, r.casino_accepted, r.currency,
    r.source_email, r.account, r.subject, r.confidence, r.notes
  ].map(escapeCSV).join(','));

  return [headers.join(','), ...rows].join('\n');
}

/**
 * Close database connection
 */
async function close() {
  if (pool) {
    await pool.end();
  }
}

// ============================================
// PUBLISHER FUNCTIONS
// ============================================

/**
 * Save or update a publisher in the master list
 */
async function savePublisher(result, taskId = null) {
  if (!result || !result.domain) {
    console.log('savePublisher: No domain provided, skipping');
    return;
  }

  const contactName = result.source_email ?
    result.source_email.match(/^([^<]+)</)?.[1]?.trim() || null : null;
  const contactEmail = result.source_email ?
    result.source_email.match(/<([^>]+)>/)?.[1] || result.source_email : result.source_email;

  const existingResult = await pool.query('SELECT * FROM publishers WHERE domain = $1', [result.domain]);
  const existing = existingResult.rows[0];

  const hasNewPricing = result.guest_post_price || result.link_insertion_price ||
    result.sponsored_post_price || result.homepage_link_price || result.casino_price;

  if (existing) {
    const confidenceRank = { 'high': 3, 'medium': 2, 'low': 1 };
    const existingRank = confidenceRank[existing.confidence] || 0;
    const newRank = confidenceRank[result.confidence] || 0;

    const shouldUpdatePricing = hasNewPricing && (
      newRank >= existingRank || existing.guest_post_price === null
    );

    if (shouldUpdatePricing) {
      await pool.query(`
        UPDATE publishers SET
          guest_post_price = COALESCE($1, guest_post_price),
          link_insertion_price = COALESCE($2, link_insertion_price),
          sponsored_post_price = COALESCE($3, sponsored_post_price),
          homepage_link_price = COALESCE($4, homepage_link_price),
          casino_price = COALESCE($5, casino_price),
          casino_accepted = COALESCE($6, casino_accepted),
          currency = COALESCE($7, currency),
          contact_email = COALESCE($8, contact_email),
          contact_name = COALESCE($9, contact_name),
          source_account = COALESCE($10, source_account),
          confidence = COALESCE($11, confidence),
          notes = COALESCE($12, notes),
          last_updated = CURRENT_TIMESTAMP,
          last_refreshed = CURRENT_TIMESTAMP,
          search_count = search_count + 1,
          last_task_id = COALESCE($13, last_task_id)
        WHERE domain = $14
      `, [
        result.guest_post_price, result.link_insertion_price, result.sponsored_post_price,
        result.homepage_link_price, result.casino_price, result.casino_accepted,
        result.currency, contactEmail, contactName, result.account,
        result.confidence, result.notes, taskId, result.domain
      ]);
    } else {
      await pool.query(`
        UPDATE publishers SET
          last_refreshed = CURRENT_TIMESTAMP,
          search_count = search_count + 1,
          last_task_id = COALESCE($1, last_task_id)
        WHERE domain = $2
      `, [taskId, result.domain]);
      if (hasNewPricing) {
        console.log(`Kept existing ${existing.confidence} data for ${result.domain} (new: ${result.confidence})`);
      }
    }
  } else {
    await pool.query(`
      INSERT INTO publishers (
        domain, guest_post_price, link_insertion_price, sponsored_post_price,
        homepage_link_price, casino_price, casino_accepted, currency,
        contact_email, contact_name, source_account, confidence, notes, last_task_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    `, [
      result.domain,
      result.guest_post_price || null,
      result.link_insertion_price || null,
      result.sponsored_post_price || null,
      result.homepage_link_price || null,
      result.casino_price || null,
      result.casino_accepted || 'unknown',
      result.currency || 'USD',
      contactEmail || null,
      contactName || null,
      result.account || null,
      result.confidence || null,
      result.notes || null,
      taskId
    ]);
    console.log(`Added new publisher: ${result.domain} (${hasNewPricing ? 'with pricing' : 'no pricing - for outreach'})`);
  }
}

/**
 * Get all publishers with optional filtering
 */
async function getPublishers(options = {}) {
  let query = `
    SELECT p.*, t.name as task_name
    FROM publishers p
    LEFT JOIN tasks t ON p.last_task_id = t.id
    WHERE 1=1`;
  const params = [];
  let paramIndex = 1;

  if (options.search) {
    query += ` AND (p.domain LIKE $${paramIndex} OR p.contact_email LIKE $${paramIndex} OR p.contact_name LIKE $${paramIndex})`;
    params.push(`%${options.search}%`);
    paramIndex++;
  }

  if (options.casinoAccepted !== undefined && options.casinoAccepted !== 'all') {
    query += ` AND p.casino_accepted = $${paramIndex}`;
    params.push(options.casinoAccepted);
    paramIndex++;
  }

  if (options.minPrice) {
    query += ` AND p.guest_post_price >= $${paramIndex}`;
    params.push(options.minPrice);
    paramIndex++;
  }
  if (options.maxPrice) {
    query += ` AND p.guest_post_price <= $${paramIndex}`;
    params.push(options.maxPrice);
    paramIndex++;
  }

  if (options.minLiPrice) {
    query += ` AND p.link_insertion_price >= $${paramIndex}`;
    params.push(options.minLiPrice);
    paramIndex++;
  }
  if (options.maxLiPrice) {
    query += ` AND p.link_insertion_price <= $${paramIndex}`;
    params.push(options.maxLiPrice);
    paramIndex++;
  }

  if (options.minCasinoPrice) {
    query += ` AND p.casino_price >= $${paramIndex}`;
    params.push(options.minCasinoPrice);
    paramIndex++;
  }
  if (options.maxCasinoPrice) {
    query += ` AND p.casino_price <= $${paramIndex}`;
    params.push(options.maxCasinoPrice);
    paramIndex++;
  }

  if (options.dateFrom) {
    query += ` AND p.last_updated >= $${paramIndex}`;
    params.push(options.dateFrom);
    paramIndex++;
  }
  if (options.dateTo) {
    query += ` AND p.last_updated <= $${paramIndex}`;
    params.push(options.dateTo + ' 23:59:59');
    paramIndex++;
  }

  if (options.favoritesOnly) {
    query += ' AND p.is_favorite = 1';
  }

  if (options.hasPrice === 'yes') {
    query += ' AND (p.guest_post_price IS NOT NULL OR p.link_insertion_price IS NOT NULL OR p.casino_price IS NOT NULL)';
  } else if (options.hasPrice === 'no') {
    query += ' AND p.guest_post_price IS NULL AND p.link_insertion_price IS NULL AND p.casino_price IS NULL';
  }

  if (options.taskId) {
    query += ` AND p.last_task_id = $${paramIndex}`;
    params.push(options.taskId);
    paramIndex++;
  }

  const sortColumn = options.sortBy || 'last_updated';
  const sortOrder = options.sortOrder === 'asc' ? 'ASC' : 'DESC';
  const validColumns = ['domain', 'guest_post_price', 'casino_price', 'last_updated', 'first_found', 'search_count'];
  if (validColumns.includes(sortColumn)) {
    query += ` ORDER BY p.${sortColumn} ${sortOrder}`;
  } else {
    query += ' ORDER BY p.last_updated DESC';
  }

  if (options.limit) {
    query += ` LIMIT $${paramIndex}`;
    params.push(options.limit);
    paramIndex++;
    if (options.offset) {
      query += ` OFFSET $${paramIndex}`;
      params.push(options.offset);
      paramIndex++;
    }
  }

  const result = await pool.query(query, params);
  return result.rows;
}

/**
 * Get total publisher count for pagination
 */
async function getPublisherCount(options = {}) {
  let query = 'SELECT COUNT(*) as count FROM publishers WHERE 1=1';
  const params = [];
  let paramIndex = 1;

  if (options.search) {
    query += ` AND (domain LIKE $${paramIndex} OR contact_email LIKE $${paramIndex} OR contact_name LIKE $${paramIndex})`;
    params.push(`%${options.search}%`);
    paramIndex++;
  }

  if (options.casinoAccepted !== undefined && options.casinoAccepted !== 'all') {
    query += ` AND casino_accepted = $${paramIndex}`;
    params.push(options.casinoAccepted);
    paramIndex++;
  }

  if (options.minPrice) {
    query += ` AND guest_post_price >= $${paramIndex}`;
    params.push(options.minPrice);
    paramIndex++;
  }
  if (options.maxPrice) {
    query += ` AND guest_post_price <= $${paramIndex}`;
    params.push(options.maxPrice);
    paramIndex++;
  }

  if (options.minLiPrice) {
    query += ` AND link_insertion_price >= $${paramIndex}`;
    params.push(options.minLiPrice);
    paramIndex++;
  }
  if (options.maxLiPrice) {
    query += ` AND link_insertion_price <= $${paramIndex}`;
    params.push(options.maxLiPrice);
    paramIndex++;
  }

  if (options.minCasinoPrice) {
    query += ` AND casino_price >= $${paramIndex}`;
    params.push(options.minCasinoPrice);
    paramIndex++;
  }
  if (options.maxCasinoPrice) {
    query += ` AND casino_price <= $${paramIndex}`;
    params.push(options.maxCasinoPrice);
    paramIndex++;
  }

  if (options.dateFrom) {
    query += ` AND last_updated >= $${paramIndex}`;
    params.push(options.dateFrom);
    paramIndex++;
  }
  if (options.dateTo) {
    query += ` AND last_updated <= $${paramIndex}`;
    params.push(options.dateTo + ' 23:59:59');
    paramIndex++;
  }

  if (options.favoritesOnly) {
    query += ' AND is_favorite = 1';
  }

  if (options.hasPrice === 'yes') {
    query += ' AND (guest_post_price IS NOT NULL OR link_insertion_price IS NOT NULL OR casino_price IS NOT NULL)';
  } else if (options.hasPrice === 'no') {
    query += ' AND guest_post_price IS NULL AND link_insertion_price IS NULL AND casino_price IS NULL';
  }

  if (options.taskId) {
    query += ` AND last_task_id = $${paramIndex}`;
    params.push(options.taskId);
    paramIndex++;
  }

  const result = await pool.query(query, params);
  return parseInt(result.rows[0].count);
}

/**
 * Get a single publisher by domain
 */
async function getPublisher(domain) {
  const result = await pool.query('SELECT * FROM publishers WHERE domain = $1', [domain]);
  return result.rows[0];
}

/**
 * Delete a publisher
 */
async function deletePublisher(domain) {
  await pool.query('DELETE FROM publishers WHERE domain = $1', [domain]);
}

/**
 * Toggle favorite status
 */
async function toggleFavorite(domain) {
  const publisher = await getPublisher(domain);
  if (!publisher) return false;

  const newStatus = publisher.is_favorite ? 0 : 1;
  await pool.query('UPDATE publishers SET is_favorite = $1 WHERE domain = $2', [newStatus, domain]);
  return newStatus === 1;
}

/**
 * Update publisher's last refreshed timestamp
 */
async function markRefreshed(domain) {
  await pool.query('UPDATE publishers SET last_refreshed = CURRENT_TIMESTAMP WHERE domain = $1', [domain]);
}

/**
 * Export all publishers to CSV
 */
async function exportPublishersToCsv(options = {}) {
  const publishers = await getPublishers(options);

  if (publishers.length === 0) {
    return '';
  }

  const headers = [
    'Domain', 'Guest Post Price', 'Link Insertion Price', 'Casino Price',
    'Casino Accepted', 'Currency', 'Contact Email', 'Contact Name',
    'Source Account', 'Confidence', 'First Found', 'Last Updated', 'Search Count', 'Notes'
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
    p.domain, p.guest_post_price, p.link_insertion_price, p.casino_price,
    p.casino_accepted, p.currency, p.contact_email, p.contact_name,
    p.source_account, p.confidence, p.first_found, p.last_updated, p.search_count, p.notes
  ].map(escapeCSV).join(','));

  return [headers.join(','), ...rows].join('\n');
}

/**
 * Get publisher statistics
 */
async function getPublisherStats() {
  const result = await pool.query(`
    SELECT
      COUNT(*) as total,
      COUNT(CASE WHEN casino_accepted = 'yes' THEN 1 END) as casino_count,
      AVG(guest_post_price) as avg_guest_post,
      MIN(guest_post_price) as min_guest_post,
      MAX(guest_post_price) as max_guest_post,
      AVG(casino_price) as avg_casino,
      COUNT(CASE WHEN is_favorite = 1 THEN 1 END) as favorites
    FROM publishers
  `);
  return result.rows[0];
}

// ============================================
// TASK FUNCTIONS
// ============================================

/**
 * Create a new task with domains
 */
async function createTask(name, domains) {
  const taskResult = await pool.query(
    `INSERT INTO tasks (name, total_domains, status) VALUES ($1, $2, 'pending') RETURNING id`,
    [name, domains.length]
  );
  const taskId = taskResult.rows[0].id;

  for (const domain of domains) {
    await pool.query(
      `INSERT INTO task_domains (task_id, domain, status) VALUES ($1, $2, 'pending')`,
      [taskId, domain.trim().toLowerCase()]
    );
  }

  return { id: taskId, name, total_domains: domains.length, status: 'pending' };
}

/**
 * Get all tasks with optional filtering
 */
async function getTasks(options = {}) {
  let query = 'SELECT * FROM tasks WHERE 1=1';
  const params = [];
  let paramIndex = 1;

  if (options.status && options.status !== 'all') {
    query += ` AND status = $${paramIndex}`;
    params.push(options.status);
    paramIndex++;
  }

  if (options.search) {
    query += ` AND name LIKE $${paramIndex}`;
    params.push(`%${options.search}%`);
    paramIndex++;
  }

  query += ' ORDER BY created_at DESC';

  if (options.limit) {
    query += ` LIMIT $${paramIndex}`;
    params.push(options.limit);
    paramIndex++;
    if (options.offset) {
      query += ` OFFSET $${paramIndex}`;
      params.push(options.offset);
      paramIndex++;
    }
  }

  const result = await pool.query(query, params);
  return result.rows;
}

/**
 * Get a single task by ID
 */
async function getTask(taskId) {
  const result = await pool.query('SELECT * FROM tasks WHERE id = $1', [taskId]);
  return result.rows[0];
}

/**
 * Get all domains for a task
 */
async function getTaskDomains(taskId, status = null) {
  if (status) {
    const result = await pool.query(
      'SELECT * FROM task_domains WHERE task_id = $1 AND status = $2 ORDER BY id',
      [taskId, status]
    );
    return result.rows;
  }
  const result = await pool.query(
    'SELECT * FROM task_domains WHERE task_id = $1 ORDER BY id',
    [taskId]
  );
  return result.rows;
}

/**
 * Update task status
 */
async function updateTaskStatus(taskId, status) {
  if (status === 'running') {
    await pool.query(
      'UPDATE tasks SET status = $1, started_at = COALESCE(started_at, CURRENT_TIMESTAMP), paused_at = NULL WHERE id = $2',
      [status, taskId]
    );
  } else if (status === 'paused') {
    await pool.query(
      'UPDATE tasks SET status = $1, paused_at = CURRENT_TIMESTAMP WHERE id = $2',
      [status, taskId]
    );
  } else if (status === 'completed' || status === 'cancelled') {
    await pool.query(
      'UPDATE tasks SET status = $1, completed_at = CURRENT_TIMESTAMP WHERE id = $2',
      [status, taskId]
    );
  } else {
    await pool.query('UPDATE tasks SET status = $1 WHERE id = $2', [status, taskId]);
  }
}

/**
 * Update a task domain's status and result
 */
async function updateTaskDomain(domainId, status, result = null) {
  if (status === 'running') {
    await pool.query(
      'UPDATE task_domains SET status = $1, started_at = CURRENT_TIMESTAMP WHERE id = $2',
      [status, domainId]
    );
  } else if (status === 'completed' && result) {
    await pool.query(`
      UPDATE task_domains SET
        status = $1,
        guest_post_price = $2,
        casino_price = $3,
        currency = $4,
        contact_email = $5,
        confidence = $6,
        completed_at = CURRENT_TIMESTAMP
      WHERE id = $7
    `, [status, result.guest_post_price, result.casino_price, result.currency, result.source_email, result.confidence, domainId]);
  } else if (status === 'no_result') {
    await pool.query(
      'UPDATE task_domains SET status = $1, completed_at = CURRENT_TIMESTAMP WHERE id = $2',
      [status, domainId]
    );
  } else if (status === 'failed') {
    await pool.query(
      'UPDATE task_domains SET status = $1, error_message = $2, completed_at = CURRENT_TIMESTAMP WHERE id = $3',
      [status, result?.error || 'Unknown error', domainId]
    );
  } else {
    await pool.query(
      'UPDATE task_domains SET status = $1, completed_at = CURRENT_TIMESTAMP WHERE id = $2',
      [status, domainId]
    );
  }
}

/**
 * Increment task progress counters
 */
async function incrementTaskProgress(taskId, type) {
  if (type === 'successful') {
    await pool.query(
      'UPDATE tasks SET completed_domains = completed_domains + 1, successful_domains = successful_domains + 1 WHERE id = $1',
      [taskId]
    );
  } else if (type === 'no_result') {
    await pool.query(
      'UPDATE tasks SET completed_domains = completed_domains + 1, no_result_domains = no_result_domains + 1 WHERE id = $1',
      [taskId]
    );
  } else if (type === 'failed') {
    await pool.query(
      'UPDATE tasks SET completed_domains = completed_domains + 1, failed_domains = failed_domains + 1 WHERE id = $1',
      [taskId]
    );
  }
}

/**
 * Reset failed domains to pending for retry
 */
async function retryFailedDomains(taskId) {
  const result = await pool.query(`
    UPDATE task_domains
    SET status = 'pending', error_message = NULL, started_at = NULL, completed_at = NULL
    WHERE task_id = $1 AND status = 'failed'
  `, [taskId]);

  const changes = result.rowCount;

  await pool.query(`
    UPDATE tasks
    SET completed_domains = completed_domains - $1,
        failed_domains = 0,
        status = CASE WHEN status = 'completed' THEN 'pending' ELSE status END
    WHERE id = $2
  `, [changes, taskId]);

  return changes;
}

/**
 * Mark remaining pending domains as skipped (for cancel)
 */
async function skipRemainingDomains(taskId) {
  await pool.query(`
    UPDATE task_domains
    SET status = 'skipped', completed_at = CURRENT_TIMESTAMP
    WHERE task_id = $1 AND status IN ('pending', 'running')
  `, [taskId]);
}

/**
 * Delete a task and its domains
 */
async function deleteTask(taskId) {
  await pool.query('DELETE FROM task_domains WHERE task_id = $1', [taskId]);
  await pool.query('DELETE FROM tasks WHERE id = $1', [taskId]);
}

/**
 * Get task count
 */
async function getTaskCount(options = {}) {
  let query = 'SELECT COUNT(*) as count FROM tasks WHERE 1=1';
  const params = [];
  let paramIndex = 1;

  if (options.status && options.status !== 'all') {
    query += ` AND status = $${paramIndex}`;
    params.push(options.status);
    paramIndex++;
  }

  const result = await pool.query(query, params);
  return parseInt(result.rows[0].count);
}

/**
 * Export task results to CSV
 */
async function exportTaskToCsv(taskId) {
  const domains = await getTaskDomains(taskId);

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
    d.domain, d.status, d.guest_post_price, d.casino_price,
    d.currency, d.contact_email, d.confidence, d.error_message
  ].map(escapeCSV).join(','));

  return [headers.join(','), ...rows].join('\n');
}

// ============================================
// USER/AUTH FUNCTIONS
// ============================================

/**
 * Create a new user
 */
async function createUser(username, passwordHash) {
  const result = await pool.query(
    `INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id`,
    [username, passwordHash]
  );
  return { id: result.rows[0].id, username };
}

/**
 * Get user by username
 */
async function getUserByUsername(username) {
  const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  return result.rows[0];
}

/**
 * Get user by ID
 */
async function getUserById(userId) {
  const result = await pool.query(
    'SELECT id, username, created_at, last_login FROM users WHERE id = $1',
    [userId]
  );
  return result.rows[0];
}

/**
 * Update user's last login time
 */
async function updateLastLogin(userId) {
  await pool.query('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1', [userId]);
}

/**
 * Create a session
 */
async function createAuthSession(sessionId, userId, expiresInHours = 24) {
  const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString();
  await pool.query(
    `INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)`,
    [sessionId, userId, expiresAt]
  );
}

/**
 * Get session with user data
 */
async function getAuthSession(sessionId) {
  const result = await pool.query(`
    SELECT s.*, u.username
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.id = $1 AND s.expires_at > NOW()
  `, [sessionId]);
  return result.rows[0];
}

/**
 * Delete a session (logout)
 */
async function deleteAuthSession(sessionId) {
  await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
}

/**
 * Clean up expired sessions
 */
async function cleanupExpiredSessions() {
  await pool.query("DELETE FROM sessions WHERE expires_at < NOW()");
}

/**
 * Get user count
 */
async function getUserCount() {
  const result = await pool.query('SELECT COUNT(*) as count FROM users');
  return parseInt(result.rows[0].count);
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
  exportTaskToCsv,
  // User/Auth functions
  createUser,
  getUserByUsername,
  getUserById,
  updateLastLogin,
  createAuthSession,
  getAuthSession,
  deleteAuthSession,
  cleanupExpiredSessions,
  getUserCount
};
