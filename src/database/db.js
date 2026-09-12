import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// On Vercel, the project dir is read-only.
const projectDbPath = path.join(__dirname, '../../patchwork.db');
const isVercel = !!process.env.VERCEL;
const tmpDbPath = path.join(os.tmpdir(), 'patchwork.db');

let dbFilePath = isVercel ? tmpDbPath : projectDbPath;

export const SUPABASE_URL = process.env.SUPABASE_URL || '';
export const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

export let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY && SUPABASE_URL !== 'https://your-project.supabase.co') {
  try {
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false }
    });
    console.log('✅ Supabase client initialized.');
  } catch (err) {
    console.warn('⚠️ Supabase connect err:', err.message);
  }
}

let rawDb = null;

// Wrapper that mimics standard statement prepare/all/get/run API
class PreparedStatement {
  constructor(sql) {
    this.sql = sql;
  }

  run(...params) {
    // Flatten params if passed as array
    const flatParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    rawDb.run(this.sql, flatParams);
    saveDbToFile();
    return { changes: rawDb.getRowsModified() };
  }

  get(...params) {
    const flatParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    const stmt = rawDb.prepare(this.sql);
    stmt.bind(flatParams);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return row;
    }
    stmt.free();
    return undefined;
  }

  all(...params) {
    const flatParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    const stmt = rawDb.prepare(this.sql);
    stmt.bind(flatParams);
    const results = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
  }
}

export const sqlite = {
  prepare: (sql) => new PreparedStatement(sql),
  exec: (sql) => {
    rawDb.exec(sql);
    saveDbToFile();
  }
};

function saveDbToFile() {
  try {
    if (!rawDb) return;
    const data = rawDb.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbFilePath, buffer);
  } catch (e) {
    console.error('Error saving db to file:', e.message);
  }
}

export async function initDatabase() {
  const wasmPath = path.join(process.cwd(), 'node_modules/sql.js/dist/sql-wasm.wasm');
  const SQL = await initSqlJs({
    locateFile: file => {
      if (file.endsWith('.wasm')) {
        if (fs.existsSync(wasmPath)) return wasmPath;
      }
      return file;
    }
  });
  if (fs.existsSync(dbFilePath)) {
    const filebuffer = fs.readFileSync(dbFilePath);
    rawDb = new SQL.Database(filebuffer);
  } else {
    rawDb = new SQL.Database();
  }

  // Schema creation
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      phone TEXT,
      password TEXT NOT NULL,
      role TEXT CHECK(role IN ('Super Admin', 'Admin', 'Editor', 'Partner')) NOT NULL DEFAULT 'Admin',
      status TEXT CHECK(status IN ('Pending', 'Approved', 'Rejected')) NOT NULL DEFAULT 'Approved',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      icon TEXT DEFAULT 'tag',
      description TEXT,
      color TEXT DEFAULT '#3B82F6',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      category_id TEXT,
      description TEXT,
      price REAL DEFAULT 0,
      commission_rate TEXT,
      marketplace TEXT DEFAULT 'Shopee',
      url_shopee TEXT,
      url_tiktok TEXT,
      url_tokopedia TEXT,
      thumbnail TEXT,
      gallery TEXT,
      status TEXT CHECK(status IN ('Draft', 'Published')) NOT NULL DEFAULT 'Published',
      is_featured INTEGER DEFAULT 0,
      total_clicks INTEGER DEFAULT 0,
      shopee_clicks INTEGER DEFAULT 0,
      tiktok_clicks INTEGER DEFAULT 0,
      tokopedia_clicks INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS banners (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      subtitle TEXT,
      image TEXT NOT NULL,
      target_url TEXT,
      status TEXT CHECK(status IN ('Draft', 'Published')) NOT NULL DEFAULT 'Published',
      display_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS clicks (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      marketplace TEXT NOT NULL,
      visitor_ip TEXT,
      user_agent TEXT,
      referrer TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS visitors (
      id TEXT PRIMARY KEY,
      visitor_ip TEXT,
      user_agent TEXT,
      page TEXT,
      referrer TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS activity_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      user_name TEXT,
      action TEXT NOT NULL,
      details TEXT,
      ip_address TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS partner_submissions (
      id TEXT PRIMARY KEY,
      partner_name TEXT NOT NULL,
      whatsapp TEXT NOT NULL,
      email TEXT,
      product_name TEXT NOT NULL,
      marketplace TEXT NOT NULL DEFAULT 'Shopee',
      product_url TEXT NOT NULL,
      product_price REAL DEFAULT 0,
      commission_rate TEXT,
      description TEXT,
      image_url TEXT,
      status TEXT CHECK(status IN ('Pending', 'Approved', 'Rejected')) NOT NULL DEFAULT 'Pending',
      admin_notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Migration for existing tables: add phone, status, bio, avatar, socials to users if not present
  try { rawDb.exec(`ALTER TABLE users ADD COLUMN phone TEXT;`); } catch (e) {}
  try { rawDb.exec(`ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'Approved';`); } catch (e) {}
  try { rawDb.exec(`ALTER TABLE users ADD COLUMN bio TEXT DEFAULT '';`); } catch (e) {}
  try { rawDb.exec(`ALTER TABLE users ADD COLUMN avatar TEXT DEFAULT '';`); } catch (e) {}
  try { rawDb.exec(`ALTER TABLE users ADD COLUMN tiktok TEXT DEFAULT '';`); } catch (e) {}
  try { rawDb.exec(`ALTER TABLE users ADD COLUMN instagram TEXT DEFAULT '';`); } catch (e) {}
  try { rawDb.exec(`ALTER TABLE users ADD COLUMN shopee TEXT DEFAULT '';`); } catch (e) {}
  try { rawDb.exec(`ALTER TABLE users ADD COLUMN youtube TEXT DEFAULT '';`); } catch (e) {}
  try { rawDb.exec(`ALTER TABLE users ADD COLUMN website TEXT DEFAULT '';`); } catch (e) {}
  try { rawDb.exec(`ALTER TABLE users ADD COLUMN template TEXT DEFAULT 'modern';`); } catch (e) {}

  try { rawDb.exec(`ALTER TABLE users ADD COLUMN custom_slug TEXT;`); } catch (e) {}
  try { rawDb.exec(`ALTER TABLE products ADD COLUMN created_by TEXT;`); } catch (e) {}

  // Upgrade users table check constraint if it doesn't support 'Partner'
  try {
    const tableSql = rawDb.exec(`SELECT sql FROM sqlite_master WHERE type='table' AND name='users';`)[0]?.values[0]?.[0] || '';
    if (tableSql && !tableSql.includes('Partner')) {
      rawDb.exec(`
        CREATE TABLE users_new (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT UNIQUE NOT NULL,
          phone TEXT,
          password TEXT NOT NULL,
          role TEXT CHECK(role IN ('Super Admin', 'Admin', 'Editor', 'Partner')) NOT NULL DEFAULT 'Admin',
          status TEXT CHECK(status IN ('Pending', 'Approved', 'Rejected')) NOT NULL DEFAULT 'Approved',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO users_new (id, name, email, phone, password, role, status, created_at, updated_at)
        SELECT id, name, email, phone, password, role, COALESCE(status, 'Approved'), created_at, updated_at FROM users;
        DROP TABLE users;
        ALTER TABLE users_new RENAME TO users;
      `);
      console.log('🔄 Upgraded users table schema with Partner role support.');
    }
  } catch (e) {
    console.warn('Users table migration notice:', e.message);
  }

  // Ensure default super admin exists and password is always valid: admin@patchwork.com / admin123
  const passwordHash = bcrypt.hashSync('admin123', 10);
  const existingUser = sqlite.prepare('SELECT id FROM users WHERE email = ?').get('admin@patchwork.com');
  if (!existingUser) {
    const userId = 'usr_superadmin';
    sqlite.prepare(`
      INSERT INTO users (id, name, email, phone, password, role, status)
      VALUES (?, ?, ?, ?, ?, ?, 'Approved')
    `).run(userId, 'Super Administrator', 'admin@patchwork.com', '0895321154498', passwordHash, 'Super Admin');
    console.log('👤 Default Super Admin created: admin@patchwork.com / admin123');
  } else {
    sqlite.prepare(`
      UPDATE users SET password = ?, role = 'Super Admin', status = 'Approved' WHERE email = 'admin@patchwork.com'
    `).run(passwordHash);
    console.log('🔑 Super Admin password synchronized: admin@patchwork.com / admin123');
  }

  // Seed default categories
  const catCount = sqlite.prepare('SELECT count(*) as count FROM categories').get().count;
  if (catCount === 0) {
    const cats = [
      { id: 'cat_1', name: 'Fashion & Pakaian', slug: 'fashion-pakaian', icon: 'shirt', color: '#EC4899', description: 'Koleksi busana hits viral TikTok dan Shopee' },
      { id: 'cat_2', name: 'Gadget & Elektronik', slug: 'gadget-elektronik', icon: 'smartphone', color: '#3B82F6', description: 'Aksesoris gadget, charger, TWS terlaris' },
      { id: 'cat_3', name: 'Kecantikan & Skincare', slug: 'kecantikan-skincare', icon: 'sparkles', color: '#F43F5E', description: 'Serum, skincare, dan makeup paling trending' },
      { id: 'cat_4', name: 'Peralatan Rumah', slug: 'peralatan-rumah', icon: 'home', color: '#10B981', description: 'Perabot estetik dan perlengkapan dapur serbaguna' },
      { id: 'cat_5', name: 'Kesehatan & Diet', slug: 'kesehatan-diet', icon: 'heart-pulse', color: '#8B5CF6', description: 'Suplemen dan vitamin terpercaya' }
    ];
    const insertCat = sqlite.prepare('INSERT INTO categories (id, name, slug, icon, color, description) VALUES (?, ?, ?, ?, ?, ?)');
    cats.forEach(c => insertCat.run(c.id, c.name, c.slug, c.icon, c.color, c.description));
  }

  // Seed default banners
  const bannerCount = sqlite.prepare('SELECT count(*) as count FROM banners').get().count;
  if (bannerCount === 0) {
    const defaultBanners = [
      {
        id: 'ban_1',
        title: 'Spesial Promo Affiliate Viral!',
        subtitle: 'Katalog kurasi produk rekomendasi dengan diskon hingga 70% di TikTok & Shopee.',
        image: 'https://images.unsplash.com/photo-1607082348824-0a96f2a4b9da?w=1200&q=80',
        target_url: '#products',
        status: 'Published'
      },
      {
        id: 'ban_2',
        title: 'Rekomendasi Gadget & Estetik 2026',
        subtitle: 'Upgrade setup kerjamu dengan gadget terpopuler harga hemat.',
        image: 'https://images.unsplash.com/photo-1526170375885-4d8ecf77b99f?w=1200&q=80',
        target_url: '#products',
        status: 'Published'
      }
    ];
    const insertBan = sqlite.prepare('INSERT INTO banners (id, title, subtitle, image, target_url, status, display_order) VALUES (?, ?, ?, ?, ?, ?, ?)');
    defaultBanners.forEach((b, idx) => insertBan.run(b.id, b.title, b.subtitle, b.image, b.target_url, b.status, idx));
  }

  // Seed initial products
  const prodCount = sqlite.prepare('SELECT count(*) as count FROM products').get().count;
  if (prodCount === 0) {
    const products = [
      {
        id: 'prod_1',
        name: 'TWS Wireless Bluetooth Earbuds HiFi Bass',
        slug: 'tws-wireless-bluetooth-earbuds-hifi-bass',
        category_id: 'cat_2',
        description: 'Earphone bluetooth nirkabel dengan latency ultra-rendah, bass mendalam, dan daya tahan baterai hingga 28 jam. Sangat cocok untuk gaming dan musik seharian.',
        price: 139000,
        commission_rate: '10%',
        marketplace: 'TikTok Shop',
        url_shopee: 'https://shopee.co.id/search?keyword=tws+earbuds',
        url_tiktok: 'https://www.tiktok.com/@shop',
        url_tokopedia: 'https://www.tokopedia.com',
        thumbnail: 'https://images.unsplash.com/photo-1590658268037-6bf12165a8df?w=600&q=80',
        gallery: JSON.stringify([
          'https://images.unsplash.com/photo-1590658268037-6bf12165a8df?w=600&q=80',
          'https://images.unsplash.com/photo-1572536147248-ac59a8abfa4b?w=600&q=80'
        ]),
        status: 'Published',
        is_featured: 1,
        total_clicks: 142,
        shopee_clicks: 65,
        tiktok_clicks: 77
      },
      {
        id: 'prod_2',
        name: 'Serum Wajah Niacinamide 10% Brightening Glow',
        slug: 'serum-wajah-niacinamide-10-brightening-glow',
        category_id: 'cat_3',
        description: 'Formula pencerah kulit wajah dengan konsentrasi Niacinamide tinggi & Hyaluronic Acid. Memudarkan noda hitam dalam 14 hari.',
        price: 78500,
        commission_rate: '12%',
        marketplace: 'Shopee',
        url_shopee: 'https://shopee.co.id/search?keyword=serum+niacinamide',
        url_tiktok: 'https://www.tiktok.com/@shop',
        url_tokopedia: 'https://www.tokopedia.com',
        thumbnail: 'https://images.unsplash.com/photo-1620916566398-39f1143ab7be?w=600&q=80',
        gallery: JSON.stringify(['https://images.unsplash.com/photo-1620916566398-39f1143ab7be?w=600&q=80']),
        status: 'Published',
        is_featured: 1,
        total_clicks: 98,
        shopee_clicks: 62,
        tiktok_clicks: 36
      },
      {
        id: 'prod_3',
        name: 'Oversized Streetwear Hoodie Vintage Unisex',
        slug: 'oversized-streetwear-hoodie-vintage-unisex',
        category_id: 'cat_1',
        description: 'Bahan fleece cotton 330gsm tebal dan lembut, pola drop shoulder estetik ala Korea. Nyaman dan tidak gerah.',
        price: 185000,
        commission_rate: '15%',
        marketplace: 'TikTok Shop',
        url_shopee: 'https://shopee.co.id/search?keyword=oversized+hoodie',
        url_tiktok: 'https://www.tiktok.com/@shop',
        url_tokopedia: 'https://www.tokopedia.com',
        thumbnail: 'https://images.unsplash.com/photo-1556905055-8f358a7a47b2?w=600&q=80',
        gallery: JSON.stringify(['https://images.unsplash.com/photo-1556905055-8f358a7a47b2?w=600&q=80']),
        status: 'Published',
        is_featured: 1,
        total_clicks: 215,
        shopee_clicks: 80,
        tiktok_clicks: 135
      },
      {
        id: 'prod_4',
        name: 'Diffuser Aromaterapi Ultrasonik Wood Flame LED',
        slug: 'diffuser-aromaterapi-ultrasonik-wood-flame-led',
        category_id: 'cat_4',
        description: 'Humidifier estetik dengan efek api menyala dan lampu ambient warm. Menghilangkan stress dan membuat ruangan wangi.',
        price: 115000,
        commission_rate: '8%',
        marketplace: 'Shopee',
        url_shopee: 'https://shopee.co.id/search?keyword=flame+diffuser',
        url_tiktok: 'https://www.tiktok.com/@shop',
        url_tokopedia: 'https://www.tokopedia.com',
        thumbnail: 'https://images.unsplash.com/photo-1608571423902-eed4a5ad8108?w=600&q=80',
        gallery: JSON.stringify(['https://images.unsplash.com/photo-1608571423902-eed4a5ad8108?w=600&q=80']),
        status: 'Published',
        is_featured: 0,
        total_clicks: 74,
        shopee_clicks: 44,
        tiktok_clicks: 30
      }
    ];

    const insProd = sqlite.prepare(`
      INSERT INTO products (
        id, name, slug, category_id, description, price, commission_rate,
        marketplace, url_shopee, url_tiktok, url_tokopedia, thumbnail, gallery,
        status, is_featured, total_clicks, shopee_clicks, tiktok_clicks
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    products.forEach(p => {
      insProd.run(
        p.id, p.name, p.slug, p.category_id, p.description, p.price, p.commission_rate,
        p.marketplace, p.url_shopee, p.url_tiktok, p.url_tokopedia, p.thumbnail, p.gallery,
        p.status, p.is_featured, p.total_clicks, p.shopee_clicks, p.tiktok_clicks
      );
    });
  }

  // Seed default settings (SEO, etc)
  const defaultSettings = [
    { key: 'meta_title', value: 'PATCHWORK - Kurasi Link Affiliate TikTok, Shopee & Marketplace Terpercaya' },
    { key: 'meta_description', value: 'Katalog produk affiliate pilihan dengan promo dan voucher terbaik dari TikTok Shop, Shopee, dan marketplace terkemuka.' },
    { key: 'og_image', value: 'https://images.unsplash.com/photo-1607082348824-0a96f2a4b9da?w=1200&q=80' },
    { key: 'site_name', value: 'PATCHWORK' },
    { key: 'cta_text', value: 'Gabung Saluran Info Promo & Flash Sale' },
    { key: 'cta_link', value: 'https://t.me/patchwork_affiliate' },
    { key: 'robots_txt', value: "User-agent: *\nAllow: /\nSitemap: /sitemap.xml" }
  ];

  const insSetting = sqlite.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  defaultSettings.forEach(s => insSetting.run(s.key, s.value));

  saveDbToFile();
  console.log('✅ Local SQLite (sql.js WASM) and schema initialized successfully.');
}

export function logActivity(userId, userName, action, details = '', ip = '') {
  try {
    const id = 'log_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    sqlite.prepare(`
      INSERT INTO activity_logs (id, user_id, user_name, action, details, ip_address)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, userId, userName, action, typeof details === 'object' ? JSON.stringify(details) : details, ip);
  } catch (err) {
    console.error('Failed to write activity log:', err.message);
  }
}
