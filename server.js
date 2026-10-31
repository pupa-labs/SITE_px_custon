import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const distDir = path.resolve(__dirname, 'dist');
const indexHtmlPath = path.join(distDir, 'index.html');

const app = express();
app.disable('x-powered-by');

const NO_CACHE_FILES = new Set([
  '/index.html',
  '/sw.js',
  '/registerSW.js',
  '/manifest.webmanifest',
]);

app.use(
  express.static(distDir, {
    index: false,
    fallthrough: true,
    setHeaders(res, filePath) {
      const relativePath = '/' + path.relative(distDir, filePath).split(path.sep).join('/');
      if (relativePath.startsWith('/assets/')) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (NO_CACHE_FILES.has(relativePath) || relativePath.startsWith('/workbox-')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    },
  })
);

app.use((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(404).type('text/plain; charset=utf-8').send('Not Found');
    return;
  }

  const requestPath = req.path || '/';
  const segments = requestPath.split('/').filter(Boolean);
  const lastSegment = segments[segments.length - 1] || '';
  const hasDotfileSegment = segments.some((segment) => segment.startsWith('.'));
  const hasFileExtension = path.posix.extname(lastSegment) !== '';

  if (
    requestPath.startsWith('/assets/') ||
    requestPath.startsWith('/api/') ||
    hasDotfileSegment ||
    hasFileExtension
  ) {
    res.status(404).type('text/plain; charset=utf-8').send('Not Found');
    return;
  }

  const acceptHeader = String(req.headers.accept || '');
  const acceptsHtml =
    acceptHeader === '' ||
    acceptHeader.includes('text/html') ||
    acceptHeader.includes('application/xhtml+xml') ||
    acceptHeader.includes('*/*');

  if (!acceptsHtml) {
    res.status(404).type('text/plain; charset=utf-8').send('Not Found');
    return;
  }

  if (!fs.existsSync(indexHtmlPath)) {
    res
      .status(503)
      .type('text/plain; charset=utf-8')
      .send('Build output not found. Run "npm run build" before starting the server.');
    return;
  }

  res.setHeader('Cache-Control', 'no-cache');
  res.status(200).sendFile(indexHtmlPath);
});

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';

const server = app.listen(port, host, () => {
  console.log(`PX CUSTON server listening on http://${host}:${port}`);
});

const shutdown = () => {
  server.close(() => {
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
