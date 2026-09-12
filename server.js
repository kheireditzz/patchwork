import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { initDatabase, sqlite } from './src/database/db.js';
import apiRouter from './src/routes/api.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function createApp() {
  // Initialize DB schema & seeds
  await initDatabase();

  const app = express();

  // Security Middlewares
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: false,
    crossOriginEmbedderPolicy: false
  }));

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Rate limiter for API
  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Terlalu banyak permintaan, silakan coba lagi nanti.' }
  });

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    message: { error: 'Terlalu banyak percobaan login. Coba lagi dalam beberapa saat.' }
  });

  app.use('/api/auth/login', authLimiter);
  app.use('/api', apiLimiter);

  // Mount API routes
  app.use('/api', apiRouter);

  // Static files
  app.use(express.static(path.join(__dirname, 'public')));
  app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

  // Dynamic Sitemap XML
  app.get('/sitemap.xml', (req, res) => {
    try {
      const products = sqlite.prepare("SELECT slug, updated_at FROM products WHERE status = 'Published'").all();
      const categories = sqlite.prepare("SELECT slug FROM categories").all();
      const domain = req.protocol + '://' + req.get('host');

      let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${domain}/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
`;

      categories.forEach(c => {
        xml += `  <url>
    <loc>${domain}/?category=${c.slug}</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>\n`;
      });

      products.forEach(p => {
        xml += `  <url>
    <loc>${domain}/product/${p.slug}</loc>
    <lastmod>${new Date(p.updated_at || Date.now()).toISOString()}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.9</priority>
  </url>\n`;
      });

      xml += `</urlset>`;
      res.header('Content-Type', 'application/xml');
      res.send(xml);
    } catch (err) {
      res.status(500).send('Error generating sitemap');
    }
  });

  // Dynamic Robots.txt
  app.get('/robots.txt', (req, res) => {
    try {
      const setting = sqlite.prepare("SELECT value FROM settings WHERE key = 'robots_txt'").get();
      const robots = setting ? setting.value : "User-agent: *\nAllow: /\nSitemap: /sitemap.xml";
      res.type('text/plain');
      res.send(robots);
    } catch (err) {
      res.type('text/plain').send("User-agent: *\nAllow: /\nSitemap: /sitemap.xml");
    }
  });

  // Single Page Route mappings for friendly URLs
  app.get('/product/:slug', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/product.html'));
  });

  app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/admin.html'));
  });

  app.get('/admin/*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/admin.html'));
  });

  app.get('/partner', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/partner.html'));
  });

  app.get('/partner/*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/partner.html'));
  });

  app.get('/lynk', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/lynk.html'));
  });

  app.get('/lynk/:id', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/lynk.html'));
  });

  app.get('/@:id', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/lynk.html'));
  });

  // Handle subdomain *.kheireditz.my.id (except patchwork, www, app) serving lynk.html
  app.use((req, res, next) => {
    const host = (req.hostname || req.get('host') || '').toLowerCase();
    if (host.includes('.kheireditz.my.id')) {
      const sub = host.split('.kheireditz.my.id')[0];
      if (sub && sub !== 'www' && sub !== 'app' && sub !== 'patchwork' && sub !== 'admin' && !req.path.startsWith('/api') && !req.path.startsWith('/uploads')) {
        return res.sendFile(path.join(__dirname, 'public/lynk.html'));
      }
    }
    next();
  });

  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/index.html'));
  });

  return app;
}

// Start Server only when NOT on Vercel (local/traditional hosting)
if (!process.env.VERCEL) {
  createApp().then(app => {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`=======================================================`);
      console.log(`🚀 PATCHWORK Affiliate Platform is running!`);
      console.log(`🌐 Public URL  : http://0.0.0.0:${PORT}`);
      console.log(`📡 Admin panel : http://0.0.0.0:${PORT}/admin (akses langsung via URL)`);
      console.log(`=======================================================`);
    });
  }).catch(err => {
    console.error('Failed to start server:', err);
  });
}
