require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// Enhanced rate limiting
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

// Video URL extraction with improved error handling
async function extractVideoUrls(videoId) {
  try {
    const url = `https://www.facebook.com/watch/?v=${videoId}`;
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      timeout: 10000
    });

    const $ = cheerio.load(response.data);
    const pageContent = $.html();

    // Enhanced regex patterns
    const urlPatterns = {
      hd: /(?:hd|high_quality)_src\s*[=:]\s*["']([^"']+)/i,
      sd: /(?:sd|standard_quality)_src\s*[=:]\s*["']([^"']+)/i
    };

    const results = {};
    for (const [quality, pattern] of Object.entries(urlPatterns)) {
      const match = pageContent.match(pattern);
      results[quality] = match ? match[1] : null;
    }

    return {
      ...results,
      success: true
    };
  } catch (error) {
    console.error(`Extraction Error: ${error.message}`);
    return {
      success: false,
      message: error.response?.status === 404 ? 'Video not found' : 'Failed to process video',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    };
  }
}

// API Endpoints
app.get('/download', async (req, res) => {
  const { videoId } = req.query;
  
  if (!videoId || !/^\d+$/.test(videoId)) {
    return res.status(400).json({
      success: false,
      message: 'Valid numeric video ID is required'
    });
  }

  try {
    const videoData = await extractVideoUrls(videoId);
    
    if (!videoData.success) {
      return res.status(404).json(videoData);
    }

    res.json({
      success: true,
      videoId,
      downloadLinks: videoData,
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
    service: 'Facebook Video Downloader API',
    status: 'running',
    endpoints: {
      download: '/download?videoId=VIDEO_ID',
      health: '/health'
    },
    documentation: 'Add your documentation link here'
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