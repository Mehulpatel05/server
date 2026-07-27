const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

// Root path GET - sanity health check
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    message: 'VideoSaver Downloader API Server is running!',
    version: '1.0.0',
    help: 'Use POST / to extract media link, or GET /api/download to stream files.'
  });
});

/**
 * Cobalt API Compatibility Endpoint
 * POST /
 * Body: { url, downloadMode, videoQuality }
 */
app.post('/', (req, res) => {
  const { url, downloadMode } = req.body;
  
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  console.log(`[Extract Request] URL: ${url}, Mode: ${downloadMode || 'auto'}`);

  // Retrieve protocol and host to build streaming links pointing back to this server
  // Render automatically sets X-Forwarded-Proto, defaulting to http if local
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.get('host');
  const isAudio = downloadMode === 'audio';

  const downloadUrl = `${protocol}://${host}/api/download?url=${encodeURIComponent(url)}&format=${isAudio ? 'mp3' : 'mp4'}`;

  // Return a structure compatible with the Flutter app's Cobalt extractor
  res.json({
    status: 'stream',
    url: downloadUrl
  });
});

/**
 * Streaming Downloader Endpoint
 * GET /api/download?url=<url>&format=<mp4|mp3>
 */
app.get('/api/download', (req, res) => {
  const videoUrl = req.query.url;
  const format = req.query.format || 'mp4';

  if (!videoUrl) {
    return res.status(400).json({ error: 'URL query parameter is required' });
  }

  console.log(`[Download Request] Streaming starting for: ${videoUrl} (Format: ${format})`);

  // Set response headers for direct attachment download
  const filename = `VideoSaver_${Date.now()}.${format === 'mp3' ? 'mp3' : 'mp4'}`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', format === 'mp3' ? 'audio/mpeg' : 'video/mp4');

  let args = [];
  if (format === 'mp3') {
    // Extract audio only and stream as mp3 (no video stream required)
    args = [
      '-f', 'ba/b',
      '-x', '--audio-format', 'mp3',
      '--audio-quality', '0',
      '--no-playlist',
      '-o', '-',
      videoUrl
    ];
  } else {
    // Merge highest quality video stream + highest audio stream into mp4 on-the-fly and output to stdout
    args = [
      '-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b',
      '--merge-output-format', 'mp4',
      '--no-playlist',
      '-o', '-',
      videoUrl
    ];
  }

  console.log(`Running yt-dlp with arguments: ${args.join(' ')}`);

  // Spawn yt-dlp process
  const ytdlp = spawn('yt-dlp', args);

  // Pipe the stdout of yt-dlp directly to the Express HTTP response
  ytdlp.stdout.pipe(res);

  // Log warnings and errors to server console
  ytdlp.stderr.on('data', (data) => {
    const message = data.toString().trim();
    if (message.includes('ERROR') || message.includes('WARNING')) {
      console.warn(`[yt-dlp log] ${message}`);
    }
  });

  // Handle process termination/completion
  ytdlp.on('close', (code) => {
    console.log(`[Download Complete] yt-dlp exited with code ${code}`);
  });

  // Handle client disconnection (user pauses, cancels or leaves screen)
  req.on('close', () => {
    console.log('[Download Disconnected] Client closed connection. Killing yt-dlp.');
    ytdlp.kill('SIGKILL');
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});
