// index.js - Secure Google Cloud Function for Website Scraping and Screenshotting

// Import necessary Google Cloud libraries
const { Storage } = require('@google-cloud/storage');

// Import Puppeteer-core and @sparticuz/chromium
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

// Import JSZip for creating ZIP files
const JSZip = require('jszip');

// Initialize Google Cloud Storage client
const storage = new Storage();

// IMPORTANT: Updated with your provided bucket name.
const BUCKET_NAME = 'website-screenshots-by-labratorium';

// Security and resource constraints
const MAX_PAGES_TO_CRAWL = 25; // Reduced from 50 for security
const MAX_SCREENSHOT_SIZE = 10 * 1024 * 1024; // 10MB limit
const MAX_HTML_SIZE = 5 * 1024 * 1024; // 5MB limit
const MAX_EXECUTION_TIME = 300000; // 5 minutes
const MAX_URL_LENGTH = 2048; // Maximum URL length
const MAX_EMAIL_LENGTH = 254; // Maximum email length

/**
 * Validates URL for security (SSRF protection)
 * @param {string} urlString The URL to validate
 * @returns {string} The validated URL
 * @throws {Error} If URL is invalid or poses security risk
 */
function validateUrl(urlString) {
    if (!urlString || typeof urlString !== 'string') {
        throw new Error('URL is required and must be a string');
    }
    
    if (urlString.length > MAX_URL_LENGTH) {
        throw new Error('URL is too long');
    }
    
    try {
        const url = new URL(urlString);
        
        // Only allow HTTP/HTTPS protocols
        if (!['http:', 'https:'].includes(url.protocol)) {
            throw new Error('Only HTTP and HTTPS protocols are allowed');
        }
        
        // Block private/internal networks (SSRF protection)
        const hostname = url.hostname.toLowerCase();
        
        // Block localhost variations
        if (['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(hostname) ||
            hostname.startsWith('192.168.') ||
            hostname.startsWith('10.') ||
            hostname.startsWith('172.16.') ||
            hostname.startsWith('172.17.') ||
            hostname.startsWith('172.18.') ||
            hostname.startsWith('172.19.') ||
            hostname.match(/^172\.(2[0-9]|3[01])\./) ||
            hostname.includes('metadata.google.internal') ||
            hostname.includes('metadata') ||
            hostname === '169.254.169.254') {
            throw new Error('Private/internal network access is not allowed');
        }
        
        // Block dangerous ports
        const dangerousPorts = [22, 23, 25, 53, 110, 143, 993, 995, 3306, 5432, 6379, 27017];
        if (url.port && dangerousPorts.includes(parseInt(url.port))) {
            throw new Error('Access to this port is not allowed');
        }
        
        // Additional hostname validation
        if (hostname.includes('..') || hostname.startsWith('.') || hostname.endsWith('.')) {
            throw new Error('Invalid hostname format');
        }
        
        return url.toString();
    } catch (error) {
        if (error.message.includes('Invalid URL')) {
            throw new Error('Invalid URL format');
        }
        throw error;
    }
}

/**
 * Validates email address
 * @param {string} email The email to validate
 * @returns {string} The validated and normalized email
 * @throws {Error} If email is invalid
 */
function validateEmail(email) {
    if (!email || typeof email !== 'string') {
        throw new Error('Email is required and must be a string');
    }
    
    const trimmedEmail = email.trim();
    
    if (trimmedEmail.length > MAX_EMAIL_LENGTH) {
        throw new Error('Email address is too long');
    }
    
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(trimmedEmail)) {
        throw new Error('Invalid email format');
    }
    
    // Additional security checks
    if (trimmedEmail.includes('..') || trimmedEmail.startsWith('.') || trimmedEmail.endsWith('.')) {
        throw new Error('Invalid email format');
    }
    
    return trimmedEmail.toLowerCase();
}

/**
 * Sanitizes filename to prevent path traversal and other issues
 * @param {string} input The input string to sanitize
 * @returns {string} The sanitized filename
 */
function sanitizeFileName(input) {
    if (!input || typeof input !== 'string') {
        return 'unnamed';
    }
    
    return input
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '') // Remove dangerous chars
        .replace(/\.+/g, '-') // Replace dots with hyphens
        .replace(/\s+/g, '-') // Replace spaces with hyphens
        .replace(/--+/g, '-') // Replace multiple hyphens with single
        .replace(/^-+|-+$/g, '') // Remove leading/trailing hyphens
        .substring(0, 100) // Limit length
        .toLowerCase(); // Normalize case
}

/**
 * Creates a safe error response without sensitive information
 * @param {string} message Safe error message for user
 * @param {Error} originalError Original error for logging
 * @returns {Object} Safe error response
 */
function createSafeError(message, originalError = null) {
    // Log full error for debugging
    if (originalError) {
        console.error('Full error details:', originalError);
    }
    
    // Return sanitized error to user
    return {
        error: message,
        timestamp: new Date().toISOString()
    };
}

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

// Enhanced list of blocked domains for security and performance
const BLOCKED_DOMAINS = [
    // Analytics & Tracking
    'google-analytics.com', 'googletagmanager.com', 'googlesyndication.com', 'googleadservices.com',
    'doubleclick.net', 'adservice.google.com', 'ads.google.com', 'ad.doubleclick.net',
    'facebook.com/tr', 'facebook.net', 'fbq.js', 'connect.facebook.net',
    'hotjar.com', 'static.hotjar.com', 'clarity.ms', 'linkedin.com/analytics', 'licdn.com',
    'pixel.cookielaw.com', 'cookielaw.org', 'analytics.google.com', 'g.doubleclick.net', 
    'stats.g.doubleclick.net', 'segment.io', 'fullstory.com', 'cloudflareinsights.com',
    
    // Ads & Marketing
    'taboola.com', 'outbrain.com', 'cdn.taboola.com', 'cdn.outbrain.com', 'adsystem.com',
    'bing.com/analytics', 'bat.bing.com',
    
    // Chat & Support Widgets
    'intercom.io', 'crisp.chat', 'drift.com', 'freshchat.com', 'zendesk.com',
    
    // Other Services
    'sentry.io', 'newrelic.com', 'onesignal.com', 'gravatar.com', 'googletagservices.com',
    'use.typekit.net', 'stripe.com', 'paypal.com', 'platform.twitter.com', 
    'platform.linkedin.com', 'platform.instagram.com',
    
    // Security: Block metadata and internal services
    'metadata.google.internal', 'metadata', '169.254.169.254', 'localhost'
];

// Keywords to exclude policy/terms/privacy pages
const EXCLUDED_URL_KEYWORDS = [
    'privacy-policy', 'privacy', 'terms-of-service', 'terms', 'legal', 'disclaimer',
    'cookie-policy', 'gdpr', 'ccpa', 'terms-and-conditions', 'privacy-notice'
];

/**
 * Main scraping function with timeout protection
 * @param {object} req The HTTP request object
 * @param {object} res The HTTP response object
 */
async function performScraping(req, res) {
    // Extract and validate inputs
    const { url } = req.body;

    if (!url) {
        console.error('Missing URL in request body.');
        return res.status(400).json(createSafeError('Website URL is required.'));
    }

    // Validate URL for security (SSRF protection)
    let validatedUrl;
    try {
        validatedUrl = validateUrl(url);
    } catch (error) {
        console.error(`URL validation failed: ${error.message}`);
        return res.status(400).json(createSafeError(error.message));
    }

    console.log(`Received validated request for URL: ${validatedUrl}`);

    let browser = null;
    const visitedUrls = new Set();
    const pagesToVisit = [normalizeUrl(validatedUrl)];

    // Arrays to store results for the final response
    const screenshotFiles = [];
    const htmlFiles = [];

    try {
        console.log('[DEBUG] Attempting to launch Puppeteer browser...');
        browser = await puppeteer.launch({
            args: [...chromium.args, '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage'],
            defaultViewport: { width: 1920, height: 1080 },
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
            timeout: 60000
        });
        console.log('[DEBUG] Puppeteer browser launched successfully.');

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

            // Check for excluded keywords
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
                visitedUrls.add(normalizedCurrentUrl);
                continue;
            }

            if (visitedUrls.has(normalizedCurrentUrl)) {
                console.log(`Already visited (normalized): ${normalizedCurrentUrl}. Skipping.`);
                continue;
            }

            visitedUrls.add(normalizedCurrentUrl);
            console.log(`Navigating to: ${normalizedCurrentUrl} (Pages visited: ${visitedUrls.size}/${MAX_PAGES_TO_CRAWL})`);

            let page = null;
            try {
                console.log(`[DEBUG] Creating new page for ${normalizedCurrentUrl}...`);
                page = await browser.newPage();
                page.setDefaultNavigationTimeout(120000);

                // Enhanced request interception for security
                await page.setRequestInterception(true);
                page.on('request', (req) => {
                    const resourceType = req.resourceType();
                    const requestUrl = req.url();

                    // Block dangerous resource types
                    if (['font', 'media', 'manifest', 'other', 'websocket'].includes(resourceType)) {
                        req.abort();
                        return;
                    }

                    // Block non-HTTP protocols in requests
                    if (!requestUrl.startsWith('http://') && !requestUrl.startsWith('https://')) {
                        req.abort();
                        return;
                    }

                    // Block known dangerous domains
                    if (BLOCKED_DOMAINS.some(domain => requestUrl.includes(domain))) {
                        req.abort();
                        return;
                    }

                    req.continue();
                });

                console.log(`[DEBUG] Navigating to ${normalizedCurrentUrl}...`);
                const navigationPromise = page.waitForNavigation({ 
                    waitUntil: ['domcontentloaded', 'load'], 
                    timeout: 120000 
                });
                
                await Promise.all([
                    navigationPromise,
                    page.goto(normalizedCurrentUrl, { 
                        waitUntil: ['domcontentloaded', 'load'], 
                        timeout: 120000 
                    })
                ]);
                console.log(`[DEBUG] Page ${normalizedCurrentUrl} loaded and settled.`);

                // Controlled scrolling
                let lastScrollHeight = 0;
                let scrollAttempts = 0;
                const maxScrollAttempts = 5; // Reduced for security

                console.log(`[DEBUG] Starting scroll for ${normalizedCurrentUrl}...`);
                while (scrollAttempts < maxScrollAttempts) {
                    const newScrollHeight = await page.evaluate(() => {
                        window.scrollBy(0, window.innerHeight);
                        return document.documentElement.scrollHeight;
                    });

                    await delay(1000);

                    if (newScrollHeight === lastScrollHeight) {
                        break;
                    }
                    lastScrollHeight = newScrollHeight;
                    scrollAttempts++;
                }
                await page.evaluate(() => window.scrollTo(0, 0));
                await delay(2000);
                console.log(`[DEBUG] Scroll completed for ${normalizedCurrentUrl}.`);

                // Extract links before taking screenshot
                console.log(`[DEBUG] Extracting links from ${normalizedCurrentUrl}...`);
                let links = [];
                
                try {
                    links = await page.evaluate(() => {
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
                } catch (linkExtractionError) {
                    console.error(`Failed to extract links from ${normalizedCurrentUrl}: ${linkExtractionError.message}`);
                    links = [];
                }
                console.log(`[DEBUG] Links extracted from ${normalizedCurrentUrl}. Found ${links.length} links.`);

                // Generate secure filename
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

                let baseNameFromUrl = sanitizeFileName(fullPath);
                if (baseNameFromUrl.length === 0 || baseNameFromUrl === 'unnamed') {
                    baseNameFromUrl = sanitizeFileName(urlObj.hostname);
                }

                if (normalizedCurrentUrl === normalizeUrl(urlObj.origin + '/')) {
                    baseNameFromUrl = sanitizeFileName(urlObj.hostname);
                }

                const fileNameBase = sanitizeFileName(`${baseNameFromUrl}-${timestamp}`);

                // Save HTML with size validation
                console.log(`[DEBUG] Saving HTML for ${normalizedCurrentUrl}...`);
                const htmlContent = await page.content();

                // Validate HTML size
                if (Buffer.byteLength(htmlContent, 'utf8') > MAX_HTML_SIZE) {
                    console.warn(`HTML content too large for ${normalizedCurrentUrl}: ${Buffer.byteLength(htmlContent, 'utf8')} bytes. Skipping.`);
                } else {
                    const htmlFileName = `html/${fileNameBase}.html`;
                    const htmlFileRef = storage.bucket(BUCKET_NAME).file(htmlFileName);
                    await htmlFileRef.save(htmlContent, {
                        contentType: 'text/html',
                        public: true,
                    });
                    const htmlPublicUrl = `https://storage.googleapis.com/${BUCKET_NAME}/${htmlFileName}`;
                    htmlFiles.push({ name: `${fileNameBase}.html`, url: htmlPublicUrl });
                    console.log(`Saved HTML for ${normalizedCurrentUrl} to: ${htmlPublicUrl}`);
                }

                // Take screenshot with size validation
                console.log(`[DEBUG] Taking screenshot for ${normalizedCurrentUrl}...`);
                const screenshotBuffer = await page.screenshot({
                    type: 'jpeg',
                    quality: 80,
                    fullPage: true,
                });

                // Validate screenshot size
                if (screenshotBuffer.length > MAX_SCREENSHOT_SIZE) {
                    console.warn(`Screenshot too large for ${normalizedCurrentUrl}: ${screenshotBuffer.length} bytes. Skipping.`);
                } else {
                    const screenshotFileName = `screenshots/${fileNameBase}.jpeg`;
                    const screenshotFileRef = storage.bucket(BUCKET_NAME).file(screenshotFileName);
                    await screenshotFileRef.save(screenshotBuffer, {
                        contentType: 'image/jpeg',
                        public: true,
                    });
                    const screenshotPublicUrl = `https://storage.googleapis.com/${BUCKET_NAME}/${screenshotFileName}`;
                    screenshotFiles.push({ name: `${fileNameBase}.jpeg`, url: screenshotPublicUrl });
                    console.log(`Saved screenshot for ${normalizedCurrentUrl} to: ${screenshotPublicUrl}`);
                }

                // Close page
                await page.close();
                console.log(`Page for ${normalizedCurrentUrl} closed.`);

                // Process extracted links
                console.log(`[DEBUG] Processing ${links.length} extracted links from ${normalizedCurrentUrl}`);
                let linksAdded = 0;
                
                links.forEach(link => {
                    try {
                        if (visitedUrls.size < MAX_PAGES_TO_CRAWL) {
                            const normalizedLink = normalizeUrl(link);
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
                                linksAdded++;
                            }
                        }
                    } catch (linkError) {
                        console.warn(`Error processing link ${link}: ${linkError.message}`);
                    }
                });
                
                console.log(`Added ${linksAdded} new links to queue. Queue: ${pagesToVisit.length}, Visited: ${visitedUrls.size}`);

            } catch (pageError) {
                console.error(`Error processing page ${normalizedCurrentUrl}:`, pageError.message);
                if (page && !page.isClosed()) {
                    await page.close().catch(console.error);
                }
            }
        }

        // Send successful response
        res.status(200).json({
            message: 'Scraping job finished successfully.',
            htmlFiles: htmlFiles,
            screenshotFiles: screenshotFiles,
            pagesProcessed: visitedUrls.size
        });

    } catch (error) {
        console.error('An unexpected error occurred:', error);
        res.status(500).json(createSafeError(
            'An internal error occurred while processing your request. Please try again later.',
            error
        ));
    } finally {
        // Enhanced cleanup
        if (browser) {
            try {
                const pages = await browser.pages();
                await Promise.all(pages.map(page => {
                    if (!page.isClosed()) {
                        return page.close().catch(console.error);
                    }
                }));

                await browser.close();
                console.log('Browser and all pages closed.');
            } catch (cleanupError) {
                console.error('Error during cleanup:', cleanupError);
            }
        }

        // Clear large objects
        screenshotFiles.length = 0;
        htmlFiles.length = 0;
        visitedUrls.clear();
        pagesToVisit.length = 0;

        console.log('Scraping job finished and resources cleaned up.');
    }
}

/**
 * Validates that the request comes from an allowed domain
 * @param {object} req The HTTP request object
 * @returns {boolean} True if domain is allowed, false otherwise
 */
function validateDomain(req) {
    // List of allowed domains/origins
    const allowedDomains = [
        'labratorium.com',
        'localhost',
        '127.0.0.1'
    ];

    const origin = req.headers.origin || req.headers.referer;
    
    if (!origin) {
        console.warn('Request missing origin/referer header');
        return false;
    }

    // Check if origin matches any allowed domain (including subdomains)
    const isAllowed = allowedDomains.some(allowedDomain => {
        try {
            const originUrl = new URL(origin);
            const hostname = originUrl.hostname;
            
            // Allow exact match or subdomain match
            return hostname === allowedDomain || 
                   hostname.endsWith('.' + allowedDomain);
        } catch (e) {
            return false;
        }
    });

    if (!isAllowed) {
        console.warn(`Request from unauthorized domain: ${origin}`);
    }

    return isAllowed;
}

/**
 * Downloads files from GCS and creates a ZIP
 * @param {object} req The HTTP request object
 * @param {object} res The HTTP response object
 */
async function downloadFilesAsZip(req, res) {
    try {
        const { files, type } = req.body;
        
        if (!files || !Array.isArray(files) || files.length === 0) {
            return res.status(400).json(createSafeError('No files provided'));
        }
        
        if (!type || !['html', 'screenshots'].includes(type)) {
            return res.status(400).json(createSafeError('Invalid type. Must be "html" or "screenshots"'));
        }
        
        console.log(`Creating ZIP for ${files.length} ${type} files`);
        
        const zip = new JSZip();
        const folder = zip.folder(type === 'html' ? 'html-files' : 'screenshots');
        
        // Download each file from GCS and add to ZIP
        for (const file of files) {
            try {
                const fileName = file.name;
                const gcsPath = type === 'html' ? `html/${fileName}` : `screenshots/${fileName}`;
                
                const gcsFile = storage.bucket(BUCKET_NAME).file(gcsPath);
                const [fileContent] = await gcsFile.download();
                
                folder.file(fileName, fileContent);
            } catch (fileError) {
                console.error(`Failed to download ${file.name}:`, fileError.message);
                // Continue with other files
            }
        }
        
        // Generate ZIP buffer
        const zipBuffer = await zip.generateAsync({
            type: 'nodebuffer',
            compression: 'DEFLATE',
            compressionOptions: { level: 6 }
        });
        
        console.log(`ZIP generated, size: ${zipBuffer.length} bytes`);
        
        // Send ZIP file as response
        const fileName = type === 'html' ? 'html-files.zip' : 'screenshots.zip';
        res.set({
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="${fileName}"`,
            'Content-Length': zipBuffer.length
        });
        
        res.send(zipBuffer);
        
    } catch (error) {
        console.error('ZIP download error:', error);
        res.status(500).json(createSafeError('Failed to create ZIP file'));
    }
}

/**
 * Entry point for the Cloud Function with timeout protection.
 * This function will be triggered by an HTTP POST request from your frontend.
 *
 * @param {object} req The HTTP request object.
 * @param {object} res The HTTP response object.
 */
exports.scrapeAndScreenshot = async (req, res) => {
    // Validate domain before processing request
    if (!validateDomain(req)) {
        return res.status(403).json(createSafeError(
            'Requests are only allowed from authorized domains'
        ));
    }

    // Set CORS headers for the response (restrict to allowed origins)
    const origin = req.headers.origin;
    if (origin && validateDomain(req)) {
        res.set('Access-Control-Allow-Origin', origin);
    }

    if (req.method === 'OPTIONS') {
        res.set('Access-Control-Allow-Methods', 'POST');
        res.set('Access-Control-Allow-Headers', 'Content-Type');
        res.set('Access-Control-Max-Age', '3600');
        return res.status(204).send('');
    }

    // Check if this is a ZIP download request
    if (req.body && req.body.action === 'download-zip') {
        return downloadFilesAsZip(req, res);
    }

    // Global timeout protection
    const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Operation timeout exceeded')), MAX_EXECUTION_TIME);
    });

    try {
        await Promise.race([
            performScraping(req, res),
            timeoutPromise
        ]);
    } catch (error) {
        if (error.message === 'Operation timeout exceeded') {
            console.error('Operation timed out');
            return res.status(408).json(createSafeError('Request timeout - operation took too long'));
        }
        
        console.error('Unexpected error in main handler:', error);
        if (!res.headersSent) {
            res.status(500).json(createSafeError(
                'An internal error occurred while processing your request. Please try again later.',
                error
            ));
        }
    }
};