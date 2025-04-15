require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      message: 'Too many requests, please try again later.'
    });
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(limiter);

/**
 * Extracts video/reel ID from various Facebook URL formats
 * @param {string} input - Can be ID or full URL
 * @returns {object} {id: string, type: 'video'|'reel'|null}
 */
function extractMediaId(input) {
  if (!input) return { id: null, type: null };
  
  // If it's already a numeric ID (assume video)
  if (/^\d+$/.test(input)) return { id: input, type: 'video' };

  try {
    const url = new URL(input.includes('://') ? input : `https://${input}`);
    
    if (url.hostname.includes('facebook.com') || url.hostname.includes('fb.watch')) {
      // Reels format: https://www.facebook.com/reel/123456789
      const reelMatch = url.pathname.match(/\/reel\/(\d+)/);
      if (reelMatch) return { id: reelMatch[1], type: 'reel' };
      
      // Watch format: https://www.facebook.com/watch/?v=123456789
      if (url.pathname === '/watch/' && url.searchParams.get('v')) {
        return { id: url.searchParams.get('v'), type: 'video' };
      }
      
      // Video format: https://www.facebook.com/username/videos/123456789/
      const videoMatch = url.pathname.match(/\/videos\/(\d+)/);
      if (videoMatch) return { id: videoMatch[1], type: 'video' };
      
      // FB Watch format: https://fb.watch/abcde12345/
      if (url.hostname.includes('fb.watch')) {
        return { id: url.pathname.split('/')[1], type: 'video' };
      }
    }
  } catch (e) {
    console.error('URL parsing error:', e.message);
  }
  
  return { id: null, type: null };
}

/**
 * Extracts video/reel URLs from Facebook
 * @param {string} mediaId - Facebook media ID
 * @param {string} mediaType - 'video' or 'reel'
 * @returns {Promise<Object>} Object containing media URLs and status
 */
async function extractMediaUrls(mediaId, mediaType) {
  try {
    const url = mediaType === 'reel' 
      ? `https://www.facebook.com/reel/${mediaId}`
      : `https://www.facebook.com/watch/?v=${mediaId}`;

    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
      },
      timeout: 10000
    });

    const $ = cheerio.load(response.data);
    const pageContent = $.html();

    // Patterns for both videos and reels
    const urlPatterns = {
      hd: /(?:hd|high_quality)_src\s*[=:]\s*["']([^"']+)/i,
      sd: /(?:sd|standard_quality)_src\s*[=:]\s*["']([^"']+)/i,
      fallback: /(?:video|src)_src\s*[=:]\s*["']([^"']+)/i
    };

    const results = {};
    for (const [quality, pattern] of Object.entries(urlPatterns)) {
      const match = pageContent.match(pattern);
      if (match && match[1]) results[quality] = match[1];
    }

    return {
      ...results,
      success: true,
      mediaId,
      mediaType
    };
  } catch (error) {
    console.error(`Extraction Error: ${error.message}`);
    return {
      success: false,
      message: error.response?.status === 404 ? 'Media not found' : 'Failed to process media',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    };
  }
}

// API Endpoints
app.get('/download', async (req, res) => {
  const { videoId, reelId, url } = req.query;
  
  // Use either specific ID or URL parameter
  const input = videoId || reelId || url;
  if (!input) {
    return res.status(400).json({
      success: false,
      message: 'Either videoId, reelId, or url parameter is required'
    });
  }

  // Extract media ID and type
  const { id: mediaId, type: mediaType } = extractMediaId(input);
  if (!mediaId || !mediaType) {
    return res.status(400).json({
      success: false,
      message: 'Invalid Facebook video/reel ID or URL format',
      supportedFormats: [
        'Video ID: 123456789',
        'Video URL: https://www.facebook.com/watch/?v=123456789',
        'Video URL: https://www.facebook.com/username/videos/123456789/',
        'Reel URL: https://www.facebook.com/reel/123456789',
        'FB Watch URL: https://fb.watch/abcde12345/'
      ]
    });
  }

  try {
    const mediaData = await extractMediaUrls(mediaId, mediaType);
    
    if (!mediaData.success) {
      return res.status(404).json(mediaData);
    }

    res.json({
      success: true,
      originalInput: input,
      mediaId,
      mediaType,
      downloadLinks: {
        hd: mediaData.hd,
        sd: mediaData.sd,
        fallback: mediaData.fallback
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error(`API Error: ${error.message}`);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Health and status endpoints
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  res.json({
    service: 'Facebook Video & Reel Downloader API',
    status: 'running',
    endpoints: {
      download: {
        description: 'Download video or reel by ID or URL',
        parameters: {
          videoId: 'Facebook video ID',
          reelId: 'Facebook reel ID',
          url: 'Full Facebook video/reel URL'
        },
        examples: [
          '/download?url=https://www.facebook.com/watch/?v=123456789',
          '/download?url=https://www.facebook.com/reel/123456789',
          '/download?videoId=123456789',
          '/download?reelId=123456789'
        ]
      },
      health: '/health'
    }
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(`Unhandled Error: ${err.stack}`);
  res.status(500).json({
    success: false,
    message: 'An unexpected error occurred'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running in ${process.env.NODE_ENV} mode on port ${PORT}`);
});