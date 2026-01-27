/**
 * Domain Searcher Service
 * Searches emails for specific domains and extracts pricing information
 * Prioritizes webmaster/direct source emails over reseller invoices
 */

const { searchEmails, getEmailWithAttachments } = require('./gmail');
const { extractPricingForDomain } = require('./extractor');
const { parseGoogleSheet, findGoogleSheetUrls, parseAttachment, extractDomainPricingFromSheet } = require('./attachments');
const config = require('../config');

/**
 * Internal email domains - emails FROM these are outbound (lower priority)
 */
const INTERNAL_EMAIL_DOMAINS = [
  'instalinkoteam.com',
  'instalinkomailer.com',
  'instalinko-outreach.com',
  'instalinkers.com'
];

/**
 * Extract the actual webmaster contact from email content
 * Looks for non-internal email addresses in the email body (from reply chains)
 * @param {string} from - Original sender
 * @param {string} body - Email body
 * @returns {string} The webmaster contact email or original from
 */
function extractWebmasterContact(from, body) {
  // If the sender is not internal, return as-is
  const fromLower = from.toLowerCase();
  const isInternalSender = INTERNAL_EMAIL_DOMAINS.some(domain =>
    fromLower.includes(domain.toLowerCase())
  );

  if (!isInternalSender) {
    return from;
  }

  // Look for email addresses in the body that are NOT internal
  // Common patterns: "From: Name <email@domain.com>", "email@domain.com wrote:", "<email@domain.com>"
  const emailPatterns = [
    /From:\s*([^<\n]+<[^>]+>)/gi,  // "From: Name <email>"
    /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\s+wrote:/gi,  // "email wrote:"
    /<([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>/g,  // "<email>"
    /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g  // plain email
  ];

  const foundContacts = [];

  for (const pattern of emailPatterns) {
    let match;
    while ((match = pattern.exec(body)) !== null) {
      const contact = match[1] || match[0];
      const contactLower = contact.toLowerCase();

      // Skip internal emails
      const isInternal = INTERNAL_EMAIL_DOMAINS.some(domain =>
        contactLower.includes(domain.toLowerCase())
      );

      if (!isInternal && !contactLower.includes('noreply') && !contactLower.includes('no-reply')) {
        foundContacts.push(contact.trim());
      }
    }
  }

  // Return the first non-internal contact found, or original from
  if (foundContacts.length > 0) {
    // Prefer contacts that look like "Name <email>" format
    const namedContact = foundContacts.find(c => c.includes('<'));
    return namedContact || foundContacts[0];
  }

  return from;
}

/**
 * Keywords that indicate an email is an invoice/receipt (lowest priority)
 */
const INVOICE_KEYWORDS = [
  'invoice inv-', 'receipt', 'payment confirmation', 'order confirmation',
  'payment received', 'billing statement', 'order #', 'invoice #',
  'receipt #', 'payment #', 'order details', 'inv-'
];

/**
 * Keywords that indicate a negotiated/confirmed price (HIGHEST priority)
 * These indicate the FINAL agreed price, not just initial quotes
 */
const NEGOTIATION_CONFIRMATION_KEYWORDS = [
  'price agreed', 'agreed price', 'final price', 'we agree', 'i agree',
  'deal confirmed', 'deal done', 'okay for', 'ok for', 'works for me',
  'sounds good', 'accepted', 'confirmed', 'let\'s proceed', 'go ahead',
  'send the article', 'send content', 'send the content', 'waiting for article',
  'waiting for content', 'send me the article', 'please share the article',
  'share the content', 'will publish', 'can publish', 'ready to publish'
];

/**
 * Known reseller/agency domains and names (deprioritize these)
 */
const RESELLER_INDICATORS = [
  // Known agencies
  'snack-media', 'snack media', 'imperium-comms', 'imperium comms',
  'links@snack', 'j.clifford@imperium', 'messaging-service@post.xero',
  'mashable partners', 'mashablepartners', 'info@mashablepartners',
  'redhat media', 'redhatmedia', 'mashum@redhatmedia',
  // Bulk media aggregators (send Google Sheets with many sites)
  'entrepreneur media', 'entrepreneurmedia', 'entrepreneuredition',
  'info@entrepreneuredition', 'elena vladimirovna', 'elenavladimirovna',
  'nogentech', 'info@nogentech', 'nogentech media', 'nogentech.org',
  'dailybanner1@gmail', 'daily banner', 'dailybanner',
  'gposting.com', 'support@gposting', 'gposting',
  'rabbiitfirm', 'admin@rabbiitfirm', 'rabbi it firm',
  // Link building resellers
  'bloggeroutreach.io', 'bloggeroutreach.com', 'ejaz@bloggeroutreach',
  'bazoom', 'app@mg.bazoom',
  // Resellers who send price lists for sites they don't own
  'mamacasinos@gmail.com', 'mamacasinos', 'mama casinos',
  // Bulk price list resellers (they send Google Sheets with many sites)
  'markhombarg@gmail.com', 'frankheepsy', 'benjaminrutschle', 'benjamin.marketingoutreach',
  'lancethompson', 'gabrielgoldenberg', 'lunahazel', 'jorjsmith', 'dylankohlstadt',
  'lisamoni', 'bloggerslisamoni', 'randyorten', 'harrywin', 'jaxonmercer',
  'alicemarketer', 'graceanna', 'ivanjhon', 'arabelajewel', 'samuelmax',
  'lillyrose', 'wyattmoree', 'kateflower', 'freyamolly', 'norahjasmine',
  'danielmarketer', 'danielmatthew', 'jamesvince', 'lecabrey', 'kitroberseo',
  // Common reseller email patterns (be careful - some webmasters use these)
  'linkbuilding@', 'link-building@', 'seoagency', 'seo-agency',
  '.outreach@gmail', '.seo@gmail', 'marketingoutreach@',
  // Payment processors (invoices)
  'service@paypal.com'
];

/**
 * Keywords that indicate an email contains a price list (highest priority)
 */
const PRICE_LIST_KEYWORDS = [
  'full media list', 'here are all our sites', 'sites where we accept',
  'below is our full', 'our sites', 'our websites', 'price list',
  'our pricing', 'per link', 'general post', 'casino/forex', 'casino price',
  'here are our', 'all our sites', 'media list'
];

/**
 * Outbound inquiry subject patterns - emails we send asking for prices
 */
const OUTBOUND_INQUIRY_PATTERNS = [
  'guest post', 'sponsored post', 'inquiry', 'collaborate', 'partnership',
  'guest posting', 'link insertion', 'sponsored content', 'paid post',
  'contribute', 'content opportunity', 'backlink', 'article placement',
  'order for', 'order on', 'placement on', 'post on', 'article on'
];

/**
 * Patterns in email BODY that indicate a webmaster responding to an inquiry
 * (even if the subject doesn't have "Re:")
 */
const RESPONSE_BODY_PATTERNS = [
  // Direct response indicators
  'thank you for reaching out', 'thanks for your interest', 'thanks for contacting',
  'in response to your', 'regarding your inquiry', 'following up on your',
  'as per your request', 'as requested', 'here are our rates',
  // Pricing response indicators
  'our pricing', 'our rates', 'our prices', 'the price is', 'we charge',
  'pricing for guest', 'cost for guest', 'rate for guest', 'price for sponsored',
  'per article', 'per post', 'for one article', 'for one post',
  // Quote/offer patterns
  'please find', 'attached is', 'below are', 'here is our', 'i can offer',
  'we can offer', 'happy to offer', 'we would charge', 'we accept'
];

/**
 * Subject line patterns that indicate a direct pricing response (without "Re:")
 */
const DIRECT_PRICING_SUBJECTS = [
  'pricing for', 'rates for', 'price for', 'quote for', 'offer for',
  'guest post opportunity', 'sponsorship opportunity', 'advertising rates',
  'media kit', 'rate card', 'pricing inquiry', 'our rates'
];

/**
 * Calculates a priority score for an email (higher = better source)
 *
 * KEY CONCEPT:
 * - WEBMASTER = Someone who REPLIED to our outreach (we initiated contact)
 * - RESELLER = Someone who INITIATED contact with us (unsolicited price lists)
 *
 * @param {string} from - Email sender
 * @param {string} subject - Email subject
 * @param {string} body - Email body text
 * @param {string} targetDomain - The domain we're searching for
 * @returns {number} Priority score (0-100)
 */
function calculateEmailPriority(from, subject, body, targetDomain) {
  const combinedText = `${subject} ${body}`.toLowerCase();
  const subjectLower = subject.toLowerCase();
  const fromLower = from.toLowerCase();
  let score = 30; // Lower base score - earn points by being a reply to our outreach

  // Check if this is from our internal team
  const isOutbound = INTERNAL_EMAIL_DOMAINS.some(domain =>
    fromLower.includes(domain.toLowerCase())
  );

  // DEPRIORITIZE: Outbound emails (from our internal team)
  if (isOutbound) {
    score -= 50; // Strong penalty - we want webmaster replies, not our outreach
  }

  // CRITICAL: Is this a REPLY to our outreach? (indicates webmaster, not reseller)
  // Pattern: "Re: Guest post on domain.com" from non-internal sender
  const isReply = subjectLower.startsWith('re:') || subjectLower.startsWith('re ');
  const isInquiryReply = OUTBOUND_INQUIRY_PATTERNS.some(pattern =>
    subjectLower.includes(pattern.toLowerCase())
  );
  const domainInSubject = subjectLower.includes(targetDomain.toLowerCase());
  const domainInBody = combinedText.includes(targetDomain.toLowerCase());
  const mentionsDomain = domainInSubject || domainInBody;

  // CRITICAL: Check if the subject mentions a DIFFERENT domain (not our target)
  // This catches emails like "Re: Guest post on mamacasinos.com" when searching for trans4mind.com
  const otherDomainInSubject = subjectLower.match(/(?:on|for|at)\s+([a-z0-9][-a-z0-9]*\.[a-z]{2,})/i);
  const isAboutDifferentDomain = otherDomainInSubject &&
    !otherDomainInSubject[1].includes(targetDomain.toLowerCase()) &&
    !targetDomain.toLowerCase().includes(otherDomainInSubject[1]);

  if (isAboutDifferentDomain) {
    score -= 40; // HEAVY penalty - this email is about a different domain!
  }

  if (!isOutbound && isReply && isInquiryReply && domainInSubject) {
    score += 50; // HUGE bonus - reply to OUR inquiry WITH target domain in subject = definitely webmaster!
  } else if (!isOutbound && isReply && isInquiryReply && !isAboutDifferentDomain) {
    score += 40; // Good bonus - reply to our inquiry, not about a different domain
  } else if (!isOutbound && !isReply) {
    // Not a reply = they initiated contact = likely reseller/spam
    score -= 15; // Penalty for unsolicited contact
  }

  // HIGH PRIORITY: Body contains response/pricing patterns (webmaster responding without "Re:")
  // This catches cases where webmasters start a NEW email thread with pricing
  if (!isOutbound) {
    const bodyLower = body.toLowerCase();

    // Check for direct pricing subject patterns (without "Re:")
    const hasDirectPricingSubject = DIRECT_PRICING_SUBJECTS.some(pattern =>
      subjectLower.includes(pattern.toLowerCase())
    );
    if (hasDirectPricingSubject && mentionsDomain) {
      score += 25; // Direct pricing email for this domain
    }

    // Check for response body patterns that indicate replying to inquiry
    const hasResponsePattern = RESPONSE_BODY_PATTERNS.some(pattern =>
      bodyLower.includes(pattern.toLowerCase())
    );
    if (hasResponsePattern && mentionsDomain) {
      score += 20; // Body suggests this is a response to our inquiry
    }

    // HIGHEST PRIORITY: Negotiation confirmation keywords
    // These indicate the FINAL agreed price (after negotiation), not initial quotes
    const hasNegotiationConfirmation = NEGOTIATION_CONFIRMATION_KEYWORDS.some(pattern =>
      bodyLower.includes(pattern.toLowerCase())
    );
    if (hasNegotiationConfirmation) {
      score += 25; // Strong bonus - this email likely contains the final agreed price
    }
  }

  // HIGHEST PRIORITY: Sender domain matches target domain (direct webmaster!)
  const targetDomainClean = targetDomain.replace(/\./g, '').toLowerCase();
  const targetDomainBase = targetDomain.split('.')[0].toLowerCase(); // e.g., "pwinsider" from "pwinsider.com"
  const senderClean = fromLower.replace(/[^a-z0-9]/g, '');

  // Extract just the email address part for matching
  const emailMatch = fromLower.match(/<([^>]+)>/) || fromLower.match(/([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/);
  const senderEmail = emailMatch ? emailMatch[1] : fromLower;
  const senderUsername = senderEmail.split('@')[0].replace(/[^a-z0-9]/g, '');

  // Check for exact domain match or domain name in sender
  const senderDomainMatch = fromLower.includes(targetDomain.toLowerCase()) ||
    senderClean.includes(targetDomainClean);

  // Check for abbreviated domain match (e.g., "daveschererpwi@gmail.com" for "pwinsider.com")
  // Try multiple lengths: full domain base, then progressively shorter (minimum 3 chars)
  let hasAbbreviatedMatch = false;
  if (!isOutbound && targetDomainBase.length >= 3) {
    // Check full domain base first (e.g., "pwinsider")
    if (senderUsername.includes(targetDomainBase)) {
      hasAbbreviatedMatch = true;
    } else {
      // Try progressively shorter prefixes (pwinside, pwinsi, pwins, pwin, pwi)
      for (let len = targetDomainBase.length - 1; len >= 3; len--) {
        const abbrev = targetDomainBase.substring(0, len);
        if (senderUsername.includes(abbrev)) {
          hasAbbreviatedMatch = true;
          break;
        }
      }
    }
  }

  if (senderDomainMatch) {
    score += 70; // STRONGEST match - email FROM the target domain = definitely the webmaster!
  } else if (hasAbbreviatedMatch) {
    score += 30; // Partial match - likely webmaster with personal email
  }

  // HIGH PRIORITY: Contains price list indicators
  const hasPriceList = PRICE_LIST_KEYWORDS.some(keyword =>
    combinedText.includes(keyword.toLowerCase())
  );
  if (hasPriceList) {
    score += 20;
  }

  // DEPRIORITIZE: Known resellers/agencies (strong penalty!)
  const isReseller = RESELLER_INDICATORS.some(indicator =>
    fromLower.includes(indicator.toLowerCase()) ||
    combinedText.includes(indicator.toLowerCase())
  );
  if (isReseller) {
    score -= 60; // Heavy penalty - resellers should NOT be preferred over webmasters
  }

  // LOWEST PRIORITY: Invoice emails
  const isInvoice = INVOICE_KEYWORDS.some(keyword =>
    combinedText.includes(keyword.toLowerCase())
  );
  if (isInvoice) {
    score -= 30;
  }

  return score;
}

/**
 * Classifies an email based on priority score
 * @param {string} from - Email sender
 * @param {string} subject - Email subject
 * @param {string} body - Email body text
 * @param {string} targetDomain - Target domain
 * @returns {object} Classification with type and score
 */
function classifyEmail(from, subject, body, targetDomain) {
  const score = calculateEmailPriority(from, subject, body, targetDomain);

  // Check if outbound (from internal team)
  const fromLower = from.toLowerCase();
  const isOutbound = INTERNAL_EMAIL_DOMAINS.some(domain =>
    fromLower.includes(domain.toLowerCase())
  );

  let type = 'unknown';
  if (isOutbound) type = 'outbound';
  else if (score >= 70) type = 'direct-webmaster';
  else if (score >= 50) type = 'price-list';
  else if (score >= 30) type = 'unknown';
  else if (score >= 10) type = 'reseller';
  else type = 'invoice';

  return { type, score };
}

/**
 * Search for pricing information for a list of domains
 * Processes domains SEQUENTIALLY (to maintain order) but fetches from accounts in PARALLEL (for speed)
 * @param {string[]} domains - Array of domains to search for
 * @param {Function} onResult - Callback when a result is found: (result) => void
 * @param {Function} onProgress - Callback for progress updates: (searched, total) => void
 * @param {Function} onComplete - Callback when search is complete: () => void
 */
async function searchDomains(domains, onResult, onProgress, onComplete) {
  const accounts = config.emailAccounts;
  let searched = 0;
  const total = domains.length;

  // Process domains sequentially to maintain order
  // (Account fetching within each domain is still parallel for speed)
  for (const domain of domains) {
    try {
      const result = await searchDomain(domain, accounts);
      if (result) {
        onResult(result);
      }
    } catch (error) {
      console.error(`Error searching for ${domain}:`, error.message);
    }

    searched++;
    onProgress(searched, total);
  }

  onComplete();
}

/**
 * Search for a single domain across all email accounts
 * Prioritizes newest emails first across ALL accounts to get the latest prices
 * @param {string} domain - Domain to search for
 * @param {string[]} accounts - Email accounts to search
 * @returns {Promise<Object|null>} Result object or null if not found
 */
async function searchDomain(domain, accounts) {
  // Clean domain (remove protocol, www, trailing slashes)
  const cleanDomain = domain
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '')
    .toLowerCase()
    .trim();

  if (!cleanDomain) return null;

  console.log(`Searching for: ${cleanDomain}`);

  // Collect all emails from ALL accounts in PARALLEL (faster!)
  const allEmails = [];

  // Fetch from all accounts simultaneously
  const accountResults = await Promise.all(
    accounts.map(async (account) => {
      try {
        const searchQuery = `${cleanDomain}`;
        const emails = await searchEmails(account, searchQuery);
        return { account, emails, error: null };
      } catch (error) {
        return { account, emails: [], error: error.message };
      }
    })
  );

  // Process results from all accounts
  for (const { account, emails, error } of accountResults) {
    if (error) {
      console.log(`Error fetching ${cleanDomain} from ${account}: ${error}`);
      continue;
    }

    if (emails.length === 0) {
      console.log(`No emails found for ${cleanDomain} in ${account}`);
      continue;
    }

    console.log(`Found ${emails.length} emails mentioning ${cleanDomain} in ${account}`);

    // Add account info to each email and collect
    // Gmail API returns emails sorted by date (newest first) by default
    // Take more emails per account to ensure we find all potential sources
    const recentEmails = emails.slice(0, 25);
    for (const emailItem of recentEmails) {
      allEmails.push({
        id: emailItem.id,
        account: account,
        // Gmail returns in reverse chronological order, so we use index as proxy for recency
        // Lower index = newer email
        accountOrder: accounts.indexOf(account),
        emailOrder: recentEmails.indexOf(emailItem)
      });
    }
  }

  if (allEmails.length === 0) {
    return null;
  }

  // First pass: fetch basic email info and classify them with priority scores
  console.log(`Classifying ${allEmails.length} emails for ${cleanDomain}...`);

  for (const emailInfo of allEmails) {
    try {
      const emailData = await getEmailWithAttachments(emailInfo.account, emailInfo.id);
      emailInfo.subject = emailData.subject;
      emailInfo.body = emailData.body || '';
      emailInfo.from = emailData.from;
      emailInfo.emailData = emailData;
      // Parse email date for proper sorting across accounts
      emailInfo.emailDate = emailData.date ? new Date(emailData.date) : new Date(0);
      // Pass target domain for smarter classification
      const classification = classifyEmail(emailData.from, emailData.subject, emailData.body, cleanDomain);
      emailInfo.classification = classification.type;
      emailInfo.priorityScore = classification.score;
    } catch (error) {
      emailInfo.classification = 'unknown';
      emailInfo.priorityScore = 0;
      emailInfo.emailDate = new Date(0);
    }
  }

  // Group emails by sender email (not domain) to prefer newest from same actual sender
  const getSenderEmail = (from) => {
    const match = from.match(/<([^>]+)>/);
    if (match) return match[1].toLowerCase();
    const emailMatch = from.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    return emailMatch ? emailMatch[1].toLowerCase() : from.toLowerCase();
  };

  // Sort by: priority score first, then date (newest first) within same score
  // For same exact sender email + same score, prefer newest
  allEmails.sort((a, b) => {
    // Always sort by priority score first
    const scoreDiff = b.priorityScore - a.priorityScore;
    if (scoreDiff !== 0) return scoreDiff;

    // Within same score, if same sender email, sort by date (newest first)
    const senderA = getSenderEmail(a.from || '');
    const senderB = getSenderEmail(b.from || '');
    if (senderA === senderB) {
      return b.emailDate - a.emailDate;
    }

    // Different senders with same score: sort by date (newest first)
    return b.emailDate - a.emailDate;
  });

  console.log(`Processing ${allEmails.length} emails for ${cleanDomain} (sorted by priority, then date):`);
  allEmails.forEach(e => {
    const dateStr = e.emailDate ? e.emailDate.toISOString().split('T')[0] : 'unknown';
    console.log(`  - [${e.classification}:${e.priorityScore}] ${dateStr} | ${e.from}: ${e.subject?.substring(0, 40)}...`);
  });

  // Collect prices from multiple sources to find the best one
  const foundPrices = [];
  const maxSourcesPerTier = 5; // Process up to 5 sources per priority tier

  // Group emails by priority tier
  const tiers = {
    'direct-webmaster': allEmails.filter(e => e.priorityScore >= 70),
    'price-list': allEmails.filter(e => e.priorityScore >= 40 && e.priorityScore < 70),
    'other': allEmails.filter(e => e.priorityScore < 40)
  };

  // Process each tier, collecting prices
  for (const [tierName, tierEmails] of Object.entries(tiers)) {
    const sendersWithPrices = new Set(); // Track senders who already gave us a price
    let sourcesProcessed = 0;
    let emailsTriedInTier = 0;
    const maxEmailsToTry = 15; // Try more emails to find at least one price

    for (const emailInfo of tierEmails) {
      // Stop if we have enough prices OR tried too many emails
      if (sourcesProcessed >= maxSourcesPerTier && foundPrices.length > 0) break;
      if (emailsTriedInTier >= maxEmailsToTry) break;

      const senderKey = emailInfo.from?.toLowerCase().match(/<([^>]+)>/)?.[1] || emailInfo.from?.toLowerCase();

      // Skip if this sender already gave us a price (but try other emails from same sender if no price yet)
      if (sendersWithPrices.has(senderKey)) continue;

      emailsTriedInTier++;

      try {
        const result = await processEmailForDomain(
          emailInfo.account,
          emailInfo.id,
          cleanDomain,
          emailInfo.emailData
        );
        if (result) {
          console.log(`  → Found price in [${emailInfo.classification}:${emailInfo.priorityScore}] from: ${emailInfo.from}`);
          foundPrices.push({
            ...result,
            priorityScore: emailInfo.priorityScore,
            classification: emailInfo.classification,
            emailDate: emailInfo.emailDate
          });
          sendersWithPrices.add(senderKey); // Mark this sender as having given us a price
          sourcesProcessed++;
        }
      } catch (error) {
        console.error(`Error processing email ${emailInfo.id}:`, error.message);
      }
    }

    // If we found prices from direct webmasters, we can stop looking at lower tiers
    if (tierName === 'direct-webmaster' && foundPrices.length > 0) {
      console.log(`  Found ${foundPrices.length} price(s) from direct webmaster(s), using best one`);
      break;
    }
  }

  if (foundPrices.length === 0) {
    return null;
  }

  // Pick the best price based on PRIORITY SCORE first (webmaster > reseller), then recency as tiebreaker
  // This ensures direct webmaster prices ALWAYS win over reseller prices, regardless of date
  foundPrices.sort((a, b) => {
    // PRIORITY SCORE is the primary sort key - webmaster emails should ALWAYS win
    const scoreDiff = b.priorityScore - a.priorityScore;
    if (scoreDiff !== 0) {
      return scoreDiff;
    }
    // Only use recency as tiebreaker when priority scores are equal
    const dateA = a.emailDate ? new Date(a.emailDate).getTime() : 0;
    const dateB = b.emailDate ? new Date(b.emailDate).getTime() : 0;
    return dateB - dateA;
  });

  const bestResult = foundPrices[0];
  console.log(`✓ Selected best price from ${foundPrices.length} source(s): [${bestResult.classification}:${bestResult.priorityScore}] ${bestResult.source_email}`);
  console.log(`Found: ${cleanDomain} - GP: ${bestResult.guest_post_price} ${bestResult.currency}${bestResult.casino_price ? ` | Casino: ${bestResult.casino_price} ${bestResult.currency}` : ''}`);


  return bestResult;
}

/**
 * Process a single email to extract pricing for a specific domain
 * @param {string} account - Email account
 * @param {string} emailId - Email ID
 * @param {string} targetDomain - Domain to find pricing for
 * @param {Object} [prefetchedData] - Pre-fetched email data (optional)
 * @returns {Promise<Object|null>} Pricing result or null
 */
async function processEmailForDomain(account, emailId, targetDomain, prefetchedData = null) {
  const emailData = prefetchedData || await getEmailWithAttachments(account, emailId);

  // Build combined content
  let combinedContent = `From: ${emailData.from}\nSubject: ${emailData.subject}\n\nBody:\n${emailData.body || ''}`;

  // Parse attachments - try structured extraction first for Excel/CSV
  let structuredSheetData = null;
  if (emailData.attachments && emailData.attachments.length > 0) {
    for (const attachment of emailData.attachments) {
      try {
        const ext = attachment.filename.split('.').pop().toLowerCase();

        // For Excel/CSV, try structured extraction first
        if (['xlsx', 'xls', 'csv'].includes(ext)) {
          const buffer = Buffer.from(attachment.data, 'base64');
          const extracted = extractDomainPricingFromSheet(buffer, targetDomain, ext === 'csv' ? 'csv' : 'excel');

          if (extracted && (extracted.casino_price || extracted.general_price || extracted.guest_post_price)) {
            console.log(`  Found structured pricing in ${attachment.filename}:`, JSON.stringify(extracted));
            structuredSheetData = extracted;
            // Add structured data to content for AI context
            combinedContent += `\n\n--- STRUCTURED PRICING DATA FROM ${attachment.filename} ---\n`;
            combinedContent += `Domain: ${extracted.domain}\n`;
            if (extracted.guest_post_price) combinedContent += `Guest Post Price: ${extracted.guest_post_price}\n`;
            if (extracted.general_price) combinedContent += `General Niche Price: ${extracted.general_price}\n`;
            if (extracted.casino_price) combinedContent += `Casino Price: ${extracted.casino_price}\n`;
            if (extracted.finance_price) combinedContent += `Finance/Crypto Price: ${extracted.finance_price}\n`;
            if (extracted.homepage_price) combinedContent += `Homepage Link Price: ${extracted.homepage_price}\n`;
            if (extracted.link_insertion_price) combinedContent += `Link Insertion Price: ${extracted.link_insertion_price}\n`;
            combinedContent += `Raw Data: ${JSON.stringify(extracted.raw_data)}\n`;
          } else {
            // Fall back to text parsing if structured extraction didn't find the domain
            const parsed = await parseAttachment(attachment);
            if (parsed && parsed.text) {
              combinedContent += `\n\n--- Attachment: ${attachment.filename} ---\n${parsed.text}`;
            }
          }
        } else {
          // For other file types, use regular text parsing
          const parsed = await parseAttachment(attachment);
          if (parsed && parsed.text) {
            combinedContent += `\n\n--- Attachment: ${attachment.filename} ---\n${parsed.text}`;
          }
        }
      } catch (error) {
        console.error(`Error parsing attachment:`, error.message);
      }
    }
  }

  // Check Google Sheets
  const googleSheetUrls = findGoogleSheetUrls(emailData.body || '');
  for (const url of googleSheetUrls) {
    try {
      const sheetData = await parseGoogleSheet(url, account);
      if (sheetData && sheetData.text) {
        combinedContent += `\n\n--- Google Sheet ---\n${sheetData.text}`;
      }
    } catch (error) {
      console.error(`Error parsing Google Sheet:`, error.message);
    }
  }

  // Check if target domain is mentioned in content (case-insensitive)
  if (!combinedContent.toLowerCase().includes(targetDomain.toLowerCase())) {
    return null;
  }

  // If we have structured data from Excel, use it directly without AI
  if (structuredSheetData && (structuredSheetData.casino_price || structuredSheetData.general_price || structuredSheetData.guest_post_price)) {
    console.log(`  Using structured sheet data directly for ${targetDomain}`);

    // Determine guest post price (general price is usually the guest post price)
    const guestPostPrice = structuredSheetData.guest_post_price || structuredSheetData.general_price || null;
    const casinoPrice = structuredSheetData.casino_price || guestPostPrice; // Default casino to guest post if not specified

    // Extract actual webmaster contact from email body if sender is internal
    const webmasterContact = extractWebmasterContact(emailData.from, emailData.body || '');

    return {
      domain: targetDomain,
      guest_post_price: guestPostPrice,
      link_insertion_price: structuredSheetData.link_insertion_price || null,
      sponsored_post_price: null,
      homepage_link_price: structuredSheetData.homepage_price || null,
      casino_price: casinoPrice,
      casino_accepted: 'yes', // If we have pricing from a sheet, casino is typically accepted
      currency: 'EUR', // Most sheets use EUR, could be improved
      source_email: webmasterContact,
      subject: emailData.subject,
      account: account,
      confidence: 'high',
      notes: `Extracted from sheet. Raw: ${JSON.stringify(structuredSheetData.raw_data)}`
    };
  }

  // Truncate content to prevent token limit errors (max ~50k chars ≈ ~12k tokens)
  const maxContentLength = 50000;
  if (combinedContent.length > maxContentLength) {
    // Try to keep the part that mentions the target domain
    const domainIndex = combinedContent.toLowerCase().indexOf(targetDomain.toLowerCase());
    if (domainIndex > maxContentLength / 2) {
      // Domain is in the second half, take content around it
      const start = Math.max(0, domainIndex - maxContentLength / 2);
      combinedContent = combinedContent.substring(start, start + maxContentLength);
    } else {
      // Domain is in the first half, just truncate from end
      combinedContent = combinedContent.substring(0, maxContentLength);
    }
    console.log(`  Truncated content from ${combinedContent.length} to ${maxContentLength} chars`);
  }

  // Extract pricing specifically for the target domain using AI
  const pricingData = await extractPricingForDomain(combinedContent, targetDomain);

  // Validate we got pricing data
  if (!pricingData) {
    return null;
  }

  // Check if at least one price exists
  const hasPrice = pricingData.guest_post_price ||
                   pricingData.link_insertion_price ||
                   pricingData.sponsored_post_price ||
                   pricingData.homepage_link_price ||
                   pricingData.casino_price;

  if (!hasPrice) {
    return null;
  }

  // Extract actual webmaster contact from email body if sender is internal
  const webmasterContact = extractWebmasterContact(emailData.from, emailData.body || '');

  return {
    domain: targetDomain,
    guest_post_price: pricingData.guest_post_price,
    link_insertion_price: pricingData.link_insertion_price,
    sponsored_post_price: pricingData.sponsored_post_price,
    homepage_link_price: pricingData.homepage_link_price,
    casino_price: pricingData.casino_price,
    casino_accepted: pricingData.casino_accepted || 'yes',
    currency: pricingData.currency || 'USD',
    source_email: webmasterContact,
    subject: emailData.subject,
    account: account,
    confidence: pricingData.confidence || 'medium',
    notes: pricingData.notes
  };
}

module.exports = {
  searchDomains,
  searchDomain
};
