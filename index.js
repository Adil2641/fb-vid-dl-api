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
 * Extracts media ID and type from various Facebook URL formats
 * @param {string} input - Can be ID or full URL
 * @returns {object} {id: string, type: 'video'|'reel'|'shared_video'|'shared_reel'|null}
 */
function extractMediaId(input) {
  if (!input) return { id: null, type: null };
  
  // If it's already a numeric ID (assume video)
  if (/^\d+$/.test(input)) return { id: input, type: 'video' };

  try {
    const url = new URL(input.includes('://') ? input : `https://${input}`);
    const host = url.hostname.replace('www.', '');
    
    // Main Facebook domains
    if (host.includes('facebook.com') || host.includes('fb.watch') || host.includes('fb.com')) {
      // Standard Reel URL
      const reelMatch = url.pathname.match(/\/(?:reel|reels)\/(\d+)/i);
      if (reelMatch) return { id: reelMatch[1], type: 'reel' };
      
      // Shared Reel URL (from mobile or share)
      const sharedReelMatch = url.pathname.match(/\/videos\/reel\/(\d+)/i) || 
                             url.pathname.match(/\/watch\/\?story_fbid=(\d+)/i);
      if (sharedReelMatch) return { id: sharedReelMatch[1], type: 'shared_reel' };
      
      // Standard Video URL
      if (url.pathname === '/watch/' && url.searchParams.get('v')) {
        return { id: url.searchParams.get('v'), type: 'video' };
      }
      
      // Shared Video URL (from posts)
      const videoMatch = url.pathname.match(/\/videos\/(?:\d+)\/(\d+)/i) || 
                        url.pathname.match(/\/video\.php\?(?:.*)v=(\d+)/i);
      if (videoMatch) return { id: videoMatch[1], type: 'shared_video' };
      
      // FB Watch URL
      if (host.includes('fb.watch')) {
        return { id: url.pathname.split('/')[1], type: 'video' };
      }
      
      // Mobile share links
      if (url.searchParams.get('story_fbid')) {
        return { id: url.searchParams.get('story_fbid'), type: 'shared_reel' };
      }
    }
  } catch (e) {
    console.error('URL parsing error:', e.message);
  }
  
  return { id: null, type: null };
}

/**
 * Extracts media URLs and metadata from Facebook
 * @param {string} mediaId - Facebook media ID
 * @param {string} mediaType - Type of media
 * @returns {Promise<Object>} Object containing media data
 */
async function extractMediaData(mediaId, mediaType) {
  try {
    let url;
    switch(mediaType) {
      case 'reel':
      case 'shared_reel':
        url = `https://www.facebook.com/reel/${mediaId}`;
        break;
      case 'video':
      case 'shared_video':
      default:
        url = `https://www.facebook.com/watch/?v=${mediaId}`;
    }

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

    // Extract video URLs
    const urlPatterns = {
      hd: /(?:hd|high_quality)_src\s*[=:]\s*["']([^"']+)/i,
      sd: /(?:sd|standard_quality)_src\s*[=:]\s*["']([^"']+)/i,
      fallback: /(?:video|src)_src\s*[=:]\s*["']([^"']+)/i
    };

    const downloadLinks = {};
    for (const [quality, pattern] of Object.entries(urlPatterns)) {
      const match = pageContent.match(pattern);
      if (match && match[1]) downloadLinks[quality] = match[1];
    }

    // Extract metadata
    const titleMatch = pageContent.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(' | Facebook', '').trim() : null;
    
    const descriptionMatch = pageContent.match(/<meta\s+name="description"\s+content="([^"]+)/i);
    const description = descriptionMatch ? descriptionMatch[1].trim() : null;

    const thumbnailMatch = pageContent.match(/<meta\s+property="og:image"\s+content="([^"]+)/i);
    const thumbnail = thumbnailMatch ? thumbnailMatch[1] : null;

    return {
      success: true,
      mediaId,
      mediaType,
      metadata: {
        title,
        description,
        thumbnail,
        sourceUrl: url
      },
      downloadLinks,
      timestamp: new Date().toISOString()
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
  
  const input = videoId || reelId || url;
  if (!input) {
    return res.status(400).json({
      success: false,
      message: 'Either videoId, reelId, or url parameter is required',
      example: '/download?url=https://www.facebook.com/username/videos/123456789'
    });
  }

  const { id: mediaId, type: mediaType } = extractMediaId(input);
  if (!mediaId || !mediaType) {
    return res.status(400).json({
      success: false,
      message: 'Invalid Facebook video/reel URL format',
      supportedFormats: [
        'Video ID: 123456789',
        'Video URL: https://www.facebook.com/watch/?v=123456789',
        'Shared Video: https://www.facebook.com/username/videos/123456789/',
        'Reel URL: https://www.facebook.com/reel/123456789',
        'Shared Reel: https://www.facebook.com/username/posts/123456789',
        'Mobile Share: https://m.facebook.com/story.php?story_fbid=123456789',
        'FB Watch: https://fb.watch/abcde12345/'
      ]
    });
  }

  try {
    const mediaData = await extractMediaData(mediaId, mediaType);
    
    if (!mediaData.success) {
      return res.status(404).json(mediaData);
    }

    res.json(mediaData);
  } catch (error) {
    console.error(`API Error: ${error.message}`);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    version: '1.1.0'
  });
});

// Documentation endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'Facebook Video & Reel Downloader API',
    description: 'Download videos and reels including shared content from posts',
    version: '1.1.0',
    endpoints: {
      download: {
        method: 'GET',
        parameters: {
          videoId: 'Numeric video ID',
          reelId: 'Numeric reel ID',
          url: 'Full Facebook URL'
        },
        examples: [
          '/download?url=https://www.facebook.com/watch/?v=123456789',
          '/download?url=https://www.facebook.com/reel/123456789',
          '/download?url=https://m.facebook.com/story.php?story_fbid=123456789',
          '/download?videoId=123456789',
          '/download?reelId=123456789'
        ]
      },
      health: {
        method: 'GET',
        description: 'Service health check'
      }
    }
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running in ${process.env.NODE_ENV} mode on port ${PORT}`);
  console.log(`API documentation: http://localhost:${PORT}/`);
});

module.exports = app;