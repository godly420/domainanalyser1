const { parseGoogleSheet } = require('./services/attachments');

// Test with a known public Google Sheet (Google's sample sheet)
const publicSheetUrl = 'https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit';

async function test() {
  console.log('Testing Google Sheets parsing...\n');
  console.log('URL:', publicSheetUrl);
  console.log('---');

  const result = await parseGoogleSheet(publicSheetUrl, null);

  if (result.error) {
    console.log('ERROR:', result.error);
  } else {
    console.log('SUCCESS!');
    console.log('Sheet ID:', result.sheetId);
    console.log('Text preview (first 500 chars):', result.text.substring(0, 500));
  }
}

test();
