/**
 * Domain Price Searcher - Frontend Application
 * Handles domain input, SSE streaming, and live results display
 * Persists search state across page navigation
 */

// State
let currentSessionId = null;
let eventSource = null;
let resultsCount = 0;
let searchResults = [];
let searchStatus = 'idle'; // idle, running, complete
let totalDomains = 0;
let searchedDomains = 0;

// LocalStorage keys
const STORAGE_KEYS = {
  SESSION_ID: 'priceSearch_sessionId',
  RESULTS: 'priceSearch_results',
  STATUS: 'priceSearch_status',
  TOTAL: 'priceSearch_total',
  SEARCHED: 'priceSearch_searched',
  DOMAINS_INPUT: 'priceSearch_domainsInput'
};

// DOM Elements
const domainsInput = document.getElementById('domains');
const csvFileInput = document.getElementById('csv-file');
const searchBtn = document.getElementById('search-btn');
const clearBtn = document.getElementById('clear-btn');
const progressSection = document.getElementById('progress-section');
const progressText = document.getElementById('progress-text');
const resultsCountEl = document.getElementById('results-count');
const progressFill = document.getElementById('progress-fill');
const resultsSection = document.getElementById('results-section');
const resultsBody = document.getElementById('results-body');
const exportBtn = document.getElementById('export-btn');
const noResults = document.getElementById('no-results');
const resultsBadge = document.getElementById('results-badge');
const statFound = document.getElementById('stat-found');
const searchStats = document.getElementById('search-stats');

/**
 * Save state to localStorage
 */
function saveState() {
  localStorage.setItem(STORAGE_KEYS.SESSION_ID, currentSessionId || '');
  localStorage.setItem(STORAGE_KEYS.RESULTS, JSON.stringify(searchResults));
  localStorage.setItem(STORAGE_KEYS.STATUS, searchStatus);
  localStorage.setItem(STORAGE_KEYS.TOTAL, totalDomains);
  localStorage.setItem(STORAGE_KEYS.SEARCHED, searchedDomains);
  localStorage.setItem(STORAGE_KEYS.DOMAINS_INPUT, domainsInput.value);

  // Also save session ID to URL for persistence across force refresh
  if (currentSessionId) {
    const url = new URL(window.location);
    url.searchParams.set('session', currentSessionId);
    window.history.replaceState({}, '', url);
  }
}

/**
 * Load state from localStorage
 */
function loadState() {
  currentSessionId = localStorage.getItem(STORAGE_KEYS.SESSION_ID) || null;
  searchResults = JSON.parse(localStorage.getItem(STORAGE_KEYS.RESULTS) || '[]');
  searchStatus = localStorage.getItem(STORAGE_KEYS.STATUS) || 'idle';
  totalDomains = parseInt(localStorage.getItem(STORAGE_KEYS.TOTAL) || '0');
  searchedDomains = parseInt(localStorage.getItem(STORAGE_KEYS.SEARCHED) || '0');

  // Check URL for session ID if not in localStorage (handles force refresh)
  if (!currentSessionId) {
    const urlParams = new URLSearchParams(window.location.search);
    const urlSessionId = urlParams.get('session');
    if (urlSessionId) {
      currentSessionId = urlSessionId;
      searchStatus = 'unknown'; // Will be determined by server
    }
  }

  const savedInput = localStorage.getItem(STORAGE_KEYS.DOMAINS_INPUT);
  if (savedInput) {
    domainsInput.value = savedInput;
    updateDomainCount();
  }
}

/**
 * Clear saved state
 */
function clearState() {
  Object.values(STORAGE_KEYS).forEach(key => localStorage.removeItem(key));
  currentSessionId = null;
  searchResults = [];
  searchStatus = 'idle';
  totalDomains = 0;
  searchedDomains = 0;
}

/**
 * Restore UI from saved state
 */
async function restoreUI() {
  if (!currentSessionId && searchStatus === 'idle') {
    return; // Nothing to restore
  }

  // If we have a session but no results (or unknown status from URL), try to fetch from server
  if (currentSessionId && (searchResults.length === 0 || searchStatus === 'unknown')) {
    try {
      const statusRes = await fetch(`/api/search/${currentSessionId}/status`);

      if (!statusRes.ok) {
        // Session not found on server, clear state
        clearState();
        // Clear URL param
        const url = new URL(window.location);
        url.searchParams.delete('session');
        window.history.replaceState({}, '', url);
        return;
      }

      const statusData = await statusRes.json();

      if (statusData.status === 'complete') {
        // Fetch results from server
        const resultsRes = await fetch(`/api/search/${currentSessionId}/results`);
        const resultsData = await resultsRes.json();

        if (resultsData.results && resultsData.results.length > 0) {
          searchResults = resultsData.results;
          searchedDomains = statusData.searched || statusData.domainsCount;
          totalDomains = statusData.domainsCount;
          searchStatus = 'complete';
          saveState();
        } else {
          // No results found
          searchedDomains = statusData.domainsCount;
          totalDomains = statusData.domainsCount;
          searchStatus = 'complete';
          saveState();
        }
      } else if (statusData.status === 'running') {
        // Search still running, reconnect
        totalDomains = statusData.domainsCount;
        searchedDomains = statusData.searched || 0;
        searchStatus = 'running';
        connectSSE(currentSessionId);
        setSearchingUI();
        renderCurrentState();
        return;
      }
    } catch (e) {
      console.log('Could not restore session from server:', e);
      // Session might have expired, reset
      clearState();
      // Clear URL param
      const url = new URL(window.location);
      url.searchParams.delete('session');
      window.history.replaceState({}, '', url);
      return;
    }
  }

  renderCurrentState();
}

/**
 * Render current state to UI
 */
function renderCurrentState() {
  resultsCount = searchResults.length;

  // Show results section
  if (searchResults.length > 0 || searchStatus !== 'idle') {
    resultsSection.style.display = 'block';
    progressSection.style.display = 'block';
    if (searchStats) searchStats.style.display = 'flex';
  }

  // Render saved results
  resultsBody.innerHTML = '';
  searchResults.forEach(result => addResultRow(result, false));

  // Update counters
  resultsCountEl.textContent = `${resultsCount} results found`;
  if (resultsBadge) resultsBadge.textContent = `${resultsCount} domain${resultsCount !== 1 ? 's' : ''}`;
  if (statFound) statFound.textContent = resultsCount;

  // Update progress
  updateProgress(searchedDomains, totalDomains);

  // Enable export if we have results
  if (searchResults.length > 0) {
    exportBtn.disabled = false;
  }

  // Show appropriate state
  if (searchStatus === 'complete') {
    searchComplete();
    if (resultsCount === 0) {
      noResults.style.display = 'block';
    }
  } else if (searchStatus === 'running' && currentSessionId) {
    // Try to reconnect
    fetch(`/api/search/${currentSessionId}/status`)
      .then(res => res.json())
      .then(data => {
        if (data.status === 'running') {
          connectSSE(currentSessionId);
          setSearchingUI();
        } else {
          searchStatus = 'complete';
          saveState();
          searchComplete();
        }
      })
      .catch(() => {
        searchStatus = 'complete';
        saveState();
        searchComplete();
      });
  }
}

/**
 * Update domain count in textarea
 */
function updateDomainCount() {
  const domains = domainsInput.value.split(/[\n,]/).filter(d => d.trim().length > 0 && d.includes('.'));
  const domainCount = document.getElementById('domain-count');
  if (domainCount) {
    domainCount.textContent = `${domains.length} domain${domains.length !== 1 ? 's' : ''}`;
  }
}

/**
 * Parse domains from textarea
 */
function parseDomainsFromText(text) {
  return text
    .split(/[\n,]/)
    .map(d => d.trim().toLowerCase())
    .filter(d => d.length > 0 && d.includes('.'));
}

/**
 * Parse domains from CSV file
 */
function parseCSVFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target.result;
      const lines = text.split(/[\n\r]+/);
      const domains = [];

      lines.forEach(line => {
        // Get first column (domain)
        const columns = line.split(',');
        if (columns[0]) {
          const domain = columns[0].trim().toLowerCase().replace(/^["']|["']$/g, '');
          if (domain.includes('.') && !domain.startsWith('#')) {
            domains.push(domain);
          }
        }
      });

      resolve(domains);
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

/**
 * Set UI to searching state
 */
function setSearchingUI() {
  searchBtn.querySelector('.btn-content').style.display = 'none';
  searchBtn.querySelector('.btn-loading').style.display = 'inline-flex';
  searchBtn.disabled = true;
}

/**
 * Start search
 */
async function startSearch() {
  // Get domains from textarea or file
  let domains = [];

  if (csvFileInput.files.length > 0) {
    domains = await parseCSVFile(csvFileInput.files[0]);
  } else {
    domains = parseDomainsFromText(domainsInput.value);
  }

  if (domains.length === 0) {
    alert('Please enter at least one domain to search');
    return;
  }

  // Reset state for new search
  searchResults = [];
  resultsCount = 0;
  totalDomains = domains.length;
  searchedDomains = 0;
  searchStatus = 'running';

  // Update UI
  setSearchingUI();
  progressSection.style.display = 'block';
  resultsSection.style.display = 'block';
  resultsBody.innerHTML = '';
  noResults.style.display = 'none';
  if (searchStats) searchStats.style.display = 'flex';
  updateProgress(0, domains.length);

  try {
    // Start search
    const response = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domains })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Search failed');
    }

    currentSessionId = data.sessionId;
    saveState();

    // Connect to SSE stream
    connectSSE(currentSessionId);

  } catch (error) {
    console.error('Search error:', error);
    alert('Error starting search: ' + error.message);
    searchStatus = 'idle';
    saveState();
    resetUI();
  }
}

/**
 * Connect to SSE stream for live updates
 */
let statusCheckInterval = null;

function connectSSE(sessionId) {
  eventSource = new EventSource(`/api/search/${sessionId}/stream`);

  // Start polling for status as a fallback (in case SSE complete event is missed)
  startStatusPolling(sessionId);

  eventSource.addEventListener('result', (e) => {
    const result = JSON.parse(e.data);

    // Check if we already have this result (in case of reconnect)
    const exists = searchResults.some(r => r.domain === result.domain);
    if (!exists) {
      searchResults.push(result);
      addResultRow(result);
      resultsCount = searchResults.length;
      resultsCountEl.textContent = `${resultsCount} results found`;
      if (resultsBadge) resultsBadge.textContent = `${resultsCount} domain${resultsCount !== 1 ? 's' : ''}`;
      if (statFound) statFound.textContent = resultsCount;
      exportBtn.disabled = false;
      saveState();
    }
  });

  eventSource.addEventListener('progress', (e) => {
    const { searched, total } = JSON.parse(e.data);
    searchedDomains = searched;
    totalDomains = total;
    updateProgress(searched, total);
    saveState();
  });

  eventSource.addEventListener('complete', () => {
    stopStatusPolling();
    eventSource.close();
    searchStatus = 'complete';
    saveState();
    searchComplete();
  });

  eventSource.onerror = () => {
    // Don't immediately mark as complete on error - check status first
    checkSessionStatus(sessionId);
  };
}

/**
 * Start polling session status as fallback
 */
function startStatusPolling(sessionId) {
  stopStatusPolling();
  statusCheckInterval = setInterval(() => {
    checkSessionStatus(sessionId);
  }, 5000); // Check every 5 seconds
}

/**
 * Stop status polling
 */
function stopStatusPolling() {
  if (statusCheckInterval) {
    clearInterval(statusCheckInterval);
    statusCheckInterval = null;
  }
}

/**
 * Check session status from server
 */
function checkSessionStatus(sessionId) {
  if (searchStatus !== 'running') return;

  fetch(`/api/search/${sessionId}/status`)
    .then(res => res.json())
    .then(data => {
      if (data.status === 'complete') {
        stopStatusPolling();
        if (eventSource) {
          eventSource.close();
        }
        searchStatus = 'complete';
        saveState();
        searchComplete();
      }
    })
    .catch(() => {
      // Session might have expired, mark as complete
      stopStatusPolling();
      if (eventSource) {
        eventSource.close();
      }
      searchStatus = 'complete';
      saveState();
      searchComplete();
    });
}

/**
 * Update progress display
 */
function updateProgress(searched, total) {
  const percent = total > 0 ? Math.round((searched / total) * 100) : 0;
  progressText.textContent = `Searching: ${searched} / ${total} domains`;
  progressFill.style.width = `${percent}%`;

  // Update stats header
  const statSearched = document.getElementById('stat-searched');
  if (statSearched) statSearched.textContent = searched;

  const progressPercent = document.getElementById('progress-percent');
  if (progressPercent) progressPercent.textContent = `${percent}%`;
}

/**
 * Add a result row to the table
 */
function addResultRow(result, animate = true) {
  const row = document.createElement('tr');
  row.className = animate ? 'result-row new' : 'result-row';

  // Format source account to show just the name part (e.g., "denis" from "denis@instalinkers.com")
  const accountName = result.account ? result.account.split('@')[0] : '-';

  // Style casino status
  const casinoStatus = (result.casino_accepted || 'no').toLowerCase();
  const casinoClass = casinoStatus === 'yes' ? 'casino-yes' : 'casino-no';
  const casinoStyle = casinoStatus === 'yes'
    ? 'background: rgba(16, 185, 129, 0.2); color: #34d399;'
    : 'background: rgba(239, 68, 68, 0.2); color: #f87171;';

  row.innerHTML = `
    <td class="domain-cell">${escapeHtml(result.domain)}</td>
    <td class="price-cell">${formatPrice(result.guest_post_price, result.currency)}</td>
    <td class="price-cell">${formatPrice(result.link_insertion_price, result.currency)}</td>
    <td class="price-cell">${formatPrice(result.casino_price, result.currency)}</td>
    <td><span class="casino-cell ${casinoClass}" style="${casinoStyle}">${escapeHtml(casinoStatus)}</span></td>
    <td class="currency-cell">${escapeHtml(result.currency || 'USD')}</td>
    <td><span class="account-cell">${escapeHtml(accountName)}</span></td>
    <td class="contact-cell" title="${escapeHtml(result.source_email || '-')}">${escapeHtml(result.source_email || '-')}</td>
  `;

  resultsBody.appendChild(row);  // Append to maintain user's domain order

  // Remove 'new' class after animation
  if (animate) {
    setTimeout(() => row.classList.remove('new'), 500);
  }
}

/**
 * Search complete handler
 */
function searchComplete() {
  searchBtn.querySelector('.btn-content').style.display = 'inline-flex';
  searchBtn.querySelector('.btn-loading').style.display = 'none';
  searchBtn.disabled = false;

  if (resultsCount === 0) {
    noResults.style.display = 'block';
  }
}

/**
 * Reset UI to initial state
 */
function resetUI() {
  searchBtn.querySelector('.btn-content').style.display = 'inline-flex';
  searchBtn.querySelector('.btn-loading').style.display = 'none';
  searchBtn.disabled = false;
}

/**
 * Clear all inputs and results
 */
function clearAll() {
  domainsInput.value = '';
  csvFileInput.value = '';
  resultsBody.innerHTML = '';
  progressSection.style.display = 'none';
  resultsSection.style.display = 'none';
  noResults.style.display = 'none';
  exportBtn.disabled = true;
  resultsCount = 0;

  // Clear saved state
  clearState();

  // Clear URL parameter
  const url = new URL(window.location);
  url.searchParams.delete('session');
  window.history.replaceState({}, '', url);

  // Reset new UI elements
  if (resultsBadge) resultsBadge.textContent = '0 domains';
  if (statFound) statFound.textContent = '0';
  if (searchStats) searchStats.style.display = 'none';

  // Reset file dropzone
  const dropzone = document.getElementById('file-dropzone');
  const fileSelected = document.getElementById('file-selected');
  if (dropzone) dropzone.style.display = 'flex';
  if (fileSelected) fileSelected.style.display = 'none';

  // Reset domain count
  const domainCount = document.getElementById('domain-count');
  if (domainCount) domainCount.textContent = '0 domains';

  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }

  stopStatusPolling();
}

/**
 * Export results to CSV
 */
function exportCSV() {
  if (!currentSessionId) return;
  window.location.href = `/api/search/${currentSessionId}/export`;
}

// Exchange rates to EUR
const exchangeRatesToEUR = {
  'USD': 0.92,
  'GBP': 1.17,
  'INR': 0.011,
  'AUD': 0.61,
  'CAD': 0.68,
  'EUR': 1.00
};

/**
 * Format price for display - converts to EUR
 */
function formatPrice(price, currency) {
  if (price === null || price === undefined) return '-';

  // Convert to EUR
  const rate = exchangeRatesToEUR[currency] || exchangeRatesToEUR['USD'] || 1;
  const priceInEUR = Math.round(price * rate);

  // Show EUR with original currency if different
  if (currency && currency !== 'EUR' && currency !== 'USD') {
    const currencySymbols = { 'GBP': '£', 'INR': '₹', 'AUD': 'A$', 'CAD': 'C$' };
    const origSymbol = currencySymbols[currency] || currency;
    return `€${priceInEUR.toLocaleString()} (${origSymbol}${price})`;
  }

  return '€' + priceInEUR.toLocaleString();
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Event Listeners
searchBtn.addEventListener('click', startSearch);
clearBtn.addEventListener('click', clearAll);
exportBtn.addEventListener('click', exportCSV);

// File upload handler
csvFileInput.addEventListener('change', async (e) => {
  if (e.target.files.length > 0) {
    try {
      const domains = await parseCSVFile(e.target.files[0]);
      domainsInput.value = domains.join('\n');
      saveState();
      updateDomainCount();
    } catch (error) {
      alert('Error reading file: ' + error.message);
    }
  }
});

// Save input on change
domainsInput.addEventListener('input', () => {
  saveState();
  updateDomainCount();
});

// Enter key to search
domainsInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.ctrlKey) {
    startSearch();
  }
});

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  loadState();
  restoreUI();
});

console.log('Domain Price Searcher loaded');
