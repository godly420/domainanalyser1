/**
 * Configuration file for the price scraper application
 * Uses environment variables in production, fallbacks for local development
 */

// Check if we're in production
const isProduction = process.env.NODE_ENV === 'production';

// Validate required env vars in production
if (isProduction) {
  const required = ['OPENAI_API_KEY'];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length > 0) {
    console.error('Missing required environment variables:', missing.join(', '));
  }
}

module.exports = {
  /**
   * Email accounts to monitor for price information
   * Set EMAIL_ACCOUNTS env var as comma-separated list
   */
  emailAccounts: process.env.EMAIL_ACCOUNTS
    ? process.env.EMAIL_ACCOUNTS.split(',').map(e => e.trim())
    : [
        // Local development fallbacks - replace with your emails
        'info@instalinkoteam.com',
        'sam@instalinkomailer.com',
        'jenny@instalinko-outreach.com',
        'denis@instalinkers.com'
      ],

  /**
   * OpenAI API configuration
   */
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini'
  },

  /**
   * Rate limiting configuration
   */
  rateLimit: {
    delayMs: 500
  },

  /**
   * Database configuration
   */
  database: {
    path: './prices.db'
  },

  /**
   * Path to Google API credentials file
   */
  credentialsPath: './credentials.json'
};
