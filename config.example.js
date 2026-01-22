/**
 * Configuration file for the price scraper application
 * 
 * SETUP INSTRUCTIONS:
 * 1. Copy this file and rename to: config.js
 * 2. Fill in your OpenAI API key
 * 3. Update email accounts to your team's emails
 */

module.exports = {
  /**
   * Email accounts to monitor for price information
   * Add all your team's Gmail addresses here
   */
  emailAccounts: [
    'your-email1@example.com',
    'your-email2@example.com',
    // Add more accounts as needed
  ],

  /**
   * OpenAI API configuration
   */
  openai: {
    /**
     * Get your API key from: https://platform.openai.com/api-keys
     */
    apiKey: 'YOUR_OPENAI_API_KEY_HERE',

    /**
     * Model to use (gpt-4o-mini is fast and cheap)
     */
    model: 'gpt-4o-mini'
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
