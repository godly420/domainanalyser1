const pdfParse = require('pdf-parse');
const XLSX = require('xlsx');
const { parse: csvParse } = require('csv-parse/sync');
const mammoth = require('mammoth');
const { google } = require('googleapis');
const fs = require('fs').promises;

/**
 * Parse PDF buffer and extract text content
 * @param {Buffer} buffer - PDF file buffer
 * @returns {Promise<{type: string, text: string, pages: number, error?: string}>}
 */
async function parsePdf(buffer) {
  try {
    const data = await pdfParse(buffer);
    return {
      type: 'pdf',
      text: data.text.trim(),
      pages: data.numpages,
    };
  } catch (error) {
    console.error('PDF parsing error:', error.message);
    return {
      type: 'pdf',
      text: '',
      pages: 0,
      error: `Failed to parse PDF: ${error.message}`,
    };
  }
}

/**
 * Parse Excel buffer and extract text from all sheets
 * @param {Buffer} buffer - Excel file buffer
 * @returns {Promise<{type: string, text: string, sheets: Array<{name: string, rows: number}>, error?: string}>}
 */
async function parseExcel(buffer) {
  try {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheets = [];
    const textParts = [];

    workbook.SheetNames.forEach((sheetName) => {
      const worksheet = workbook.Sheets[sheetName];
      const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

      // Convert rows to text with | separator
      const sheetText = jsonData
        .map((row) => row.join(' | '))
        .filter((line) => line.trim().length > 0)
        .join('\n');

      if (sheetText) {
        textParts.push(`Sheet: ${sheetName}\n${sheetText}`);
        sheets.push({
          name: sheetName,
          rows: jsonData.length,
        });
      }
    });

    return {
      type: 'excel',
      text: textParts.join('\n\n'),
      sheets,
    };
  } catch (error) {
    console.error('Excel parsing error:', error.message);
    return {
      type: 'excel',
      text: '',
      sheets: [],
      error: `Failed to parse Excel: ${error.message}`,
    };
  }
}

/**
 * Parse CSV buffer and extract rows
 * @param {Buffer} buffer - CSV file buffer
 * @returns {Promise<{type: string, text: string, rows: number, error?: string}>}
 */
async function parseCsv(buffer) {
  try {
    const content = buffer.toString('utf-8');
    const records = csvParse(content, {
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    });

    const text = records
      .map((row) => row.join(' | '))
      .filter((line) => line.trim().length > 0)
      .join('\n');

    return {
      type: 'csv',
      text,
      rows: records.length,
    };
  } catch (error) {
    console.error('CSV parsing error:', error.message);
    return {
      type: 'csv',
      text: '',
      rows: 0,
      error: `Failed to parse CSV: ${error.message}`,
    };
  }
}

/**
 * Parse Word document buffer and extract text
 * @param {Buffer} buffer - Word document buffer
 * @returns {Promise<{type: string, text: string, error?: string}>}
 */
async function parseWord(buffer) {
  try {
    const result = await mammoth.extractRawText({ buffer });
    return {
      type: 'word',
      text: result.value.trim(),
    };
  } catch (error) {
    console.error('Word parsing error:', error.message);
    return {
      type: 'word',
      text: '',
      error: `Failed to parse Word document: ${error.message}`,
    };
  }
}

/**
 * Parse Google Sheets URL and extract data using service account
 * First tries direct access (for public sheets), then falls back to domain-wide delegation
 * @param {string} sheetUrl - Google Sheets URL
 * @param {string} authEmail - Email to impersonate (for domain-wide delegation fallback)
 * @returns {Promise<{type: string, text: string, sheetId: string, error?: string}>}
 */
async function parseGoogleSheet(sheetUrl, authEmail) {
  try {
    // Extract sheet ID from various Google Sheets URL formats
    const sheetIdMatch = sheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!sheetIdMatch) {
      throw new Error('Invalid Google Sheets URL format');
    }
    const sheetId = sheetIdMatch[1];

    // Load service account credentials
    const credentialsPath = './credentials.json';
    let credentials;
    try {
      const credentialsFile = await fs.readFile(credentialsPath, 'utf8');
      credentials = JSON.parse(credentialsFile);
    } catch (fileError) {
      throw new Error(`Failed to load credentials.json: ${fileError.message}`);
    }

    // Try direct service account access first (for public sheets)
    let auth = new google.auth.JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
      // No subject = direct service account access for public sheets
    });

    let sheets = google.sheets({ version: 'v4', auth });
    let spreadsheet;

    try {
      // Try direct access first (public sheets)
      spreadsheet = await sheets.spreadsheets.get({
        spreadsheetId: sheetId,
      });
      console.log(`Google Sheet ${sheetId} accessed directly (public sheet)`);
    } catch (directError) {
      // If direct access fails, try domain-wide delegation
      if (authEmail) {
        console.log(`Direct access failed, trying domain-wide delegation for ${sheetId}`);
        auth = new google.auth.JWT({
          email: credentials.client_email,
          key: credentials.private_key,
          scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
          subject: authEmail, // Impersonate user for domain sheets
        });
        sheets = google.sheets({ version: 'v4', auth });
        spreadsheet = await sheets.spreadsheets.get({
          spreadsheetId: sheetId,
        });
        console.log(`Google Sheet ${sheetId} accessed via domain-wide delegation`);
      } else {
        throw directError;
      }
    }

    const sheetNames = spreadsheet.data.sheets.map((sheet) => sheet.properties.title);
    const textParts = [];

    // Fetch data from all sheets
    for (const sheetName of sheetNames) {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: sheetName,
      });

      const rows = response.data.values || [];
      if (rows.length > 0) {
        const sheetText = rows
          .map((row) => row.join(' | '))
          .filter((line) => line.trim().length > 0)
          .join('\n');

        if (sheetText) {
          textParts.push(`Sheet: ${sheetName}\n${sheetText}`);
        }
      }
    }

    return {
      type: 'gsheet',
      text: textParts.join('\n\n'),
      sheetId,
    };
  } catch (error) {
    console.error('Google Sheets parsing error:', error.message);
    return {
      type: 'gsheet',
      text: '',
      sheetId: '',
      error: `Failed to parse Google Sheets: ${error.message}`,
    };
  }
}

/**
 * Find all Google Sheets URLs in text
 * @param {string} text - Text to search for Google Sheets URLs
 * @returns {Array<string>} Array of Google Sheets URLs found
 */
function findGoogleSheetUrls(text) {
  if (!text || typeof text !== 'string') {
    return [];
  }

  // Regex pattern to match various Google Sheets URL formats
  const patterns = [
    // Standard format: https://docs.google.com/spreadsheets/d/{id}/edit...
    /https?:\/\/docs\.google\.com\/spreadsheets\/d\/[a-zA-Z0-9-_]+(?:\/[^\s]*)?/g,
    // Short format: https://drive.google.com/open?id={id}
    /https?:\/\/drive\.google\.com\/open\?id=[a-zA-Z0-9-_]+/g,
  ];

  const urls = new Set();

  patterns.forEach((pattern) => {
    const matches = text.match(pattern);
    if (matches) {
      matches.forEach((url) => urls.add(url));
    }
  });

  return Array.from(urls);
}

/**
 * Main function to parse attachments based on file type
 * @param {Object} attachment - Attachment object with filename, mimeType, and data
 * @param {string} attachment.filename - Name of the file
 * @param {string} attachment.mimeType - MIME type of the file
 * @param {string} attachment.data - Base64 encoded file data
 * @returns {Promise<{type: string, text: string, filename: string, error?: string}>}
 */
async function parseAttachment(attachment) {
  const { filename, mimeType, data } = attachment;

  try {
    // Decode base64 data to buffer
    const buffer = Buffer.from(data, 'base64');

    // Determine file type and route to appropriate parser
    const extension = filename.split('.').pop().toLowerCase();

    // PDF files
    if (mimeType === 'application/pdf' || extension === 'pdf') {
      const result = await parsePdf(buffer);
      return { ...result, filename };
    }

    // Excel files
    if (
      mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      mimeType === 'application/vnd.ms-excel' ||
      extension === 'xlsx' ||
      extension === 'xls'
    ) {
      const result = await parseExcel(buffer);
      return { ...result, filename };
    }

    // CSV files
    if (mimeType === 'text/csv' || extension === 'csv') {
      const result = await parseCsv(buffer);
      return { ...result, filename };
    }

    // Word documents
    if (
      mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      mimeType === 'application/msword' ||
      extension === 'docx' ||
      extension === 'doc'
    ) {
      const result = await parseWord(buffer);
      return { ...result, filename };
    }

    // Plain text files
    if (mimeType === 'text/plain' || extension === 'txt') {
      return {
        type: 'text',
        text: buffer.toString('utf-8'),
        filename,
      };
    }

    // Unsupported file type
    return {
      type: 'unsupported',
      text: '',
      filename,
      error: `Unsupported file type: ${mimeType} (${extension})`,
    };
  } catch (error) {
    console.error(`Error parsing attachment ${filename}:`, error.message);
    return {
      type: 'error',
      text: '',
      filename,
      error: `Failed to parse attachment: ${error.message}`,
    };
  }
}

/**
 * Extract pricing row for a specific domain from Excel/CSV content
 * Returns structured data with header-value mapping
 * @param {Buffer} buffer - Excel/CSV file buffer
 * @param {string} targetDomain - Domain to find pricing for
 * @param {string} fileType - 'excel' or 'csv'
 * @returns {Object|null} Structured pricing data or null if not found
 */
function extractDomainPricingFromSheet(buffer, targetDomain, fileType = 'excel') {
  try {
    const targetLower = targetDomain.toLowerCase();

    if (fileType === 'excel') {
      const workbook = XLSX.read(buffer, { type: 'buffer' });

      // Process each sheet separately
      for (const sheetName of workbook.SheetNames) {
        const worksheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

        if (rows.length < 2) continue;

        // Find header row in this sheet (first row with "domain" or "site" or "website")
        let headerRowIndex = 0;
        for (let i = 0; i < Math.min(5, rows.length); i++) {
          const rowText = rows[i].join(' ').toLowerCase();
          if (rowText.includes('domain') || rowText.includes('website') || rowText.includes('site')) {
            headerRowIndex = i;
            break;
          }
        }

        const headers = rows[headerRowIndex].map(h => String(h).trim().toLowerCase());

        // Find the target domain row in this sheet
        for (let i = headerRowIndex + 1; i < rows.length; i++) {
          const row = rows[i];
          // Check ALL columns for domain match (some sheets have domain in different columns)
          for (let j = 0; j < Math.min(5, row.length); j++) {
            const cellValue = String(row[j]).toLowerCase().trim();
            // Match if cell contains the target domain
            if (cellValue && (cellValue.includes(targetLower) || targetLower.includes(cellValue.replace(/^www\./, '')))) {
              // Found it! Extract the data
              const structured = {};
              headers.forEach((header, index) => {
                if (header && row[index] !== undefined && row[index] !== '') {
                  structured[header] = row[index];
                }
              });

              // Create normalized version
              const normalized = {
                domain: targetDomain,
                sheet: sheetName,
                raw_data: structured
              };

              // Map common header patterns to standard fields
              for (const [header, value] of Object.entries(structured)) {
                const h = header.toLowerCase();
                const numValue = parseFloat(String(value).replace(/[^0-9.]/g, ''));
                if (isNaN(numValue)) continue;

                // Casino price - explicit casino/gambling columns
                if ((h.includes('casino') || h.includes('igaming') || h.includes('gambling')) && !normalized.casino_price) {
                  normalized.casino_price = numValue;
                }
                // General niche price - this is the base guest post price
                if ((h.includes('general') || h.includes('standard')) && (h.includes('niche') || h.includes('price'))) {
                  normalized.general_price = numValue;
                }
                // Finance/Crypto specific price
                if ((h.includes('finance') || h.includes('crypto')) && !h.includes('casino')) {
                  normalized.finance_price = numValue;
                }
                // Guest post price - only if NOT a casino-specific column
                if ((h.includes('guest') || (h.includes('article') && !h.includes('casino')) || (h.includes('post') && !h.includes('casino'))) && h.includes('price')) {
                  normalized.guest_post_price = numValue;
                }
                // Link insertion price
                if (h.includes('link') && h.includes('insert')) {
                  normalized.link_insertion_price = numValue;
                }
                // Homepage/frontpage link price
                if (h.includes('frontpage') || h.includes('homepage') || h.includes('front page')) {
                  normalized.homepage_price = numValue;
                }
              }

              // If no explicit guest_post_price but we have general_price, use that
              if (!normalized.guest_post_price && normalized.general_price) {
                normalized.guest_post_price = normalized.general_price;
              }

              return normalized;
            }
          }
        }
      }

      return null; // Domain not found in any sheet

    } else {
      // CSV processing
      const content = buffer.toString('utf-8');
      const rows = csvParse(content, { skip_empty_lines: true, trim: true, relax_column_count: true });

      if (rows.length < 2) return null;

      let headerRowIndex = 0;
      for (let i = 0; i < Math.min(5, rows.length); i++) {
        const rowText = rows[i].join(' ').toLowerCase();
        if (rowText.includes('domain') || rowText.includes('website') || rowText.includes('site')) {
          headerRowIndex = i;
          break;
        }
      }

      const headers = rows[headerRowIndex].map(h => String(h).trim().toLowerCase());

      for (let i = headerRowIndex + 1; i < rows.length; i++) {
        const row = rows[i];
        for (let j = 0; j < Math.min(5, row.length); j++) {
          const cellValue = String(row[j]).toLowerCase().trim();
          if (cellValue && (cellValue.includes(targetLower) || targetLower.includes(cellValue.replace(/^www\./, '')))) {
            const structured = {};
            headers.forEach((header, index) => {
              if (header && row[index] !== undefined && row[index] !== '') {
                structured[header] = row[index];
              }
            });

            const normalized = { domain: targetDomain, raw_data: structured };

            for (const [header, value] of Object.entries(structured)) {
              const h = header.toLowerCase();
              const numValue = parseFloat(String(value).replace(/[^0-9.]/g, ''));
              if ((h.includes('casino') || h.includes('igaming')) && !isNaN(numValue)) normalized.casino_price = numValue;
              if ((h.includes('general') || h.includes('standard')) && h.includes('niche') && !isNaN(numValue)) normalized.general_price = numValue;
              if ((h.includes('finance') || h.includes('crypto')) && !isNaN(numValue)) normalized.finance_price = numValue;
              if (h.includes('frontpage') || h.includes('homepage') && !isNaN(numValue)) normalized.homepage_price = numValue;
            }

            return normalized;
          }
        }
      }

      return null;
    }
  } catch (error) {
    console.error('Error extracting domain pricing from sheet:', error.message);
    return null;
  }
}

module.exports = {
  parsePdf,
  parseExcel,
  parseCsv,
  parseWord,
  parseGoogleSheet,
  findGoogleSheetUrls,
  parseAttachment,
  extractDomainPricingFromSheet,
};
