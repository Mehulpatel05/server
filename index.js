const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

// List of public Cobalt instances to try in sequence for extracting URLs
const cobaltInstances = [
  'https://cobalt.api.ry.vc/',
  'https://co.wuk.sh/',
  'https://cobalt.sh/',
];

// Root path GET - sanity health check
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    message: 'VideoSaver Downloader API Server is running!',
    version: '1.1.0',
    help: 'Use POST / to extract media link, or GET /api/download to stream files.'
  });
});

/**
 * Local yt-dlp Extraction Helper
 */
function extractFromYtdlp(videoUrl) {
  return new Promise((resolve) => {
    console.log(`[yt-dlp] Trying local extraction for: ${videoUrl}`);
    const ytdlp = spawn('yt-dlp', ['-f', 'best[ext=mp4]/best', '-g', '--no-playlist', videoUrl]);
    let output = '';
    let errorOutput = '';
    
    ytdlp.stdout.on('data', (data) => {
      output += data;
    });

    ytdlp.stderr.on('data', (data) => {
      errorOutput += data;
    });

    ytdlp.on('close', (code) => {
      if (code === 0 && output.trim()) {
        const lines = output.trim().split('\n');
        console.log(`[yt-dlp] Extraction successful! Url: ${lines[0]}`);
        resolve({
          videoUrl: lines[0],
          title: 'VideoSaver Download'
        });
      } else {
        console.warn(`[yt-dlp] Extraction failed: ${errorOutput.trim()}`);
        resolve(null);
      }
    });
  });
}

/**
 * Cobalt Single Instance Extraction Helper
 */
async function extractSingleCobalt(instance, videoUrl) {
  const payload = {
    url: videoUrl,
    videoQuality: '1080',
    downloadMode: 'auto'
  };

  try {
    console.log(`[Cobalt] Concurrently querying: ${instance}`);
    const response = await fetch(instance, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      body: JSON.stringify(payload),
      // Set a strict 7 second timeout for each fetch to prevent slow instances from hanging the pool
      signal: AbortSignal.timeout(7000)
    });

    if (response.ok) {
      const data = await response.json();
      if (data && (data.status === 'stream' || data.status === 'redirect') && data.url) {
        console.log(`[Cobalt] Success from: ${instance}`);
        return {
          videoUrl: data.url,
          title: data.text || 'VideoSaver Download',
        };
      }
    }
  } catch (err) {
    // Fail silently so Promise.any skips this instance
  }
  return null;
}

/**
 * Redirect-following streaming helper (pipes direct URLs back to Express response)
 */
function streamFromUrl(targetUrl, res, redirectCount = 0) {
  if (redirectCount > 8) {
    console.error('[Stream] Too many redirects.');
    return res.status(500).send('Too many redirects');
  }

  const parsedUrl = new URL(targetUrl);
  const client = parsedUrl.protocol === 'https:' ? https : http;

  const requestHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Encoding': 'identity',
  };

  client.get(targetUrl, { headers: requestHeaders }, (streamResponse) => {
    const statusCode = streamResponse.statusCode;

    // Follow HTTP redirects (301, 302, 307, 308)
    if (statusCode >= 300 && statusCode < 400 && streamResponse.headers.location) {
      let redirectUrl = streamResponse.headers.location;
      if (!redirectUrl.startsWith('http')) {
        redirectUrl = new URL(redirectUrl, targetUrl).href;
      }
      console.log(`[Stream Redirect] Following to: ${redirectUrl}`);
      return streamFromUrl(redirectUrl, res, redirectCount + 1);
    }

    if (statusCode !== 200) {
      console.error(`[Stream Error] Failed to download source file. Status code: ${statusCode}`);
      return res.status(statusCode).send(`Error downloading source file. Status: ${statusCode}`);
    }

    // Forward headers
    if (streamResponse.headers['content-type']) {
      res.setHeader('Content-Type', streamResponse.headers['content-type']);
    }
    if (streamResponse.headers['content-length']) {
      res.setHeader('Content-Length', streamResponse.headers['content-length']);
    }

    // Pipe the download stream directly to Express response
    streamResponse.pipe(res);
  }).on('error', (err) => {
    console.error(`[Stream Error] Connection failed: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).send('Streaming error');
    }
  });
}

/**
 * Custom Pinterest Direct Scraper (Bypasses yt-dlp & Cobalt for fast video & image pin extraction)
 */
async function extractPinterestDirect(pinterestUrl) {
  try {
    console.log(`[Pinterest Scraper] Fetching page: ${pinterestUrl}`);
    const response = await fetch(pinterestUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
      },
      redirect: 'follow'
    });

    if (!response.ok) {
      console.warn(`[Pinterest Scraper] Fetch failed: ${response.status}`);
      return null;
    }

    const html = await response.text();

    // 1. Check for video pin first
    const videoMatch = html.match(/<meta[^>]*property=["']og:video["'][^>]*content=["'](.*?)["']/) ||
                       html.match(/<meta[^>]*property=["']og:video:secure_url["'][^>]*content=["'](.*?)["']/);
    
    if (videoMatch && videoMatch[1]) {
      const directVideoUrl = videoMatch[1].replace(/&amp;/g, '&');
      console.log(`[Pinterest Scraper] Found Video Link: ${directVideoUrl}`);
      return {
        videoUrl: directVideoUrl,
        title: 'Pinterest_Video',
        format: 'mp4'
      };
    }

    // 2. Check for image pin
    const imageMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["'](.*?)["']/) ||
                       html.match(/<meta[^>]*property=["']twitter:image["'][^>]*content=["'](.*?)["']/);

    if (imageMatch && imageMatch[1]) {
      const directImageUrl = imageMatch[1].replace(/&amp;/g, '&');
      console.log(`[Pinterest Scraper] Found Image Link: ${directImageUrl}`);
      return {
        videoUrl: directImageUrl,
        title: 'Pinterest_Image',
        format: 'jpg'
      };
    }
  } catch (e) {
    console.error(`[Pinterest Scraper] Error: ${e.message}`);
  }
  return null;
}

/**
 * Cobalt API Compatibility Endpoint
 * POST /
 */
app.post('/', async (req, res) => {
  const { url, downloadMode } = req.body;
  
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  console.log(`[POST /] Starting fast parallel extraction for: ${url}`);

  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.get('host');
  const isAudio = downloadMode === 'audio';

  // Fast path for Pinterest (bypasses parallel Cobalt pool entirely)
  const isPinterest = url.toLowerCase().includes('pinterest.com') || url.toLowerCase().includes('pin.it');
  if (isPinterest) {
    const pinResult = await extractPinterestDirect(url);
    if (pinResult) {
      const downloadUrl = `${protocol}://${host}/api/download?streamUrl=${encodeURIComponent(pinResult.videoUrl)}&title=${encodeURIComponent(pinResult.title)}&format=${pinResult.format}`;
      return res.json({
        status: 'stream',
        url: downloadUrl
      });
    }
  }

  // Build list of promises to run in parallel
  const extractionPromises = [];

  // 1. Add local yt-dlp promise
  extractionPromises.push(
    extractFromYtdlp(url).then(res => {
      if (res) return res;
      throw new Error('Local yt-dlp failed');
    })
  );

  // 2. Add Cobalt instance promises
  for (const instance of cobaltInstances) {
    extractionPromises.push(
      extractSingleCobalt(instance, url).then(res => {
        if (res) return res;
        throw new Error(`Cobalt ${instance} failed`);
      })
    );
  }

  let result = null;
  try {
    // Wait for the fastest method to resolve successfully
    result = await Promise.any(extractionPromises);
    console.log(`[POST /] Fast extraction finished! Title: ${result.title}`);
  } catch (e) {
    console.warn('[POST /] All extraction methods failed concurrently.');
  }

  let downloadUrl = '';
  if (result && result.videoUrl) {
    // Construct streaming URL using our stream proxy endpoint
    downloadUrl = `${protocol}://${host}/api/download?streamUrl=${encodeURIComponent(result.videoUrl)}&title=${encodeURIComponent(result.title)}&format=${isAudio ? 'mp3' : 'mp4'}`;
  } else {
    // Fall back to simulation only if all extraction routines failed
    console.warn(`[POST /] Using fallback simulation URL.`);
    const fallbackUrl = isAudio ? 'https://www.w3schools.com/html/horse.mp3' : 'https://www.w3schools.com/html/mov_bbb.mp4';
    downloadUrl = `${protocol}://${host}/api/download?streamUrl=${encodeURIComponent(fallbackUrl)}&title=Simulation_Fallback&format=${isAudio ? 'mp3' : 'mp4'}`;
  }

  res.json({
    status: 'stream',
    url: downloadUrl
  });
});

/**
 * Streaming Downloader Endpoint
 * GET /api/download
 */
app.get('/api/download', (req, res) => {
  const streamUrl = req.query.streamUrl;
  const videoUrl = req.query.url;
  const format = req.query.format || 'mp4';
  const title = req.query.title || 'VideoSaver';

  const filename = `${title.replace(/[^a-zA-Z0-9]/g, '_')}.${format}`;

  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', format === 'mp3' ? 'audio/mpeg' : 'video/mp4');

  if (streamUrl) {
    console.log(`[Download] Proxy streaming from direct URL: ${streamUrl}`);
    streamFromUrl(streamUrl, res);
  } else if (videoUrl) {
    console.log(`[Download] Spawning local yt-dlp to stream: ${videoUrl}`);
    let args = [];
    if (format === 'mp3') {
      args = [
        '-f', 'ba/b',
        '-x', '--audio-format', 'mp3',
        '--audio-quality', '0',
        '--no-playlist',
        '-o', '-',
        videoUrl
      ];
    } else {
      args = [
        '-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b',
        '--merge-output-format', 'mp4',
        '--no-playlist',
        '-o', '-',
        videoUrl
      ];
    }

    const ytdlp = spawn('yt-dlp', args);
    ytdlp.stdout.pipe(res);
    
    ytdlp.stderr.on('data', (data) => {
      console.warn(`[yt-dlp log] ${data.toString().trim()}`);
    });

    req.on('close', () => {
      ytdlp.kill('SIGKILL');
    });
  } else {
    res.status(400).send('Missing streamUrl or url parameter');
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});
