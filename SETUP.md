# Domain Price Searcher - Setup Instructions

## Prerequisites

1. **Node.js** (v18 or higher)
   - Download from: https://nodejs.org/

2. **OpenAI API Key**
   - Get from: https://platform.openai.com/api-keys
   - You need credit on your account

3. **Google Cloud Project with Gmail API**
   - You need a `credentials.json` file for Gmail access

---

## Installation Steps

### Step 1: Install Dependencies
```bash
cd price-scraper
npm install
```

### Step 2: Configure the Application

1. Copy the example config:
   ```bash
   cp config.example.js config.js
   ```

2. Edit `config.js` and fill in:
   - Your OpenAI API key
   - Your team's email addresses

### Step 3: Set Up Google Credentials

You need a `credentials.json` file from Google Cloud Console:

1. Go to https://console.cloud.google.com/
2. Create a new project (or use existing)
3. Enable the Gmail API and Google Sheets API
4. Create a Service Account:
   - Go to "IAM & Admin" > "Service Accounts"
   - Create new service account
   - Download JSON key file
   - Rename it to `credentials.json`
   - Place it in the price-scraper folder

5. **Important**: Share your Gmail accounts with the service account email
   - Go to Gmail settings > Delegation
   - Or use Google Workspace domain-wide delegation

### Step 4: Run the Application
```bash
node server.js
```

The app will run at: http://localhost:3000

---

## Troubleshooting

### "Cannot find module" error
Run: `npm install`

### Gmail authentication errors
- Make sure `credentials.json` is in the folder
- Verify the service account has access to the emails

### OpenAI errors
- Check your API key is correct
- Verify you have credits in your OpenAI account

---

## Files Overview

- `server.js` - Main server file
- `config.js` - Your configuration (API keys, emails)
- `credentials.json` - Google API credentials
- `services/` - Core functionality
- `public/` - Web interface
