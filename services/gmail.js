const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

/**
 * Creates and returns a GoogleAuth instance for Gmail API access
 * Supports credentials from environment variable (base64 encoded) or file
 * @param {string} email - The email address to impersonate using domain-wide delegation
 * @returns {GoogleAuth} Configured GoogleAuth instance
 */
function getAuth(email) {
  let authConfig = {
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    clientOptions: {
      subject: email
    }
  };

  // Check for credentials in environment variable (base64 encoded JSON)
  if (process.env.GOOGLE_CREDENTIALS) {
    const credentials = JSON.parse(
      Buffer.from(process.env.GOOGLE_CREDENTIALS, 'base64').toString('utf-8')
    );
    authConfig.credentials = credentials;
  } else {
    // Fall back to file
    authConfig.keyFile = path.join(__dirname, '../credentials.json');
  }

  const auth = new google.auth.GoogleAuth(authConfig);
  return auth;
}

/**
 * Searches for emails in Gmail based on a query
 * @param {string} account - Email account to search
 * @param {string} query - Gmail search query (e.g., 'from:example@example.com')
 * @param {number} maxResults - Maximum number of results to return (default: 100)
 * @returns {Promise<Array<{id: string, threadId: string}>>} Array of message objects
 */
async function searchEmails(account, query, maxResults = 100) {
  try {
    const auth = getAuth(account);
    const gmail = google.gmail({ version: 'v1', auth });

    const response = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: maxResults
    });

    // Return empty array if no messages found
    if (!response.data.messages) {
      return [];
    }

    return response.data.messages;
  } catch (error) {
    console.error(`Error searching emails for ${account}:`, error.message);
    throw new Error(`Failed to search emails: ${error.message}`);
  }
}

/**
 * Recursively extracts body text and attachments from email message parts
 * @param {object} gmail - Gmail API client instance
 * @param {string} account - Email account
 * @param {string} messageId - Message ID
 * @param {object} payload - Message payload or part
 * @param {object} email - Email object to populate with body and attachments
 * @returns {Promise<void>}
 */
async function extractParts(gmail, account, messageId, payload, email) {
  // Handle multipart messages
  if (payload.parts) {
    for (const part of payload.parts) {
      await extractParts(gmail, account, messageId, part, email);
    }
    return;
  }

  const mimeType = payload.mimeType;
  const filename = payload.filename;

  // Extract text/plain body content
  if (mimeType === 'text/plain' && payload.body && payload.body.data) {
    const decodedBody = Buffer.from(payload.body.data, 'base64').toString('utf-8');

    // Append to existing body (in case there are multiple text parts)
    if (email.body) {
      email.body += '\n\n' + decodedBody;
    } else {
      email.body = decodedBody;
    }
  }

  // Extract attachments
  if (filename && payload.body && payload.body.attachmentId) {
    try {
      const attachment = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId: messageId,
        id: payload.body.attachmentId
      });

      email.attachments.push({
        filename: filename,
        mimeType: mimeType,
        data: attachment.data.data // Base64 encoded data
      });
    } catch (error) {
      console.error(`Error fetching attachment ${filename}:`, error.message);
      // Continue processing other attachments even if one fails
    }
  }
}

/**
 * Fetches a complete email with all attachments
 * @param {string} account - Email account
 * @param {string} messageId - Message ID to fetch
 * @returns {Promise<{id: string, from: string, subject: string, date: string, body: string, attachments: Array}>}
 */
async function getEmailWithAttachments(account, messageId) {
  try {
    const auth = getAuth(account);
    const gmail = google.gmail({ version: 'v1', auth });

    // Fetch the full message
    const response = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full'
    });

    const message = response.data;
    const payload = message.payload;
    const headers = payload.headers;

    // Extract relevant headers
    const fromHeader = headers.find(h => h.name.toLowerCase() === 'from');
    const subjectHeader = headers.find(h => h.name.toLowerCase() === 'subject');
    const dateHeader = headers.find(h => h.name.toLowerCase() === 'date');

    // Initialize email object
    const email = {
      id: messageId,
      from: fromHeader ? fromHeader.value : '',
      subject: subjectHeader ? subjectHeader.value : '',
      date: dateHeader ? dateHeader.value : '',
      body: '',
      attachments: []
    };

    // Extract body and attachments recursively
    await extractParts(gmail, account, messageId, payload, email);

    // If no text/plain body was found, try text/html as fallback
    if (!email.body && payload.body && payload.body.data) {
      email.body = Buffer.from(payload.body.data, 'base64').toString('utf-8');
    }

    return email;
  } catch (error) {
    console.error(`Error fetching email ${messageId} for ${account}:`, error.message);
    throw new Error(`Failed to fetch email: ${error.message}`);
  }
}

module.exports = {
  getAuth,
  searchEmails,
  getEmailWithAttachments,
  extractParts
};
