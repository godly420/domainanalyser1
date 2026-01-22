const { parseGoogleSheet } = require('./services/attachments');

// Check the Google Sheet that was accessed
const sheetUrl = 'https://docs.google.com/spreadsheets/d/1sAGJm8Gt9ozKSyxxZ6CdO7qNIZ-Ka43Ptp2h4iUQcUM/edit';

async function test() {
  console.log('Checking Google Sheet for arsenalstation.com...\n');

  const result = await parseGoogleSheet(sheetUrl, null);

  if (result.error) {
    console.log('ERROR:', result.error);
    return;
  }

  // Search for arsenalstation in the content
  if (result.text.toLowerCase().includes('arsenalstation')) {
    console.log('FOUND arsenalstation in the sheet!\n');

    // Find the line with arsenalstation
    const lines = result.text.split('\n');
    lines.forEach((line, i) => {
      if (line.toLowerCase().includes('arsenalstation')) {
        console.log(`Line ${i}: ${line}`);
      }
    });
  } else {
    console.log('arsenalstation NOT found in this sheet');
    console.log('Sheet content preview:', result.text.substring(0, 1000));
  }
}

test();
