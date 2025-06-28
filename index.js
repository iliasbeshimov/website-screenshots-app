// index.js - Google Cloud Function for Website Scraping and Screenshotting

// Import necessary Google Cloud libraries
const { Storage } = require('@google-cloud/storage');

// Import Puppeteer-core and @sparticuz/chromium
// @sparticuz/chromium provides a compatible Chromium executable for serverless environments.
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

// Initialize Google Cloud Storage client
const storage = new Storage();

// IMPORTANT: Updated with your provided bucket name.
const BUCKET_NAME = 'website-screenshots-by-labratorium'; 

/**
 * Normalizes a URL to ensure consistent comparison and filename generation.
 * This function handles protocol, www prefix, trailing slashes, and sorts query parameters.
 * @param {string} urlString The URL to normalize.
 * @returns {string} The normalized URL string.
 */
function normalizeUrl(urlString) {
    try {
        const url = new URL(urlString);

        // Force HTTPS
        url.protocol = 'https:';

        // Remove 'www.' if present, as long as it's not the entire hostname (e.g., 'www.com' should stay)
        let hostname = url.hostname;
        if (hostname.startsWith('www.') && hostname.length > 4 && hostname.includes('.')) {
            hostname = hostname.substring(4);
        }
        url.hostname = hostname;

        // Path normalization: For root path, use '/'; for others, remove trailing slash.
        let pathname = url.pathname;
        if (pathname === '') { // If no path, set to root
            pathname = '/';
        } else if (pathname.length > 1 && pathname.endsWith('/')) { // Remove trailing slash for non-root paths
            pathname = pathname.slice(0, -1);
        }
        url.pathname = pathname;

        // Sort search parameters for consistency
        if (url.search) {
            const params = new URLSearchParams(url.search);
            params.sort();
            url.search = params.toString();
        } else {
            url.search = ''; // Ensure no empty search string
        }
        url.hash = ''; // Remove hash fragments

        // Reconstruct the URL string to ensure consistent format for comparison
        let normalized = `${url.protocol}//${url.hostname}`;
        // Only include port if it's not the default for HTTPS (443) or HTTP (80)
        if (url.port && !((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80'))) {
            normalized += `:${url.port}`;
        }
        normalized += url.pathname;
        if (url.search) {
            normalized += url.search;
        }
        return normalized;
    } catch (e) {
        console.warn(`Error normalizing URL "${urlString}": ${e.message}`);
        return urlString; // Return original if invalid
    }
}

/**
 * Helper function to introduce a delay.
 * @param {number} ms The number of milliseconds to wait.
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// List of common third-party domains to block to speed up page loading and reduce memory usage.
// This list is not exhaustive but covers many common analytics, advertising, and tracking services.
const BLOCKED_DOMAINS = [
    'google-analytics.com', 'googletagmanager.com', 'googlesyndication.com', 'googleadservices.com',
    'doubleclick.net', 'adservice.google.com', 'ads.google.com', 'ad.doubleclick.net',
    'facebook.com/tr', 'facebook.net', 'fbq.js', 'connect.facebook.net', // Facebook pixel/SDK
    'hotjar.com', 'static.hotjar.com', // Heatmap/analytics
    'clarity.ms', // Microsoft Clarity
    'linkedin.com/analytics', 'licdn.com', // LinkedIn analytics/tracking
    'pixel.cookielaw.com', 'cookielaw.org', // Cookie consent tracking
    'analytics.google.com', 'g.doubleclick.net', 'stats.g.doubleclick.net',
    'sentry.io', // Error tracking
    'segment.io', // Customer data platform
    'intercom.io', // Chat/support widgets
    'fullstory.com', // Session replay
    'newrelic.com', // Performance monitoring
    'cloudflareinsights.com', // Cloudflare analytics
    'onesignal.com', // Push notifications
    'crisp.chat', // Chat widget
    'drift.com', // Chat widget
    'freshchat.com', // Chat widget
    'zendesk.com', // Support widget
    'vimeo.com/api', 'youtube.com/api', // Video APIs if not crucial for screenshot
    'maps.google.com', 'maps.googleapis.com', // Google Maps APIs
    'fonts.googleapis.com', 'fonts.gstatic.com', // Google Fonts (can be blocked if not critical to layout)
    'cdn.jsdelivr.net', 'cdnjs.cloudflare.com', // Common CDNs (can contain various scripts, block selectively if impacting)
    'use.typekit.net', // Adobe Fonts
    'stripe.com', 'paypal.com', // Payment processors (often load scripts)
    'platform.twitter.com', 'platform.linkedin.com', 'platform.instagram.com', // Social media widgets
    'gravatar.com', // User avatars
    'googletagservices.com',
    'cdn.taboola.com', 'cdn.outbrain.com', // Content recommendation engines
    'bing.com/analytics', 'bat.bing.com' // Bing analytics
];

/**
 * Entry point for the Cloud Function.
 * This function will be triggered by an HTTP POST request from your frontend.
 *
 * @param {object} req The HTTP request object.
 * @param {object} res The HTTP response object.
 */
exports.scrapeAndScreenshot = async (req, res) => {
    // Set CORS headers for the response
    res.set('Access-Control-Allow-Origin', '*'); 

    if (req.method === 'OPTIONS') {
        res.set('Access-Control-Allow-Methods', 'POST'); 
        res.set('Access-Control-Allow-Headers', 'Content-Type'); 
        res.set('Access-Control-Max-Age', '3600'); 
        return res.status(204).send('');
    }

    // Extract URL and email from the request body
    const { url, email } = req.body;

    // Basic input validation
    if (!url || !email) {
        console.error('Missing URL or Email in request body.');
        return res.status(400).json({ error: 'Website URL and Email are required.' });
    }

    console.log(`Received request for URL: ${url}, Email: ${email}`);

    let browser = null; 
    const visitedUrls = new Set(); 
    const pagesToVisit = [normalizeUrl(url)]; // Normalize initial URL
    const screenshotFiles = []; 
    const htmlFiles = [];       

    // Limit the number of pages to crawl to prevent excessive resource usage and cost.
    // The function will stop seeking new URLs once this limit is reached for visited pages.
    const MAX_PAGES_TO_CRAWL = 50; 

    try {
        browser = await puppeteer.launch({
            args: [...chromium.args, '--disable-gpu'], 
            defaultViewport: { width: 1920, height: 1080 }, // Using a standard desktop resolution
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        });

        // Loop through pages to visit
        while (pagesToVisit.length > 0 && visitedUrls.size < MAX_PAGES_TO_CRAWL) {
            const currentUrl = pagesToVisit.shift(); 
            const normalizedCurrentUrl = normalizeUrl(currentUrl); // Normalize before checking visited

            try {
                new URL(normalizedCurrentUrl); 
            } catch (e) {
                console.warn(`Invalid URL skipped: ${normalizedCurrentUrl}`);
                continue;
            }

            if (visitedUrls.has(normalizedCurrentUrl)) {
                console.log(`Already visited (normalized): ${normalizedCurrentUrl}. Skipping.`);
                continue;
            }

            visitedUrls.add(normalizedCurrentUrl); 
            console.log(`Navigating to: ${normalizedCurrentUrl} (Pages visited: ${visitedUrls.size}/${MAX_PAGES_TO_CRAWL})`);

            let page = null; // Declare page locally within the loop
            try {
                page = await browser.newPage(); // Create a new page for each URL
                page.setDefaultNavigationTimeout(120000); // Increased to 2 minutes (120000 ms)

                // --- Enable request interception for resource blocking ---
                await page.setRequestInterception(true);
                page.on('request', (req) => {
                    const resourceType = req.resourceType();
                    const url = req.url();

                    // Block resources that are generally not visual or critical for layout
                    // Removed 'stylesheet' from this list to prevent layout issues
                    if (['font', 'media', 'manifest', 'other'].includes(resourceType)) {
                        req.abort();
                        return;
                    }
                    
                    // Block requests to known third-party domains (more reliable for non-visual elements)
                    if (BLOCKED_DOMAINS.some(domain => url.includes(domain))) {
                        req.abort();
                        return;
                    }

                    req.continue();
                });

                // Use ['domcontentloaded', 'load'] for main page load
                await page.goto(normalizedCurrentUrl, { waitUntil: ['domcontentloaded', 'load'], timeout: 120000 });
                
                // --- Scroll the page down to load all elements ---
                let lastScrollHeight = 0;
                let scrollAttempts = 0;
                const maxScrollAttempts = 10; 

                while (scrollAttempts < maxScrollAttempts) {
                    const newScrollHeight = await page.evaluate(() => {
                        window.scrollBy(0, window.innerHeight); 
                        return document.documentElement.scrollHeight;
                    });

                    await delay(500); 

                    if (newScrollHeight === lastScrollHeight) {
                        break;
                    }
                    lastScrollHeight = newScrollHeight;
                    scrollAttempts++;
                }
                await page.evaluate(() => window.scrollTo(0, 0));
                await delay(1000); // Give it a bit more time to settle after scrolling

                // --- Diagnostic Log: Check page's perceived scroll height ---
                const perceivedScrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
                console.log(`[Diagnostic] Page ${normalizedCurrentUrl} perceived scrollHeight: ${perceivedScrollHeight}px`);


                // --- Generate Timestamp for Filename ---
                const now = new Date();
                const timestamp = now.getFullYear().toString() +
                                  (now.getMonth() + 1).toString().padStart(2, '0') +
                                  now.getDate().toString().padStart(2, '0') +
                                  now.getHours().toString().padStart(2, '0') +
                                  now.getMinutes().toString().padStart(2, '0') +
                                  now.getSeconds().toString().padStart(2, '0');

                // --- Generate File Name from URL ---
                const urlObj = new URL(normalizedCurrentUrl);
                let fullPath = urlObj.hostname + urlObj.pathname;
                
                if (fullPath.endsWith('/') && fullPath !== urlObj.hostname + '/') {
                    fullPath = fullPath.slice(0, -1);
                }

                let baseNameFromUrl = fullPath.replace(/\./g, '-').replace(/\//g, '-');

                baseNameFromUrl = baseNameFromUrl.replace(/--+/g, '-');

                baseNameFromUrl = baseNameFromUrl.replace(/^-+|-+$/g, '');

                if (baseNameFromUrl.length === 0) {
                    baseNameFromUrl = urlObj.hostname.replace(/\./g, '-');
                }
                if (normalizedCurrentUrl === normalizeUrl(urlObj.origin + '/')) { 
                    baseNameFromUrl = urlObj.hostname.replace(/\./g, '-');
                }
                baseNameFromUrl = baseNameFromUrl.replace(/[^a-zA-Z0-9-]/g, '');

                const fileNameBase = `${baseNameFromUrl}-${timestamp}`;

                // --- Save HTML Content ---
                const htmlContent = await page.content();
                const htmlFileName = `html/${fileNameBase}.html`;
                const htmlFileRef = storage.bucket(BUCKET_NAME).file(htmlFileName);
                await htmlFileRef.save(htmlContent, {
                    contentType: 'text/html',
                    public: true, 
                });
                const htmlPublicUrl = `https://storage.googleapis.com/${BUCKET_NAME}/${htmlFileName}`;
                htmlFiles.push({ name: `${fileNameBase}.html`, url: htmlPublicUrl });
                console.log(`Saved HTML for ${normalizedCurrentUrl} to: ${htmlPublicUrl}`);

                // --- Take Screenshot ---
                const screenshotBuffer = await page.screenshot({
                    type: 'jpeg',
                    quality: 80, 
                    fullPage: true, // IMPORTANT: Re-enabled to capture the entire page
                });
                const screenshotFileName = `screenshots/${fileNameBase}.jpeg`;
                const screenshotFileRef = storage.bucket(BUCKET_NAME).file(screenshotFileName);
                await screenshotFileRef.save(screenshotBuffer, {
                    contentType: 'image/jpeg',
                    public: true, 
                });
                const screenshotPublicUrl = `https://storage.googleapis.com/${BUCKET_NAME}/${screenshotFileName}`;
                screenshotFiles.push({ name: `${fileNameBase}.jpeg`, url: screenshotPublicUrl });
                console.log(`Saved screenshot for ${normalizedCurrentUrl} to: ${screenshotPublicUrl}`);

                await page.close(); 
                console.log(`Page for ${normalizedCurrentUrl} closed.`);

                // --- Find Subpages ---
                const linksPage = await browser.newPage();
                // Enable request interception for linksPage as well
                await linksPage.setRequestInterception(true);
                linksPage.on('request', (req) => {
                    const resourceType = req.resourceType();
                    const url = req.url();
                    
                    // Block resources that are generally not visual or critical for layout
                    // Removed 'stylesheet' from this list to prevent layout issues
                    if (['font', 'media', 'manifest', 'other'].includes(resourceType)) {
                        req.abort();
                        return;
                    }

                    if (BLOCKED_DOMAINS.some(domain => url.includes(domain))) {
                        req.abort();
                        return;
                    }
                    
                    req.continue();
                });

                // Use ['domcontentloaded', 'load'] for linksPage as well
                await linksPage.goto(normalizedCurrentUrl, { waitUntil: ['domcontentloaded', 'load'], timeout: 120000 }); 
                const links = await linksPage.evaluate(() => {
                    const anchors = Array.from(document.querySelectorAll('a'));
                    let currentCanonicalHostname = window.location.hostname;
                    if (currentCanonicalHostname.startsWith('www.') && currentCanonicalHostname.length > 4 && currentCanonicalHostname.includes('.')) {
                        currentCanonicalHostname = currentCanonicalHostname.substring(4);
                    }

                    return anchors
                        .map(a => a.href)
                        .filter(href => {
                            try {
                                const linkUrl = new URL(href);
                                if (linkUrl.protocol !== 'http:' && linkUrl.protocol !== 'https:') {
                                    return false;
                                }

                                let linkCanonicalHostname = linkUrl.hostname;
                                if (linkCanonicalHostname.startsWith('www.') && linkCanonicalHostname.length > 4 && linkCanonicalHostname.includes('.')) {
                                    linkCanonicalHostname = linkCanonicalHostname.substring(4);
                                }

                                return linkCanonicalHostname === currentCanonicalHostname &&
                                       !linkUrl.hash && !href.startsWith('mailto:') && !href.startsWith('tel:');
                            } catch (e) {
                                return false; 
                            }
                        });
                });
                await linksPage.close(); 


                links.forEach(link => {
                    if (visitedUrls.size < MAX_PAGES_TO_CRAWL) { 
                        const normalizedLink = normalizeUrl(link);
                        if (!visitedUrls.has(normalizedLink) && !pagesToVisit.includes(normalizedLink)) {
                            pagesToVisit.push(normalizedLink);
                        }
                    } else {
                        console.log('Max pages to crawl reached. Stopping discovery of new URLs.');
                    }
                });

            } catch (pageError) {
                console.error(`Error processing page ${normalizedCurrentUrl}:`, pageError.message);
                if (page && !page.isClosed()) {
                    await page.close();
                }
            }
        }

        // --- Email Sending Logic (Placeholder) ---
        // ... (existing email sending placeholder code remains here) ...

        res.status(200).json({
            message: 'Processing complete. HTML and screenshots are available for testing.',
            htmlFiles: htmlFiles,
            screenshotFiles: screenshotFiles,
            emailSent: false 
        });

    } catch (error) {
        console.error('An unexpected error occurred:', error);
        res.status(500).json({
            error: `An unexpected error occurred: ${error.message}`,
            details: error.stack
        });
    } finally {
        if (browser) {
            await browser.close();
            console.log('Browser closed.');
        }
    }
};
