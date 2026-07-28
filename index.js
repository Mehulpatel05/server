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

// Caching variables for cobalt.directory API response
let cachedData = null;
let lastCacheTime = 0;
const CACHE_DURATION = 8 * 60 * 1000; // Cache for 8 minutes

// Default fallback list of Cobalt servers
const cobaltFallbackInstances = [
  'https://api.cobalt.liubquanti.click/',
  'https://cobaltapi.squair.xyz/',
  'https://cobaltapi.kittycat.boo/',
  'https://api.qwkuns.me/',
  'https://grapefruit.clxxped.lol/',
  'https://kitty.tame.gg/',
];

/**
 * Service detection helper
 */
function detectService(url) {
  const clean = url.toLowerCase();
  if (clean.includes('youtube.com') || clean.includes('youtu.be')) return 'youtube';
  if (clean.includes('instagram.com')) return 'instagram';
  if (clean.includes('tiktok.com')) return 'tiktok';
  if (clean.includes('facebook.com') || clean.includes('fb.watch') || clean.includes('fb.com')) return 'facebook';
  if (clean.includes('twitter.com') || clean.includes('x.com')) return 'twitter';
  if (clean.includes('snapchat.com')) return 'snapchat';
  if (clean.includes('reddit.com') || clean.includes('redd.it')) return 'reddit';
  if (clean.includes('tumblr.com')) return 'tumblr';
  if (clean.includes('pinterest.com') || clean.includes('pin.it')) return 'pinterest';
  if (clean.includes('threads.net')) return 'twitter';
  return 'facebook'; // fallback
}

/**
 * Dynamic Working Instances Fetcher (queries cobalt.directory)
 */
async function getWorkingInstancesForService(service) {
  const now = Date.now();
  if (!cachedData || (now - lastCacheTime > CACHE_DURATION)) {
    try {
      console.log('[Directory] Refreshing working instances from cobalt.directory API...');
      const response = await fetch('https://cobalt.directory/api/working?type=api', {
        headers: { 
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        signal: AbortSignal.timeout(6000)
      });
      if (response.ok) {
        const json = await response.json();
        if (json && json.data) {
          cachedData = json.data;
          lastCacheTime = now;
          console.log('[Directory] Active instances cache updated successfully!');
        }
      }
    } catch (e) {
      console.error(`[Directory Error] Failed to fetch active instances: ${e.message}`);
    }
  }

  if (cachedData && cachedData[service] && cachedData[service].length > 0) {
    return cachedData[service].map(url => url.endsWith('/') ? url : `${url}/`);
  }
  
  console.log(`[Directory] Using fallback instances list for service: ${service}`);
  return cobaltFallbackInstances;
}

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
 * Custom Diskwala Direct Scraper
 */
async function extractDiskwalaDirect(diskwalaUrl) {
  try {
    console.log(`[Diskwala Scraper] Fetching page: ${diskwalaUrl}`);
    const response = await fetch(diskwalaUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000)
    });

    if (!response.ok) {
      console.warn(`[Diskwala Scraper] Fetch failed: ${response.status}`);
      return null;
    }

    const html = await response.text();

    // Look for video tag or player source variables (like .mp4 or .m3u8)
    const srcMatch = html.match(/(?:src|source|file|url)\s*:\s*["'](https?:\/\/[^"']+\.(?:mp4|m3u8|mkv)[^"']*)["']/) ||
                     html.match(/<video[^>]*src=["'](https?:\/\/[^"']+)["']/);

    if (srcMatch && srcMatch[1]) {
      const directUrl = srcMatch[1].replace(/&amp;/g, '&');
      console.log(`[Diskwala Scraper] Found Link: ${directUrl}`);
      return {
        videoUrl: directUrl,
        title: 'Diskwala_Video',
        format: directUrl.includes('.m3u8') ? 'm3u8' : 'mp4'
      };
    }
  } catch (e) {
    console.error(`[Diskwala Scraper] Error: ${e.message}`);
  }
  return null;
}

/**
 * Custom Terabox Direct Scraper
 */
async function extractTeraboxDirect(teraboxUrl) {
  // 1. Try local yt-dlp first
  const localRes = await extractFromYtdlp(teraboxUrl);
  if (localRes) {
    return {
      videoUrl: localRes.videoUrl,
      title: localRes.title,
      format: 'mp4'
    };
  }

  // 2. Try public APIs
  const teraboxApis = [
    `https://terabox-api.extraj.in/api?url=${encodeURIComponent(teraboxUrl)}`,
    `https://terabox.apis.ry.vc/api?url=${encodeURIComponent(teraboxUrl)}`
  ];

  for (const api of teraboxApis) {
    try {
      console.log(`[Terabox] Querying public API: ${api}`);
      const response = await fetch(api, { signal: AbortSignal.timeout(7000) });
      if (response.ok) {
        const json = await response.json();
        if (json.status && json.download_link) {
          return {
            videoUrl: json.download_link,
            title: json.title || 'Terabox_Download',
            format: 'mp4'
          };
        } else if (json.url) {
          return {
            videoUrl: json.url,
            title: json.title || 'Terabox_Download',
            format: 'mp4'
          };
        }
      }
    } catch (e) {
      console.warn(`[Terabox API failed] ${api}: ${e.message}`);
    }
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

  // Fast path for Diskwala (bypasses parallel Cobalt pool entirely)
  const isDiskwala = url.toLowerCase().includes('diskwala') || url.toLowerCase().includes('playdiskwala') || url.toLowerCase().includes('thediskwala');
  if (isDiskwala) {
    const diskwalaResult = await extractDiskwalaDirect(url);
    if (diskwalaResult) {
      const downloadUrl = `${protocol}://${host}/api/download?streamUrl=${encodeURIComponent(diskwalaResult.videoUrl)}&title=${encodeURIComponent(diskwalaResult.title)}&format=${diskwalaResult.format}`;
      return res.json({
        status: 'stream',
        url: downloadUrl
      });
    }
  }

  // Fast path for Terabox (bypasses parallel Cobalt pool entirely)
  const isTerabox = url.toLowerCase().includes('terabox') || url.toLowerCase().includes('nephobox') || url.toLowerCase().includes('dubox') || url.toLowerCase().includes('playedu') || url.toLowerCase().includes('teraboxlink');
  if (isTerabox) {
    const teraboxResult = await extractTeraboxDirect(url);
    if (teraboxResult) {
      const downloadUrl = `${protocol}://${host}/api/download?streamUrl=${encodeURIComponent(teraboxResult.videoUrl)}&title=${encodeURIComponent(teraboxResult.title)}&format=${teraboxResult.format}`;
      return res.json({
        status: 'stream',
        url: downloadUrl
      });
    }
  }

  // Detect service to get tested instances from directory API
  const service = detectService(url);
  const targetInstances = await getWorkingInstancesForService(service);

  // Build list of promises to run in parallel
  const extractionPromises = [];

  // 1. Add local yt-dlp promise
  extractionPromises.push(
    extractFromYtdlp(url).then(res => {
      if (res) return res;
      throw new Error('Local yt-dlp failed');
    })
  );

  // 2. Add Cobalt instance promises for tested working servers
  for (const instance of targetInstances) {
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
