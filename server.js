/**
 * Domain Price Searcher Server
 * Simple API for searching domains and streaming results via SSE
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const path = require('path');
const db = require('./db');
const { searchDomains, searchDomain } = require('./services/domain-searcher');
const config = require('./config');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cookieParser());

// ============================================
// AUTHENTICATION MIDDLEWARE & ROUTES
// ============================================

// Public paths that don't require auth
const publicPaths = ['/login.html', '/api/auth/login', '/api/auth/setup-required'];

// Auth middleware
function requireAuth(req, res, next) {
  // Allow public paths
  if (publicPaths.some(p => req.path === p || req.path.startsWith('/api/auth/'))) {
    return next();
  }

  // Check for session cookie
  const sessionId = req.cookies.session;
  if (!sessionId) {
    // For API requests, return 401
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    // For page requests, redirect to login
    return res.redirect('/login.html');
  }

  // Validate session
  const session = db.getAuthSession(sessionId);
  if (!session) {
    res.clearCookie('session');
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Session expired' });
    }
    return res.redirect('/login.html');
  }

  // Attach user info to request
  req.user = { id: session.user_id, username: session.username };
  next();
}

// Apply auth middleware before static files
app.use(requireAuth);

// Serve static files (after auth check)
app.use(express.static('public'));

// Default admin credentials from environment or fallback
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// Create default admin user on startup if not exists (called after db.init)
async function ensureAdminUser() {
  const existingAdmin = db.getUserByUsername(ADMIN_USERNAME);
  if (!existingAdmin) {
    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    db.createUser(ADMIN_USERNAME, passwordHash);
    console.log(`Created admin user: ${ADMIN_USERNAME}`);
  }
}

// Check if setup is required (no users exist) - always false now since we have predefined admin
app.get('/api/auth/setup-required', (req, res) => {
  res.json({ setupRequired: false });
});

// Login with predefined admin credentials
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    // Find user
    const user = db.getUserByUsername(username);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Create session - long expiry (30 days) but cookie is session-based
    const sessionId = uuidv4();
    db.createAuthSession(sessionId, user.id, 24 * 30); // 30 days in DB
    db.updateLastLogin(user.id);

    // Set session cookie (no maxAge = expires when browser closes)
    res.cookie('session', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax'
      // No maxAge = session cookie, expires when browser closes
    });

    res.json({ success: true, username: user.username });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  const sessionId = req.cookies.session;
  if (sessionId) {
    db.deleteAuthSession(sessionId);
    res.clearCookie('session');
  }
  res.json({ success: true });
});

// Get current user
app.get('/api/auth/me', (req, res) => {
  if (req.user) {
    res.json({ user: req.user });
  } else {
    res.status(401).json({ error: 'Not authenticated' });
  }
});

// Redirect root to index.html (handled after auth)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================
// END AUTHENTICATION
// ============================================

// Store active SSE connections by session ID
const sseConnections = new Map();

// Store active search sessions
const activeSessions = new Map();

// Store active task runners for pause/cancel control
const taskRunners = new Map();

// Store SSE connections for tasks
const taskSseConnections = new Map();

// Task queue - only one task runs at a time
let currentRunningTaskId = null;

/**
 * Check if any task is currently running
 */
function isAnyTaskRunning() {
  return currentRunningTaskId !== null && taskRunners.has(currentRunningTaskId);
}

/**
 * Get the next queued task and start it
 */
function startNextQueuedTask() {
  // Find the oldest queued task
  const tasks = db.getTasks({ status: 'queued' });
  if (tasks && tasks.length > 0) {
    const nextTask = tasks[0];
    console.log(`Starting next queued task: ${nextTask.id}`);
    runTask(nextTask.id);
  }
}

/**
 * POST /api/search
 * Start a new domain search
 * Body: { domains: ["example.com", "test.com"] }
 */
app.post('/api/search', async (req, res) => {
  try {
    const { domains } = req.body;

    if (!domains || !Array.isArray(domains) || domains.length === 0) {
      return res.status(400).json({ error: 'Please provide an array of domains' });
    }

    // Clean and dedupe domains
    const cleanDomains = [...new Set(
      domains
        .map(d => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, ''))
        .filter(d => d.length > 0)
    )];

    if (cleanDomains.length === 0) {
      return res.status(400).json({ error: 'No valid domains provided' });
    }

    // Create session
    const sessionId = uuidv4();
    db.createSession(sessionId, cleanDomains.length);

    // Store session info
    activeSessions.set(sessionId, {
      domains: cleanDomains,
      searched: 0,
      results: [],
      status: 'running'
    });

    // Start search in background
    startSearch(sessionId, cleanDomains);

    res.json({
      sessionId,
      domainsCount: cleanDomains.length,
      message: 'Search started. Connect to /api/search/:sessionId/stream for live results.'
    });

  } catch (error) {
    console.error('Error starting search:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/search/:sessionId/stream
 * SSE endpoint for live results
 */
app.get('/api/search/:sessionId/stream', (req, res) => {
  const { sessionId } = req.params;

  const session = activeSessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Store connection
  sseConnections.set(sessionId, res);

  // Send any existing results
  session.results.forEach(result => {
    res.write(`event: result\ndata: ${JSON.stringify(result)}\n\n`);
  });

  // Send current progress
  res.write(`event: progress\ndata: ${JSON.stringify({ searched: session.searched, total: session.domains.length })}\n\n`);

  // If already complete, send complete event
  if (session.status === 'complete') {
    res.write(`event: complete\ndata: {}\n\n`);
  }

  // Handle client disconnect
  req.on('close', () => {
    sseConnections.delete(sessionId);
  });
});

/**
 * GET /api/search/:sessionId/export
 * Export results to CSV
 */
app.get('/api/search/:sessionId/export', (req, res) => {
  try {
    const { sessionId } = req.params;

    const csv = db.exportToCsv(sessionId);

    if (!csv) {
      return res.status(404).json({ error: 'No results found for this session' });
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="price-search-${sessionId.slice(0, 8)}.csv"`);
    res.send(csv);

  } catch (error) {
    console.error('Error exporting CSV:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/search/:sessionId/status
 * Get session status
 */
app.get('/api/search/:sessionId/status', (req, res) => {
  const { sessionId } = req.params;

  const session = activeSessions.get(sessionId) || db.getSession(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.json({
    sessionId,
    status: session.status,
    domainsCount: session.domains_count || session.domains?.length || 0,
    resultsCount: session.results_count || session.results?.length || 0,
    searched: session.searched || session.domains_count || 0
  });
});

/**
 * GET /api/search/:sessionId/results
 * Get all results for a session (for restoring state)
 */
app.get('/api/search/:sessionId/results', (req, res) => {
  try {
    const { sessionId } = req.params;
    const results = db.getResults(sessionId);
    res.json({ results });
  } catch (error) {
    console.error('Error fetching results:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// PUBLISHER API ENDPOINTS
// ============================================

/**
 * GET /api/publishers
 * Get all publishers with filtering and pagination
 */
app.get('/api/publishers', (req, res) => {
  try {
    const options = {
      search: req.query.search,
      casinoAccepted: req.query.casino,
      // Guest post price
      minPrice: req.query.minPrice ? parseFloat(req.query.minPrice) : undefined,
      maxPrice: req.query.maxPrice ? parseFloat(req.query.maxPrice) : undefined,
      // Link insertion price
      minLiPrice: req.query.minLiPrice ? parseFloat(req.query.minLiPrice) : undefined,
      maxLiPrice: req.query.maxLiPrice ? parseFloat(req.query.maxLiPrice) : undefined,
      // Casino price
      minCasinoPrice: req.query.minCasinoPrice ? parseFloat(req.query.minCasinoPrice) : undefined,
      maxCasinoPrice: req.query.maxCasinoPrice ? parseFloat(req.query.maxCasinoPrice) : undefined,
      // Date filters
      dateFrom: req.query.dateFrom || undefined,
      dateTo: req.query.dateTo || undefined,
      favoritesOnly: req.query.favorites === 'true',
      sortBy: req.query.sortBy,
      sortOrder: req.query.sortOrder,
      limit: req.query.limit ? parseInt(req.query.limit) : undefined,
      offset: req.query.offset ? parseInt(req.query.offset) : undefined
    };

    const publishers = db.getPublishers(options);
    const total = db.getPublisherCount(options);

    res.json({
      publishers,
      total,
      page: options.offset ? Math.floor(options.offset / (options.limit || 50)) + 1 : 1,
      pageSize: options.limit || publishers.length
    });
  } catch (error) {
    console.error('Error fetching publishers:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/publishers/stats
 * Get publisher statistics
 */
app.get('/api/publishers/stats', (req, res) => {
  try {
    const stats = db.getPublisherStats();
    res.json(stats);
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/publishers/export
 * Export publishers to CSV
 */
app.get('/api/publishers/export', (req, res) => {
  try {
    const options = {
      search: req.query.search,
      casinoAccepted: req.query.casino,
      // Guest post price
      minPrice: req.query.minPrice ? parseFloat(req.query.minPrice) : undefined,
      maxPrice: req.query.maxPrice ? parseFloat(req.query.maxPrice) : undefined,
      // Link insertion price
      minLiPrice: req.query.minLiPrice ? parseFloat(req.query.minLiPrice) : undefined,
      maxLiPrice: req.query.maxLiPrice ? parseFloat(req.query.maxLiPrice) : undefined,
      // Casino price
      minCasinoPrice: req.query.minCasinoPrice ? parseFloat(req.query.minCasinoPrice) : undefined,
      maxCasinoPrice: req.query.maxCasinoPrice ? parseFloat(req.query.maxCasinoPrice) : undefined,
      // Date filters
      dateFrom: req.query.dateFrom || undefined,
      dateTo: req.query.dateTo || undefined,
      favoritesOnly: req.query.favorites === 'true',
      sortBy: req.query.sortBy || 'domain',
      sortOrder: req.query.sortOrder || 'asc'
    };

    const csv = db.exportPublishersToCsv(options);

    if (!csv) {
      return res.status(404).json({ error: 'No publishers found' });
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="publishers-${new Date().toISOString().split('T')[0]}.csv"`);
    res.send(csv);
  } catch (error) {
    console.error('Error exporting publishers:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/publishers/:domain
 * Get a single publisher
 */
app.get('/api/publishers/:domain', (req, res) => {
  try {
    const domain = req.params.domain.toLowerCase();
    const publisher = db.getPublisher(domain);

    if (!publisher) {
      return res.status(404).json({ error: 'Publisher not found' });
    }

    res.json(publisher);
  } catch (error) {
    console.error('Error fetching publisher:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/publishers/:domain/refresh
 * Refresh a single publisher's pricing from emails
 */
app.post('/api/publishers/:domain/refresh', async (req, res) => {
  try {
    const domain = req.params.domain.toLowerCase();

    console.log(`Refreshing publisher: ${domain}`);

    // Search for the domain
    const accounts = config.emailAccounts;
    const result = await searchDomain(domain, accounts);

    if (result) {
      // Update publisher
      db.savePublisher(result);
      db.markRefreshed(domain);

      const updated = db.getPublisher(domain);
      res.json({
        success: true,
        message: 'Publisher refreshed successfully',
        publisher: updated
      });
    } else {
      // Just mark as refreshed even if no new data
      db.markRefreshed(domain);
      res.json({
        success: true,
        message: 'No new pricing found, last refreshed timestamp updated',
        publisher: db.getPublisher(domain)
      });
    }
  } catch (error) {
    console.error('Error refreshing publisher:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/publishers/:domain/favorite
 * Toggle favorite status
 */
app.post('/api/publishers/:domain/favorite', (req, res) => {
  try {
    const domain = req.params.domain.toLowerCase();
    const isFavorite = db.toggleFavorite(domain);

    res.json({
      success: true,
      domain,
      is_favorite: isFavorite
    });
  } catch (error) {
    console.error('Error toggling favorite:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/publishers/:domain
 * Delete a publisher
 */
app.delete('/api/publishers/:domain', (req, res) => {
  try {
    const domain = req.params.domain.toLowerCase();
    db.deletePublisher(domain);

    res.json({
      success: true,
      message: `Publisher ${domain} deleted`
    });
  } catch (error) {
    console.error('Error deleting publisher:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// TASK API ENDPOINTS
// ============================================

/**
 * GET /api/tasks
 * Get all tasks with filtering
 */
app.get('/api/tasks', (req, res) => {
  try {
    const options = {
      status: req.query.status,
      search: req.query.search,
      limit: req.query.limit ? parseInt(req.query.limit) : undefined,
      offset: req.query.offset ? parseInt(req.query.offset) : undefined
    };

    const tasks = db.getTasks(options);
    const total = db.getTaskCount(options);

    res.json({ tasks, total });
  } catch (error) {
    console.error('Error fetching tasks:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/tasks
 * Create a new task
 * Body: { name: "Task Name", domains: ["domain1.com", "domain2.com"] }
 */
app.post('/api/tasks', (req, res) => {
  try {
    let { name, domains } = req.body;

    if (!domains || !Array.isArray(domains) || domains.length === 0) {
      return res.status(400).json({ error: 'Please provide an array of domains' });
    }

    // Clean and dedupe domains
    const cleanDomains = [...new Set(
      domains
        .map(d => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, ''))
        .filter(d => d.length > 0)
    )];

    if (cleanDomains.length === 0) {
      return res.status(400).json({ error: 'No valid domains provided' });
    }

    // Auto-generate name if not provided
    if (!name) {
      const count = db.getTaskCount({}) + 1;
      name = `Task #${count}`;
    }

    const task = db.createTask(name, cleanDomains);

    res.json({
      success: true,
      task
    });
  } catch (error) {
    console.error('Error creating task:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/tasks/:id
 * Get a single task with its domains
 */
app.get('/api/tasks/:id', (req, res) => {
  try {
    const taskId = parseInt(req.params.id);
    const task = db.getTask(taskId);

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const domains = db.getTaskDomains(taskId);

    res.json({ task, domains });
  } catch (error) {
    console.error('Error fetching task:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/tasks/:id
 * Delete a task
 */
app.delete('/api/tasks/:id', (req, res) => {
  try {
    const taskId = parseInt(req.params.id);

    // Stop if running
    if (taskRunners.has(taskId)) {
      taskRunners.get(taskId).cancelled = true;
      taskRunners.delete(taskId);
    }

    db.deleteTask(taskId);

    res.json({ success: true, message: 'Task deleted' });
  } catch (error) {
    console.error('Error deleting task:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/tasks/:id/start
 * Start or resume a task (with queue support)
 */
app.post('/api/tasks/:id/start', async (req, res) => {
  try {
    const taskId = parseInt(req.params.id);
    const task = db.getTask(taskId);

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    if (task.status === 'running') {
      return res.status(400).json({ error: 'Task is already running' });
    }

    if (task.status === 'queued') {
      return res.status(400).json({ error: 'Task is already queued' });
    }

    // Check if another task is running
    if (isAnyTaskRunning()) {
      // Add to queue instead of starting immediately
      db.updateTaskStatus(taskId, 'queued');
      broadcastTaskUpdate(taskId);
      console.log(`Task ${taskId} added to queue (task ${currentRunningTaskId} is running)`);
      res.json({ success: true, message: 'Task added to queue', queued: true });
    } else {
      // Start the task immediately
      runTask(taskId);
      res.json({ success: true, message: 'Task started', queued: false });
    }
  } catch (error) {
    console.error('Error starting task:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/tasks/:id/pause
 * Pause a running task
 */
app.post('/api/tasks/:id/pause', (req, res) => {
  try {
    const taskId = parseInt(req.params.id);
    const task = db.getTask(taskId);

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    if (task.status !== 'running') {
      return res.status(400).json({ error: 'Task is not running' });
    }

    // Signal the runner to pause
    if (taskRunners.has(taskId)) {
      taskRunners.get(taskId).paused = true;
    }

    db.updateTaskStatus(taskId, 'paused');

    // Broadcast status change
    broadcastTaskUpdate(taskId);

    res.json({ success: true, message: 'Task paused' });
  } catch (error) {
    console.error('Error pausing task:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/tasks/:id/cancel
 * Cancel a task (or remove from queue)
 */
app.post('/api/tasks/:id/cancel', (req, res) => {
  try {
    const taskId = parseInt(req.params.id);
    const task = db.getTask(taskId);

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // If task was queued, just set back to pending (can be started later)
    if (task.status === 'queued') {
      db.updateTaskStatus(taskId, 'pending');
      broadcastTaskUpdate(taskId);
      res.json({ success: true, message: 'Task removed from queue' });
      return;
    }

    // Signal the runner to stop
    if (taskRunners.has(taskId)) {
      taskRunners.get(taskId).cancelled = true;
      taskRunners.delete(taskId);
    }

    // Clear current running task if this was it
    if (currentRunningTaskId === taskId) {
      currentRunningTaskId = null;
    }

    // Skip remaining domains
    db.skipRemainingDomains(taskId);
    db.updateTaskStatus(taskId, 'cancelled');

    // Broadcast status change
    broadcastTaskUpdate(taskId);

    // Start next queued task
    startNextQueuedTask();

    res.json({ success: true, message: 'Task cancelled' });
  } catch (error) {
    console.error('Error cancelling task:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/tasks/:id/retry-failed
 * Retry failed domains in a task
 */
app.post('/api/tasks/:id/retry-failed', (req, res) => {
  try {
    const taskId = parseInt(req.params.id);
    const task = db.getTask(taskId);

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const count = db.retryFailedDomains(taskId);

    res.json({
      success: true,
      message: `${count} domains queued for retry`,
      domainsRetried: count
    });
  } catch (error) {
    console.error('Error retrying failed domains:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/tasks/:id/stream
 * SSE endpoint for task progress updates
 */
app.get('/api/tasks/:id/stream', (req, res) => {
  const taskId = parseInt(req.params.id);
  const task = db.getTask(taskId);

  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Store connection
  if (!taskSseConnections.has(taskId)) {
    taskSseConnections.set(taskId, new Set());
  }
  taskSseConnections.get(taskId).add(res);

  // Send current state
  const domains = db.getTaskDomains(taskId);
  res.write(`event: init\ndata: ${JSON.stringify({ task: db.getTask(taskId), domains })}\n\n`);

  // Handle client disconnect
  req.on('close', () => {
    const connections = taskSseConnections.get(taskId);
    if (connections) {
      connections.delete(res);
      if (connections.size === 0) {
        taskSseConnections.delete(taskId);
      }
    }
  });
});

/**
 * GET /api/tasks/:id/export
 * Export task results to CSV
 */
app.get('/api/tasks/:id/export', (req, res) => {
  try {
    const taskId = parseInt(req.params.id);
    const task = db.getTask(taskId);

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const csv = db.exportTaskToCsv(taskId);

    if (!csv) {
      return res.status(404).json({ error: 'No results found' });
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="task-${taskId}-results.csv"`);
    res.send(csv);
  } catch (error) {
    console.error('Error exporting task:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Broadcast task update to all connected SSE clients
 */
function broadcastTaskUpdate(taskId) {
  const connections = taskSseConnections.get(taskId);
  if (!connections) return;

  const task = db.getTask(taskId);
  const domains = db.getTaskDomains(taskId);

  const data = JSON.stringify({ task, domains });

  connections.forEach(res => {
    res.write(`event: update\ndata: ${data}\n\n`);
  });
}

/**
 * Run a task - process domains one by one
 */
async function runTask(taskId) {
  const task = db.getTask(taskId);
  if (!task) return;

  // Track this as the current running task
  currentRunningTaskId = taskId;

  // Set up runner state
  taskRunners.set(taskId, { paused: false, cancelled: false });
  db.updateTaskStatus(taskId, 'running');
  broadcastTaskUpdate(taskId);

  const accounts = config.emailAccounts;
  const pendingDomains = db.getTaskDomains(taskId, 'pending');

  console.log(`Starting task ${taskId}: ${pendingDomains.length} domains to process`);

  for (const domainRecord of pendingDomains) {
    // Check for pause/cancel
    const runner = taskRunners.get(taskId);
    if (!runner || runner.cancelled) {
      console.log(`Task ${taskId} cancelled`);
      break;
    }
    if (runner.paused) {
      console.log(`Task ${taskId} paused`);
      break;
    }

    const domain = domainRecord.domain;
    console.log(`Task ${taskId}: Processing ${domain}`);

    // Mark domain as running
    db.updateTaskDomain(domainRecord.id, 'running');
    broadcastTaskUpdate(taskId);

    try {
      // Search for the domain
      const result = await searchDomain(domain, accounts);

      if (result) {
        // Update domain with result
        db.updateTaskDomain(domainRecord.id, 'completed', result);
        db.incrementTaskProgress(taskId, 'successful');

        // Also save to publisher master list
        db.savePublisher(result);

        console.log(`Task ${taskId}: Found price for ${domain}: ${result.guest_post_price} ${result.currency}`);
      } else {
        // No price found - mark as completed but with no data
        db.updateTaskDomain(domainRecord.id, 'completed', { guest_post_price: null });
        db.incrementTaskProgress(taskId, 'successful');
        console.log(`Task ${taskId}: No price found for ${domain}`);
      }
    } catch (error) {
      console.error(`Task ${taskId}: Error processing ${domain}:`, error.message);
      db.updateTaskDomain(domainRecord.id, 'failed', { error: error.message });
      db.incrementTaskProgress(taskId, 'failed');
    }

    // Broadcast progress
    broadcastTaskUpdate(taskId);
  }

  // Check final state
  const runner = taskRunners.get(taskId);
  if (runner && !runner.paused && !runner.cancelled) {
    // Task completed normally
    db.updateTaskStatus(taskId, 'completed');
    console.log(`Task ${taskId} completed`);
  }

  // Clean up runner
  taskRunners.delete(taskId);

  // Clear current running task
  if (currentRunningTaskId === taskId) {
    currentRunningTaskId = null;
  }

  // Final broadcast
  broadcastTaskUpdate(taskId);

  // Start the next queued task (if any)
  if (!runner?.paused) {
    // Only auto-start next if this task wasn't paused (user might want to resume it)
    startNextQueuedTask();
  }
}

/**
 * Start the domain search process
 */
function startSearch(sessionId, domains) {
  const session = activeSessions.get(sessionId);

  const onResult = (result) => {
    // Save to search results database
    db.saveResult(sessionId, result);

    // Save/update publisher master list
    db.savePublisher(result);

    // Store in session
    session.results.push(result);

    // Send to SSE client
    const connection = sseConnections.get(sessionId);
    if (connection) {
      connection.write(`event: result\ndata: ${JSON.stringify(result)}\n\n`);
    }

    console.log(`Found: ${result.domain} - GP: ${result.guest_post_price} ${result.currency}`);
  };

  const onProgress = (searched, total) => {
    session.searched = searched;

    // Send progress to SSE client
    const connection = sseConnections.get(sessionId);
    if (connection) {
      connection.write(`event: progress\ndata: ${JSON.stringify({ searched, total })}\n\n`);
    }
  };

  const onComplete = () => {
    session.status = 'complete';
    db.completeSession(sessionId);

    // Send complete event
    const connection = sseConnections.get(sessionId);
    if (connection) {
      connection.write(`event: complete\ndata: {}\n\n`);
    }

    console.log(`Search complete: ${session.results.length} results found`);
  };

  // Start the search
  searchDomains(domains, onResult, onProgress, onComplete).catch(error => {
    console.error('Search error:', error);
    session.status = 'error';
  });
}

/**
 * Initialize and start server
 */
async function startServer() {
  try {
    console.log('Starting Domain Price Searcher...');
    console.log('Environment:', process.env.NODE_ENV || 'development');
    console.log('Port:', PORT);

    console.log('Initializing database...');
    db.init();

    // Create admin user if not exists
    console.log('Setting up admin user...');
    await ensureAdminUser();

    app.listen(PORT, '0.0.0.0', () => {
      console.log('='.repeat(50));
      console.log(`Domain Price Searcher running at http://localhost:${PORT}`);
      console.log('='.repeat(50));
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down...');
  db.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Shutting down...');
  db.close();
  process.exit(0);
});

module.exports = app;
