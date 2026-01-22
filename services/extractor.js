/**
 * AI-Powered Price Extraction Service
 * Uses OpenAI GPT model to extract structured pricing information from email content
 */

const OpenAI = require('openai');
const config = require('../config');

/**
 * Extracts pricing information from email content using OpenAI API
 *
 * @param {string} emailContent - The raw email content to analyze
 * @returns {Promise<Object>} Structured pricing data object
 * @throws {Error} If API call fails or content is invalid
 *
 * @example
 * const result = await extractPricing(emailBody);
 * console.log(result.guest_post_price); // 150
 */
async function extractPricing(emailContent) {
  // Validate input
  if (!emailContent || typeof emailContent !== 'string') {
    throw new Error('Invalid email content provided');
  }

  // Validate API key configuration
  if (!config.openai?.apiKey) {
    throw new Error('OpenAI API key not configured');
  }

  try {
    // Initialize OpenAI client
    const openai = new OpenAI({
      apiKey: config.openai.apiKey
    });

    // Construct the extraction prompt
    const prompt = buildExtractionPrompt(emailContent);

    // Call OpenAI API
    const response = await openai.chat.completions.create({
      model: config.openai.model,
      messages: [
        {
          role: 'system',
          content: 'You are a specialized assistant that extracts pricing information from publisher outreach emails. You must always respond with valid JSON only, no additional text.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.1, // Low temperature for consistent, factual extraction
      response_format: { type: 'json_object' } // Enforce JSON response
    });

    // Parse the response
    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('Empty response from OpenAI API');
    }

    const extractedData = JSON.parse(content);

    // Validate and normalize the extracted data
    const result = normalizeExtractedData(extractedData);

    return result;

  } catch (error) {
    // Handle specific OpenAI API errors
    if (error.response) {
      throw new Error(`OpenAI API error: ${error.response.status} - ${error.response.data?.error?.message || 'Unknown error'}`);
    }

    // Handle JSON parsing errors
    if (error instanceof SyntaxError) {
      throw new Error(`Failed to parse OpenAI response as JSON: ${error.message}`);
    }

    // Re-throw other errors
    throw error;
  }
}

/**
 * Builds the extraction prompt for the OpenAI API
 *
 * @param {string} emailContent - Raw email content
 * @returns {string} Formatted prompt
 */
function buildExtractionPrompt(emailContent) {
  return `Analyze the following email and extract pricing information for website publishing services.

EMAIL CONTENT:
${emailContent}

EXTRACTION INSTRUCTIONS:
1. Extract the publisher's website domain (look in email signatures, sender address, or mentioned in content)
2. Extract contact email address (sender or mentioned contact email)
3. Extract publisher name or company name
4. Find pricing for these services (look for various formats: $150, 150 USD, €200, 200 EUR, £100, etc.):
   - Guest Post (also called "Sponsored Article", "Content Publication", "Article Placement")
   - Link Insertion (also called "Link Addition", "Link in Existing Article", "Contextual Link")
   - Sponsored Post (similar to guest post but may be marked as sponsored)
   - Homepage Link (also called "Homepage Placement", "Front Page Link")
   - Casino Post (also called "Casino Content", "iGaming", "Gambling content")
5. Determine if casino/gambling content is accepted (look for "casino accepted", "gambling OK", "iGaming welcome", or any mention of casino pricing - if casino pricing exists, casino is accepted)
6. Identify the currency used (USD, EUR, GBP, INR, etc.)
6. Extract any additional pricing details or conditions
7. Assess confidence level:
   - HIGH: Clear, specific prices stated
   - MEDIUM: Prices mentioned but with some ambiguity
   - LOW: Vague pricing or price ranges without specific values
8. Flag for review if:
   - Multiple price ranges are given without clear values
   - Pricing is unclear or conditional
   - No specific prices found
   - Confidence is LOW

PRICE DETECTION RULES:
- Convert all prices to numbers (remove currency symbols and text)
- If a range is given (e.g., "$100-$150"), use the lower value and flag for review
- If "starting at" or "from" is mentioned, use that value and flag for review
- If no price is found for a service, return null
- If no pricing information exists at all, return null for domain

CRITICAL - DO NOT CONFUSE METRICS WITH PRICES:
- DA (Domain Authority) and DR (Domain Rating) are METRICS, NOT PRICES! They range 1-100
- Columns labeled "DA", "DR", "Traffic", "TF", "CF" contain metrics, NOT prices
- Actual prices have currency symbols ($, €, £) or words like "Price", "Cost", "Rate"
- NEVER extract DA/DR values as prices

OUTPUT FORMAT (JSON only, no additional text):
{
  "domain": "example.com" or null,
  "publisher_email": "contact@example.com" or null,
  "publisher_name": "Company Name" or null,
  "guest_post_price": 150 or null,
  "link_insertion_price": 75 or null,
  "sponsored_post_price": 200 or null,
  "homepage_link_price": 300 or null,
  "casino_price": 250 or null,
  "casino_accepted": "yes" or "no",
  "currency": "USD" or "EUR" or "GBP" etc.,
  "notes": "Any additional relevant pricing details or conditions",
  "confidence": "high" or "medium" or "low",
  "needs_review": 1 or 0
}

IMPORTANT:
- Return ONLY the JSON object, no markdown formatting or additional text
- Use null for missing values, not empty strings
- Prices must be numbers only (no currency symbols)
- needs_review should be 1 (true) or 0 (false)
- casino_accepted should be "yes" or "no" (if casino_price exists, casino_accepted is "yes")
- If no pricing found, return {"domain": null, "publisher_email": null, "publisher_name": null, "guest_post_price": null, "link_insertion_price": null, "sponsored_post_price": null, "homepage_link_price": null, "casino_price": null, "casino_accepted": "no", "currency": null, "notes": "No pricing information found", "confidence": "low", "needs_review": 1}`;
}

/**
 * Normalizes and validates extracted data
 * Ensures all required fields are present with correct types
 *
 * @param {Object} data - Raw extracted data from OpenAI
 * @returns {Object} Normalized data object
 */
function normalizeExtractedData(data) {
  const casinoPrice = normalizePrice(data.casino_price);
  const casinoAccepted = normalizeCasinoAccepted(data.casino_accepted, casinoPrice);

  return {
    domain: data.domain || null,
    publisher_email: data.publisher_email || null,
    publisher_name: data.publisher_name || null,
    guest_post_price: normalizePrice(data.guest_post_price),
    link_insertion_price: normalizePrice(data.link_insertion_price),
    sponsored_post_price: normalizePrice(data.sponsored_post_price),
    homepage_link_price: normalizePrice(data.homepage_link_price),
    casino_price: casinoPrice,
    casino_accepted: casinoAccepted,
    currency: data.currency || null,
    notes: data.notes || null,
    confidence: normalizeConfidence(data.confidence),
    needs_review: normalizeNeedsReview(data.needs_review, data.confidence)
  };
}

/**
 * Normalizes casino_accepted to 'yes' or 'no'
 * If casino_price exists, automatically set to 'yes'
 *
 * @param {*} casinoAccepted - casino_accepted value
 * @param {number|null} casinoPrice - Normalized casino price
 * @returns {string} 'yes' or 'no'
 */
function normalizeCasinoAccepted(casinoAccepted, casinoPrice) {
  // If casino price exists, casino is accepted
  if (casinoPrice) {
    return 'yes';
  }

  // Check for explicit yes/no values
  if (typeof casinoAccepted === 'string') {
    const normalized = casinoAccepted.toLowerCase().trim();
    if (normalized === 'yes' || normalized === 'true' || normalized === '1') {
      return 'yes';
    }
  }

  if (casinoAccepted === true || casinoAccepted === 1) {
    return 'yes';
  }

  return 'no';
}

/**
 * Normalizes price values to numbers or null
 *
 * @param {*} price - Price value to normalize
 * @returns {number|null} Normalized price
 */
function normalizePrice(price) {
  if (price === null || price === undefined || price === '') {
    return null;
  }

  const numPrice = typeof price === 'number' ? price : parseFloat(price);

  return !isNaN(numPrice) && numPrice > 0 ? numPrice : null;
}

/**
 * Normalizes confidence level to valid values
 *
 * @param {string} confidence - Confidence value
 * @returns {string} Normalized confidence ('high', 'medium', or 'low')
 */
function normalizeConfidence(confidence) {
  const validConfidences = ['high', 'medium', 'low'];
  const normalized = (confidence || 'low').toLowerCase();

  return validConfidences.includes(normalized) ? normalized : 'low';
}

/**
 * Normalizes needs_review flag to 1 or 0
 * Automatically sets to 1 if confidence is low
 *
 * @param {*} needsReview - needs_review value
 * @param {string} confidence - Confidence level
 * @returns {number} 1 or 0
 */
function normalizeNeedsReview(needsReview, confidence) {
  // Auto-flag for review if confidence is low
  if (confidence === 'low') {
    return 1;
  }

  // Convert various truthy values to 1, falsy to 0
  return needsReview === 1 || needsReview === true || needsReview === '1' ? 1 : 0;
}

/**
 * Validates that an extracted price actually appears in the email content
 * This prevents AI hallucination of prices that don't exist
 * STRICT: Requires price to appear with currency indicator to avoid DA/DR confusion
 *
 * @param {string} content - The email content
 * @param {number} price - The extracted price to validate
 * @returns {boolean} True if the price appears in content with currency context
 */
function priceExistsInContent(content, price) {
  if (!content || !price) return false;

  const priceStr = String(price);
  const priceNum = parseInt(price, 10);

  // STRICT patterns - require currency symbol or clear price context
  const strictPatterns = [
    // Price with currency symbols BEFORE the number (most common)
    `\\$\\s*${priceStr}`,
    `€\\s*${priceStr}`,
    `£\\s*${priceStr}`,
    `\\$\\s*${priceNum}`,
    `€\\s*${priceNum}`,
    `£\\s*${priceNum}`,
    // Price with currency code AFTER the number: "100 USD", "100USD"
    `${priceStr}\\s*(USD|EUR|GBP|INR|AUD|CAD)\\b`,
    `${priceNum}\\s*(USD|EUR|GBP|INR|AUD|CAD)\\b`,
    // Price with currency code BEFORE the number: "USD 100", "EUR100"
    `\\b(USD|EUR|GBP|INR|AUD|CAD)\\s*${priceStr}\\b`,
    `\\b(USD|EUR|GBP|INR|AUD|CAD)\\s*${priceNum}\\b`,
    // Price with decimal format
    `\\$\\s*${priceStr}\\.00`,
    `€\\s*${priceStr}\\.00`,
    `£\\s*${priceStr}\\.00`,
    // Price mentioned with pricing keywords nearby (within 20 chars)
    `(price|cost|rate|fee|charge)[^\\d]{0,20}${priceStr}`,
    `${priceStr}[^\\d]{0,20}(price|cost|rate|fee)`,
    // Price with currency word (singular and plural)
    `${priceStr}\\s*(dollars?|euros?|pounds?|rupees?)`,
    `(dollars?|euros?|pounds?|rupees?)[^\\d]{0,10}${priceStr}`,
    // Common response patterns: "is 100", "for 100", "at 100" after price context
    `(price|cost|rate|fee|charge)[^\\d]{0,15}(is|for|at|of)\\s*${priceStr}`,
    // "okay for 100", "deal at 100" - negotiation patterns
    `(okay|ok|agreed|deal|works)\\s*(for|at)\\s*${priceStr}`,
  ];

  for (const pattern of strictPatterns) {
    try {
      const regex = new RegExp(pattern, 'i');
      if (regex.test(content)) {
        console.log(`  → Price ${priceStr} validated: matches pattern "${pattern}"`);
        return true;
      }
    } catch (e) {
      // Skip invalid patterns
    }
  }

  // If no strict match found, check if price appears at all for logging
  const looseExists = content.includes(priceStr);
  if (looseExists) {
    console.log(`  → Price ${priceStr} found in content but NOT with currency context - rejecting`);
  } else {
    console.log(`  → Price ${priceStr} does NOT exist anywhere in content - hallucination detected`);
  }

  return false;
}

/**
 * Extracts ALL pricing entries from content that contains multiple domains (like Google Sheets)
 * @param {string} content - Content with multiple domain pricing (e.g., from a spreadsheet)
 * @returns {Promise<Array>} Array of pricing data objects
 */
async function extractMultiplePricing(content) {
  if (!content || typeof content !== 'string') {
    return [];
  }

  if (!config.openai?.apiKey) {
    throw new Error('OpenAI API key not configured');
  }

  try {
    const openai = new OpenAI({
      apiKey: config.openai.apiKey
    });

    // Truncate content if too large to avoid token limits
    const maxContentLength = 25000;
    const truncatedContent = content.length > maxContentLength
      ? content.substring(0, maxContentLength) + '\n\n[Content truncated...]'
      : content;

    console.log(`Processing ${content.length} chars (truncated to ${truncatedContent.length})`);

    const prompt = `Analyze the following content which contains a LIST of websites with pricing information.
Extract ALL domains and their pricing.

CONTENT:
${truncatedContent}

EXTRACTION INSTRUCTIONS:
1. Find ALL website domains mentioned with pricing
2. For each domain, extract:
   - domain (the website URL/domain)
   - guest_post_price (number or null)
   - link_insertion_price (number or null)
   - currency (USD, EUR, GBP, etc.)
   - notes (any conditions like "was £240" or "CBD extra")

CRITICAL - DO NOT CONFUSE METRICS WITH PRICES:
- DA (Domain Authority) and DR (Domain Rating) are METRICS, NOT PRICES! They range 1-100
- Columns labeled "DA", "DR", "Traffic", "TF", "CF" contain metrics, NOT prices
- Actual prices have currency symbols ($, €, £) or words like "Price", "Cost", "Rate"
- NEVER extract DA/DR values as guest_post_price or any price field

OUTPUT FORMAT (JSON array):
[
  {
    "domain": "example1.com",
    "guest_post_price": 150,
    "link_insertion_price": null,
    "currency": "USD",
    "notes": "any notes"
  },
  {
    "domain": "example2.com",
    "guest_post_price": 200,
    "link_insertion_price": 100,
    "currency": "GBP",
    "notes": "any notes"
  }
]

IMPORTANT:
- Return a JSON ARRAY of all domains found
- Each entry must have at least domain and one price
- Skip entries without any pricing
- Return empty array [] if no pricing found`;

    const response = await openai.chat.completions.create({
      model: config.openai.model,
      messages: [
        {
          role: 'system',
          content: 'You extract pricing data from spreadsheets and lists. Return valid JSON arrays only.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' }
    });

    const responseContent = response.choices[0]?.message?.content;
    if (!responseContent) {
      return [];
    }

    const parsed = JSON.parse(responseContent);

    // Handle both array format and object with array property
    const entries = Array.isArray(parsed) ? parsed : (parsed.domains || parsed.entries || parsed.data || []);

    // Normalize and filter entries
    return entries
      .filter(entry => entry.domain && (entry.guest_post_price || entry.link_insertion_price || entry.sponsored_post_price))
      .map(entry => ({
        domain: entry.domain,
        guest_post_price: normalizePrice(entry.guest_post_price),
        link_insertion_price: normalizePrice(entry.link_insertion_price),
        sponsored_post_price: normalizePrice(entry.sponsored_post_price),
        homepage_link_price: normalizePrice(entry.homepage_link_price),
        currency: entry.currency || 'USD',
        notes: entry.notes || null,
        confidence: 'high',
        needs_review: 0
      }));

  } catch (error) {
    console.error('Multi-domain extraction error:', error.message);
    return [];
  }
}

/**
 * Extracts pricing information for a SPECIFIC target domain from email content
 * This is optimized for finding pricing when we know what domain we're looking for
 *
 * @param {string} emailContent - The raw email content to analyze
 * @param {string} targetDomain - The specific domain to find pricing for
 * @returns {Promise<Object|null>} Pricing data for the target domain or null
 */
async function extractPricingForDomain(emailContent, targetDomain) {
  if (!emailContent || typeof emailContent !== 'string') {
    return null;
  }

  if (!config.openai?.apiKey) {
    throw new Error('OpenAI API key not configured');
  }

  try {
    const openai = new OpenAI({
      apiKey: config.openai.apiKey
    });

    const prompt = `You are analyzing an email to find pricing information for a SPECIFIC website domain.

TARGET DOMAIN TO FIND: ${targetDomain}

EMAIL CONTENT:
${emailContent}

EXTRACTION INSTRUCTIONS:
1. Search the email content for the target domain "${targetDomain}" (case-insensitive match)
2. The email may contain a table or list with multiple websites - find the row/entry for "${targetDomain}"
3. Extract the pricing for ONLY this target domain
4. IMPORTANT: Also check QUOTED/FORWARDED sections (lines starting with > or "From:") - these often contain the agreed price!
5. Look for phrases like "Price agreed - $X" or "Price: $X" or "$X per post" - these are the ACTUAL agreed prices

CRITICAL - NEGOTIATED PRICE DETECTION:
- If the email contains BOTH an initial quote AND a negotiated/counter-offer price, ALWAYS use the LOWER (negotiated) price
- Negotiation indicators: "okay for $X", "ok for $X", "agreed for $X", "deal at $X", "can do $X", "works for $X", "let's go with $X", "final price $X"
- If someone says "okay" or "agreed" or "deal" after a price is mentioned, that's the CONFIRMED price
- Example: Initial quote "$130" but later "okay for $55" → Use $55 (the agreed price)

PRIORITY FOR PRICE EXTRACTION (HIGHEST to LOWEST):
1. NEGOTIATED/CONFIRMED price - phrases like "okay for $X", "agreed $X", "deal done at $X" = USE THIS PRICE
2. Counter-offer accepted - if there's back-and-forth negotiation, use the FINAL agreed price
3. Direct price quote from webmaster = second priority
4. Price list/table entries = lowest priority

PRICING TYPES TO LOOK FOR:
- Guest Post / General Post / Sponsored Article / GP: Regular article placement price
- Link Insertion / LI: Adding a link to existing content
- Casino/Gambling/Forex/CBD/Crypto Price: Special pricing for restricted niches (OFTEN HIGHER than general price)

CRITICAL - DO NOT CONFUSE METRICS WITH PRICES:
- DA (Domain Authority) and DR (Domain Rating) are METRICS, NOT PRICES! They range 1-100 and measure website authority
- If you see columns like "DA", "DR", "Domain Authority", "Domain Rating", "Traffic", "TF", "CF" - these are NOT prices!
- Actual PRICE columns will have: currency symbols ($, €, £), words like "Price", "Cost", "Rate", "Fee", or larger numbers (typically $50-$2000)
- A value like "42" next to "DA" or "DR" means Domain Authority of 42, NOT $42 price
- NEVER extract DA/DR values as guest_post_price or any other price field
- Example: "dailyfinland.fi | DA: 42 | Price: €150" → guest_post_price is 150, NOT 42

CRITICAL CASINO PRICE RULES:
- IMPORTANT: Look carefully for a SEPARATE Casino/Forex/CBD/Crypto column in tables!
- Common table formats have columns like: "Domain | GP | Casino" or "Site | General | Casino/Forex"
- The casino price is OFTEN different (usually HIGHER, like 2x-5x) than the general price
- If you see TWO different prices for the same domain (e.g., "$20" and "$100"), the HIGHER one is likely the casino price
- If there's NO explicit restriction saying "casino not accepted", "no gambling", "grey niche rejected" etc., then casino IS accepted
- When casino is accepted but no separate price is explicitly stated: casino_price = same as guest_post_price
- ONLY set casino_accepted to "no" if there's explicit text rejecting casino/gambling content
- ONLY set casino_price to null if casino is explicitly NOT accepted

OUTPUT FORMAT (JSON only):
{
  "found": true or false,
  "guest_post_price": number or null,
  "link_insertion_price": number or null,
  "sponsored_post_price": number or null,
  "homepage_link_price": number or null,
  "casino_price": number or null,
  "casino_accepted": "yes" or "no",
  "currency": "USD" or "EUR" or "GBP",
  "confidence": "high" or "medium" or "low",
  "notes": "any relevant notes about pricing or multipliers applied"
}

IMPORTANT:
- Return found: false if the target domain is not found in the content
- Return found: false if no pricing is found for the target domain
- Prices must be numbers only (no currency symbols)
- Default casino_accepted to "yes" unless explicitly rejected in the email

STRICT VALIDATION - DO NOT HALLUCINATE:
- ONLY return a price if there is an EXPLICIT price value directly associated with the target domain
- The price must appear on the SAME LINE or SAME TABLE ROW as the target domain
- The price must have a currency symbol ($, €, £) OR be in a clearly labeled price column
- If the domain is just MENTIONED but has no price next to it, return found: false
- If you're unsure whether a number is a price or a metric (DA/DR/Traffic), return found: false
- NEVER guess or infer prices - only extract explicitly stated prices
- If the sheet/table row for this domain has empty price cells, return found: false
- A price like "$150" or "€200" is explicit. A number like "42" without context is NOT a price
- Do NOT use prices from OTHER domains in the same email - each domain has its own price
- If the row for "${targetDomain}" shows empty/blank price cells, return found: false
- WHEN IN DOUBT, return found: false - it's better to miss a price than to report a wrong one`;

    const response = await openai.chat.completions.create({
      model: config.openai.model,
      messages: [
        {
          role: 'system',
          content: 'You extract pricing data for specific domains from emails. You must respond with valid JSON only. Be VERY conservative - only return prices you are 100% certain belong to the target domain. When in doubt, return found: false.'
        },
        {
          role: 'user',
          content: prompt + `

FINAL VERIFICATION: Before returning, verify:
1. Is "${targetDomain}" explicitly listed?
2. Is there a price ON THE SAME LINE/ROW as "${targetDomain}"?
3. Is that price clearly monetary (has $ € £ or in "Price" column)?
If ANY answer is NO, return {"found": false}`
        }
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' }
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      return null;
    }

    const extracted = JSON.parse(content);

    console.log(`  GPT extraction for ${targetDomain}:`, JSON.stringify(extracted));

    // If domain not found, return null
    if (!extracted.found) {
      console.log(`  → GPT returned found: false for ${targetDomain}`);
      return null;
    }

    // CODE-LEVEL VALIDATION: Verify the extracted price actually appears in the email
    const extractedGuestPrice = extracted.guest_post_price;
    const extractedCasinoPrice = extracted.casino_price;

    // If a price was extracted, verify it exists in the content
    if (extractedGuestPrice && !priceExistsInContent(emailContent, extractedGuestPrice)) {
      console.log(`  → REJECTED: Price ${extractedGuestPrice} not found in email content for ${targetDomain} (possible hallucination)`);
      return null;
    }

    if (extractedCasinoPrice && extractedCasinoPrice !== extractedGuestPrice && !priceExistsInContent(emailContent, extractedCasinoPrice)) {
      console.log(`  → REJECTED: Casino price ${extractedCasinoPrice} not found in email content for ${targetDomain} (possible hallucination)`);
      // Don't reject entirely, just null out the casino price
      extracted.casino_price = null;
    }

    // Normalize the data
    const guestPostPrice = normalizePrice(extracted.guest_post_price);
    const linkInsertionPrice = normalizePrice(extracted.link_insertion_price);
    let casinoPrice = normalizePrice(extracted.casino_price);
    const casinoAccepted = extracted.casino_accepted?.toLowerCase() !== 'no';

    // Apply casino price logic: if casino is accepted but no explicit price, use general price
    if (casinoAccepted && !casinoPrice && guestPostPrice) {
      casinoPrice = guestPostPrice;
    }

    // If casino is not accepted, ensure price is null
    if (!casinoAccepted) {
      casinoPrice = null;
    }

    return {
      guest_post_price: guestPostPrice,
      link_insertion_price: linkInsertionPrice,
      sponsored_post_price: normalizePrice(extracted.sponsored_post_price),
      homepage_link_price: normalizePrice(extracted.homepage_link_price),
      casino_price: casinoPrice,
      casino_accepted: casinoAccepted ? 'yes' : 'no',
      currency: extracted.currency || 'USD',
      confidence: normalizeConfidence(extracted.confidence),
      notes: extracted.notes || null
    };

  } catch (error) {
    console.error('Extraction error for domain:', targetDomain, error.message);
    return null;
  }
}

module.exports = {
  extractPricing,
  extractMultiplePricing,
  extractPricingForDomain
};
