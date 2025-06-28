// index.js - Google Cloud Function for Website Scraping and Screenshotting

// Import necessary Google Cloud libraries
const { Storage } = require('@google-cloud/storage');
const { Firestore } = require('@google-cloud/firestore'); // Import Firestore

// Import Puppeteer-core and @sparticuz/chromium
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

// Import Firebase Admin SDK for initializing Firestore in the server environment
const admin = require('firebase-admin');

// Initialize Google Cloud Storage client
const storage = new Storage();

// IMPORTANT: Updated with your provided bucket name.
const BUCKET_NAME = 'website-screenshots-by-labratorium'; 

// Initialize Firebase Admin SDK (for Firestore access)
// Use default credentials when running in Google Cloud Functions environment
admin.initializeApp();
const db = admin.firestore(); // Initialize Firestore

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

// IMPORTANT: New list for excluding policy/terms/privacy pages
const EXCLUDED_URL_KEYWORDS = [
    'privacy-policy',
    'privacy',
    'terms-of-service',
    'terms',
    'legal',
    'disclaimer',
    'cookie-policy',
    'gdpr',
    'ccpa'
    // Add more keywords as needed, e.g., 'about-us' if you want to exclude that too
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

    // Extract URL, email, and optionally userId from the request body
    const { url, email, userId } = req.body; 

    // Basic input validation
    if (!url || !email || !userId) { 
        console.error('Missing URL, Email, or UserId in request body.');
        return res.status(400).json({ error: 'Website URL, Email, and User ID are required.' });
    }

    console.log(`Received request for URL: ${url}, Email: ${email}, UserId: ${userId}`);

    let browser = null; 
    const visitedUrls = new Set(); 
    const pagesToVisit = [normalizeUrl(url)]; 

    // Generate a unique Job ID for this scraping task
    const jobId = `scrape_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    // Define the Firestore collection path for this job's results
    const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
    const jobResultsCollectionRef = db.collection(`artifacts/${appId}/users/${userId}/scrape_results`).doc(jobId).collection('pages');

    // Respond immediately to the frontend with the jobId, so it can start listening for updates.
    res.status(202).json({ 
        message: 'Scraping job started. Please monitor results via job ID.',
        jobId: jobId,
        userId: userId 
    });

    const MAX_PAGES_TO_CRAWL = 50; 

    try {
        browser = await puppeteer.launch({
            args: [...chromium.args, '--disable-gpu'], 
            defaultViewport: { width: 1920, height: 1080 }, 
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        });

        // Loop through pages to visit
        while (pagesToVisit.length > 0 && visitedUrls.size < MAX_PAGES_TO_CRAWL) {
            const currentUrl = pagesToVisit.shift(); 
            const normalizedCurrentUrl = normalizeUrl(currentUrl); 

            try {
                new URL(normalizedCurrentUrl); 
            } catch (e) {
                console.warn(`Invalid URL skipped: ${normalizedCurrentUrl}`);
                continue;
            }

            // --- IMPORTANT CHANGE HERE: Exclude policy/terms pages ---
            const urlPath = new URL(normalizedCurrentUrl).pathname.toLowerCase();
            const urlHostname = new URL(normalizedCurrentUrl).hostname.toLowerCase();
            let shouldExclude = false;
            for (const keyword of EXCLUDED_URL_KEYWORDS) {
                if (urlPath.includes(keyword) || urlHostname.includes(keyword)) {
                    shouldExclude = true;
                    break;
                }
            }

            if (shouldExclude) {
                console.log(`Skipping excluded page: ${normalizedCurrentUrl} (contains policy/terms keyword).`);
                visitedUrls.add(normalizedCurrentUrl); // Still mark as visited to avoid re-processing
                continue; // Skip to the next URL
            }
            // --- End IMPORTANT CHANGE ---

            if (visitedUrls.has(normalizedCurrentUrl)) {
                console.log(`Already visited (normalized): ${normalizedCurrentUrl}. Skipping.`);
                continue;
            }

            visitedUrls.add(normalizedCurrentUrl); 
            console.log(`Navigating to: ${normalizedCurrentUrl} (Pages visited: ${visitedUrls.size}/${MAX_PAGES_TO_CRAWL})`);

            let page = null; 
            try {
                page = await browser.newPage(); 
                page.setDefaultNavigationTimeout(120000); 

                await page.setRequestInterception(true);
                page.on('request', (req) => {
                    const resourceType = req.resourceType();
                    const url = req.url();

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

                await page.goto(normalizedCurrentUrl, { waitUntil: ['domcontentloaded', 'load'], timeout: 120000 });
                
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
                await delay(1000); 

                const perceivedScrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
                console.log(`[Diagnostic] Page ${normalizedCurrentUrl} perceived scrollHeight: ${perceivedScrollHeight}px`);

                const now = new Date();
                const timestamp = now.getFullYear().toString() +
                                  (now.getMonth() + 1).toString().padStart(2, '0') +
                                  now.getDate().toString().padStart(2, '0') +
                                  now.getHours().toString().padStart(2, '0') +
                                  now.getMinutes().toString().padStart(2, '0') +
                                  now.getSeconds().toString().padStart(2, '0');

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

                const htmlContent = await page.content();
                const htmlFileName = `html/${fileNameBase}.html`;
                const htmlFileRef = storage.bucket(BUCKET_NAME).file(htmlFileName);
                await htmlFileRef.save(htmlContent, {
                    contentType: 'text/html',
                    public: true, 
                });
                const htmlPublicUrl = `https://storage.googleapis.com/${BUCKET_NAME}/${htmlFileName}`;
                console.log(`Saved HTML for ${normalizedCurrentUrl} to: ${htmlPublicUrl}`);

                const screenshotBuffer = await page.screenshot({
                    type: 'jpeg',
                    quality: 80, 
                    fullPage: true, 
                });
                const screenshotFileName = `screenshots/${fileNameBase}.jpeg`;
                const screenshotFileRef = storage.bucket(BUCKET_NAME).file(screenshotFileName);
                await screenshotFileRef.save(screenshotBuffer, {
                    contentType: 'image/jpeg',
                    public: true, 
                });
                const screenshotPublicUrl = `https://storage.googleapis.com/${BUCKET_NAME}/${screenshotFileName}`;
                console.log(`Saved screenshot for ${normalizedCurrentUrl} to: ${screenshotPublicUrl}`);

                await jobResultsCollectionRef.add({
                    originalUrl: normalizedCurrentUrl,
                    htmlUrl: htmlPublicUrl,
                    screenshotUrl: screenshotPublicUrl,
                    timestamp: admin.firestore.FieldValue.serverTimestamp(), 
                    fileName: fileNameBase
                });
                console.log(`Saved result for ${normalizedCurrentUrl} to Firestore.`);

                await page.close(); 
                console.log(`Page for ${normalizedCurrentUrl} closed.`);

                const linksPage = await browser.newPage();
                await linksPage.setRequestInterception(true);
                linksPage.on('request', (req) => {
                    const resourceType = req.resourceType();
                    const url = req.url();
                    
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
                        // Exclude identified policy/terms pages from further crawling as well
                        const normalizedLinkPath = new URL(normalizedLink).pathname.toLowerCase();
                        const normalizedLinkHostname = new URL(normalizedLink).hostname.toLowerCase();
                        let isExcludedLink = false;
                        for (const keyword of EXCLUDED_URL_KEYWORDS) {
                            if (normalizedLinkPath.includes(keyword) || normalizedLinkHostname.includes(keyword)) {
                                isExcludedLink = true;
                                break;
                            }
                        }

                        if (!visitedUrls.has(normalizedLink) && !pagesToVisit.includes(normalizedLink) && !isExcludedLink) {
                            pagesToVisit.push(normalizedLink);
                        } else if (isExcludedLink) {
                            console.log(`Not adding excluded link to queue: ${normalizedLink} (contains policy/terms keyword).`);
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

    } catch (error) {
        console.error('An unexpected error occurred:', error);
    } finally {
        if (browser) {
            await browser.close();
            console.log('Browser closed.');
        }
        console.log(`Scraping job ${jobId} finished (or timed out).`);
    }
};
