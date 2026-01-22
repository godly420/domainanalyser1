const { google } = require('googleapis');

// Email accounts to test
const emailAccounts = [
  'info@instalinkoteam.com',
  'sam@instalinkomailer.com',
  'jenny@instalinko-outreach.com',
  'denis@instalinkers.com'
];

async function testConnection(email) {
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: 'credentials.json',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      clientOptions: { subject: email }
    });

    const gmail = google.gmail({ version: 'v1', auth });

    // Try to list 1 email
    const response = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 1
    });

    const count = response.data.resultSizeEstimate || 0;
    console.log(`✅ ${email}: Connected! (~${count} emails)`);
    return { email, success: true, count };
  } catch (err) {
    console.log(`❌ ${email}: ${err.message}`);
    return { email, success: false, error: err.message };
  }
}

async function main() {
  console.log('Testing Gmail API connection with service account...\n');

  const results = [];
  for (const email of emailAccounts) {
    const result = await testConnection(email);
    results.push(result);
  }

  console.log('\n--- Summary ---');
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  console.log(`Successful: ${successful.length}/${results.length}`);
  if (failed.length > 0) {
    console.log('\nFailed accounts:');
    failed.forEach(f => console.log(`  - ${f.email}: ${f.error}`));

    if (failed[0].error.includes('unauthorized_client') || failed[0].error.includes('access_denied')) {
      console.log('\n⚠️  Domain-wide delegation may not be configured.');
      console.log('Please ensure the service account has delegation enabled in Google Workspace Admin Console.');
    }
  }
}

main();
