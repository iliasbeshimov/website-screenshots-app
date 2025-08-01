# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Google Cloud Function for website scraping and screenshotting. The application crawls websites, takes screenshots of subpages, and stores results in Google Cloud Storage. It includes both a serverless backend (Node.js) and frontend HTML interfaces.

## Architecture

- **Backend**: Google Cloud Function (`index.js`) using Puppeteer with Chromium for web scraping
- **Frontend**: Two HTML interfaces - `index.html` (standalone) and `embed.html` (WordPress embeddable)
- **Storage**: Google Cloud Storage bucket (`website-screenshots-by-labratorium`)
- **Authentication**: Firebase Auth (frontend) with anonymous/custom token authentication

## Key Components

### Core Backend (`index.js`)
- Main export: `exports.scrapeAndScreenshot` - HTTP-triggered Cloud Function
- Security features: SSRF protection, URL validation, file size limits, domain blocking
- Web scraping: Puppeteer-core with @sparticuz/chromium for serverless execution
- Resource limits: 25 pages max, 10MB screenshot limit, 5MB HTML limit, 5-minute timeout

### Frontend Files
- `index.html`: Full standalone application with Tailwind CSS
- `embed.html`: WordPress-embeddable version with inline styles
- Both use Firebase SDK for user authentication and make requests to the Cloud Function

## Development Commands

### Local Development
```bash
npm start          # Runs the function locally (basic Node.js execution)
```

### Deployment
Deploy to Google Cloud Functions:
```bash
gcloud functions deploy scrapeAndScreenshot \
  --runtime nodejs20 \
  --trigger-http \
  --allow-unauthenticated \
  --memory 2GB \
  --timeout 540s
```

## Security Considerations

The application implements multiple security layers:
- SSRF protection blocking private networks and dangerous ports
- Input validation for URLs and email addresses  
- File size limits and resource constraints
- Domain blocking for analytics, ads, and tracking services
- Sanitized filename generation to prevent path traversal
- Error message sanitization to prevent information disclosure

## Configuration

### Required Environment/Configuration
- Google Cloud Storage bucket: `website-screenshots-by-labratorium`
- Cloud Function URL: `https://us-central1-screenshots-app-459900.cloudfunctions.net/scrapeAndScreenshot`
- Firebase configuration (embedded in frontend files)

### Key Constants
- `MAX_PAGES_TO_CRAWL`: 25 pages
- `MAX_SCREENSHOT_SIZE`: 10MB
- `MAX_HTML_SIZE`: 5MB
- `MAX_EXECUTION_TIME`: 5 minutes
- `MAX_URL_LENGTH`: 2048 characters

## File Structure
```
├── index.js           # Main Cloud Function
├── package.json       # Node.js dependencies
├── index.html         # Standalone frontend
├── embed.html         # WordPress embeddable frontend
```

## Dependencies

### Backend
- `@google-cloud/storage`: Google Cloud Storage client
- `puppeteer-core`: Headless browser automation
- `@sparticuz/chromium`: Chromium binary for serverless environments

### Frontend
- Firebase SDK (CDN): Authentication and Firestore
- Tailwind CSS (CDN): Styling for `index.html`