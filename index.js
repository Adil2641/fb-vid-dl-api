require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later'
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(limiter);

// Video URL extraction
async function getFacebookVideoUrls(videoId) {
  try {
    const url = `https://www.facebook.com/watch/?v=${videoId}`;
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      },
      timeout: 10000
    });

    const $ = cheerio.load(response.data);
    const html = $.html();

    const hdRegex = /hd_src:"([^"]+)"/;
    const sdRegex = /sd_src:"([^"]+)"/;
    
    const hdUrl = html.match(hdRegex)?.[1];
    const sdUrl = html.match(sdRegex)?.[1];

    return {
      hd: hdUrl,
      sd: sdUrl,
      success: true
    };
  } catch (error) {
    console.error('Error:', error.message);
    return {
      success: false,
      message: error.response?.status === 404 ? 'Video not found' : 'Failed to fetch video'
    };
  }
}

// API Endpoint
app.get('/download', async (req, res) => {
  const { videoId } = req.query;
  
  if (!videoId || !/^\d+$/.test(videoId)) {
    return res.status(400).json({
      success: false,
      message: 'Valid numeric video ID is required'
    });
  }

  try {
    const videoData = await getFacebookVideoUrls(videoId);
    
    if (!videoData.success || (!videoData.hd && !videoData.sd)) {
      return res.status(404).json(videoData);
    }
    
    res.json({
      success: true,
      videoId,
      downloadLinks: videoData
    });
  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});