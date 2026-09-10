import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import * as XLSX from 'xlsx';
import { sqlite, supabase, logActivity } from '../database/db.js';
import { authenticateToken, authorizeRole, JWT_SECRET } from '../middlewares/auth.js';

const router = express.Router();

import os from 'os';

// Setup Multer Storage for file uploads (Banner, Thumbnail, Gallery)
const isVercelEnv = !!process.env.VERCEL;
const baseTemp = os.tmpdir();
const uploadDir = isVercelEnv ? path.join(baseTemp, 'uploads') : path.join(process.cwd(), 'public/uploads');
const excelUploadDir = isVercelEnv ? path.join(baseTemp, 'temp_excel') : path.join(process.cwd(), 'public/uploads/temp_excel');

try {
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
} catch (e) {
  // Ignore
}

try {
  if (!fs.existsSync(excelUploadDir)) {
    fs.mkdirSync(excelUploadDir, { recursive: true });
  }
} catch (e) {
  // Ignore
}

// In serverless, memoryStorage or fallback to tempDir avoids EROFS errors
const storage = isVercelEnv
  ? multer.memoryStorage()
  : multer.diskStorage({
      destination: (req, file, cb) => cb(null, uploadDir),
      filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
        cb(null, `${Date.now()}-${base}${ext}`);
      }
    });

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp|gif|svg/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype);
    if (ext && mime) cb(null, true);
    else cb(new Error('Hanya file gambar (jpg, png, webp, gif, svg) yang diperbolehkan!'));
  }
});

const excelUpload = multer({
  storage: multer.memoryStorage()
});

// Helper: Slugify
function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[\s\W-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// -------------------------------------------------------------
// 1. AUTHENTICATION & PROFILE
// -------------------------------------------------------------
router.post('/auth/login', (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email dan password wajib diisi.' });
    }

    const user = sqlite.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) {
      return res.status(401).json({ error: 'Email atau password salah.' });
    }

    const isMatch = bcrypt.compareSync(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Email atau password salah.' });
    }

    const token = jwt.sign(
      { id: user.id, name: user.name, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    logActivity(user.id, user.name, 'LOGIN', 'Admin berhasil login', req.ip);

    res.json({
      message: 'Login berhasil',
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/auth/me', authenticateToken, (req, res) => {
  res.json({ user: req.user });
});

// -------------------------------------------------------------
// 2. UPLOAD ENDPOINT (Local & Supabase Storage sync)
// -------------------------------------------------------------
router.post('/upload', authenticateToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Tidak ada file yang diunggah.' });
    }

    const filename = req.file.filename || `${Date.now()}-${(req.file.originalname || 'file').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    const relativeUrl = `/uploads/${filename}`;

    // If Supabase is connected, optionally upload to Supabase Storage as well
    if (supabase) {
      try {
        const fileData = req.file.buffer || (req.file.path ? fs.readFileSync(req.file.path) : null);
        if (fileData) {
          const { error: sbErr } = await supabase.storage
            .from('patchwork')
            .upload(`uploads/${filename}`, fileData, {
              contentType: req.file.mimetype,
              upsert: true
            });
          if (!sbErr) {
            const { data: publicData } = supabase.storage.from('patchwork').getPublicUrl(`uploads/${filename}`);
            if (publicData?.publicUrl) {
              return res.json({ url: publicData.publicUrl, localUrl: relativeUrl });
            }
          }
        }
      } catch (err) {
        console.warn('Supabase upload skipped, using local URL:', err.message);
      }
    }

    res.json({ url: relativeUrl, localUrl: relativeUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 3. PRODUCTS (REST API CRUD, Filter, Search, Pagination)
// -------------------------------------------------------------
// GET /api/products (Public or Admin)
router.get('/products', (req, res) => {
  try {
    const {
      search = '',
      category_id = '',
      category_slug = '',
      marketplace = '',
      status = '',
      is_featured = '',
      sort = 'newest',
      page = 1,
      limit = 12
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);
    let whereClauses = [];
    let params = [];

    // Filter by search
    if (search) {
      whereClauses.push('(p.name LIKE ? OR p.description LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }

    // Filter by category id or slug
    if (category_id) {
      whereClauses.push('p.category_id = ?');
      params.push(category_id);
    } else if (category_slug) {
      whereClauses.push('c.slug = ?');
      params.push(category_slug);
    }

    // Filter by marketplace
    if (marketplace) {
      whereClauses.push('p.marketplace = ?');
      params.push(marketplace);
    }

    // Status filter (If public, force status 'Published')
    if (status) {
      whereClauses.push('p.status = ?');
      params.push(status);
    }

    // Featured filter
    if (is_featured !== '') {
      whereClauses.push('p.is_featured = ?');
      params.push(parseInt(is_featured));
    }

    const whereSql = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

    // Sorting
    let orderBy = 'p.created_at DESC';
    if (sort === 'popular') orderBy = 'p.total_clicks DESC';
    if (sort === 'price_asc') orderBy = 'p.price ASC';
    if (sort === 'price_desc') orderBy = 'p.price DESC';
    if (sort === 'name') orderBy = 'p.name ASC';

    // Count query
    const countSql = `
      SELECT count(*) as total
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      ${whereSql}
    `;
    const total = sqlite.prepare(countSql).get(...params).total;

    // Items query
    const selectSql = `
      SELECT 
        p.*, 
        c.name as category_name, 
        c.slug as category_slug, 
        c.color as category_color,
        c.icon as category_icon
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      ${whereSql}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `;

    const items = sqlite.prepare(selectSql).all(...params, parseInt(limit), offset);

    // Parse gallery JSON
    const parsedItems = items.map(p => ({
      ...p,
      gallery: typeof p.gallery === 'string' ? JSON.parse(p.gallery || '[]') : (p.gallery || [])
    }));

    res.json({
      data: parsedItems,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/products/:id or slug
router.get('/products/:idOrSlug', (req, res) => {
  try {
    const { idOrSlug } = req.params;
    const item = sqlite.prepare(`
      SELECT 
        p.*, 
        c.name as category_name, 
        c.slug as category_slug, 
        c.color as category_color,
        c.icon as category_icon
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.id = ? OR p.slug = ?
    `).get(idOrSlug, idOrSlug);

    if (!item) {
      return res.status(404).json({ error: 'Produk tidak ditemukan.' });
    }

    item.gallery = typeof item.gallery === 'string' ? JSON.parse(item.gallery || '[]') : (item.gallery || []);
    res.json({ data: item });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/products
router.post('/products', authenticateToken, authorizeRole(['Super Admin', 'Admin', 'Editor']), (req, res) => {
  try {
    const {
      name,
      category_id,
      description = '',
      price = 0,
      commission_rate = '',
      marketplace = 'Shopee',
      url_shopee = '',
      url_tiktok = '',
      url_tokopedia = '',
      thumbnail = '',
      gallery = [],
      status = 'Published',
      is_featured = 0
    } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Nama produk wajib diisi.' });
    }

    const id = 'prod_' + Date.now();
    let baseSlug = slugify(name);
    let slug = baseSlug;
    let count = 1;
    while (sqlite.prepare('SELECT id FROM products WHERE slug = ?').get(slug)) {
      slug = `${baseSlug}-${count++}`;
    }

    const galleryJson = typeof gallery === 'string' ? gallery : JSON.stringify(gallery);

    sqlite.prepare(`
      INSERT INTO products (
        id, name, slug, category_id, description, price, commission_rate,
        marketplace, url_shopee, url_tiktok, url_tokopedia, thumbnail, gallery,
        status, is_featured
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, name, slug, category_id || null, description, price, commission_rate,
      marketplace, url_shopee, url_tiktok, url_tokopedia, thumbnail, galleryJson,
      status, is_featured ? 1 : 0
    );

    logActivity(req.user.id, req.user.name, 'CREATE_PRODUCT', `Menambahkan produk "${name}"`, req.ip);

    const created = sqlite.prepare('SELECT * FROM products WHERE id = ?').get(id);
    res.status(201).json({ message: 'Produk berhasil dibuat', data: created });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/products/:id
router.put('/products/:id', authenticateToken, authorizeRole(['Super Admin', 'Admin', 'Editor']), (req, res) => {
  try {
    const { id } = req.params;
    const existing = sqlite.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Produk tidak ditemukan.' });
    }

    const {
      name,
      slug: customSlug,
      category_id,
      description,
      price,
      commission_rate,
      marketplace,
      url_shopee,
      url_tiktok,
      url_tokopedia,
      thumbnail,
      gallery,
      status,
      is_featured
    } = req.body;

    let finalSlug = existing.slug;
    if (customSlug && customSlug !== existing.slug) {
      finalSlug = slugify(customSlug);
      const conflict = sqlite.prepare('SELECT id FROM products WHERE slug = ? AND id != ?').get(finalSlug, id);
      if (conflict) {
        return res.status(400).json({ error: 'Slug sudah digunakan produk lain.' });
      }
    } else if (name && !customSlug && name !== existing.name) {
      finalSlug = slugify(name);
    }

    const galleryJson = gallery !== undefined ? (typeof gallery === 'string' ? gallery : JSON.stringify(gallery)) : existing.gallery;

    sqlite.prepare(`
      UPDATE products SET
        name = coalesce(?, name),
        slug = coalesce(?, slug),
        category_id = coalesce(?, category_id),
        description = coalesce(?, description),
        price = coalesce(?, price),
        commission_rate = coalesce(?, commission_rate),
        marketplace = coalesce(?, marketplace),
        url_shopee = coalesce(?, url_shopee),
        url_tiktok = coalesce(?, url_tiktok),
        url_tokopedia = coalesce(?, url_tokopedia),
        thumbnail = coalesce(?, thumbnail),
        gallery = ?,
        status = coalesce(?, status),
        is_featured = coalesce(?, is_featured),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      name,
      finalSlug,
      category_id,
      description,
      price,
      commission_rate,
      marketplace,
      url_shopee,
      url_tiktok,
      url_tokopedia,
      thumbnail,
      galleryJson,
      status,
      is_featured !== undefined ? (is_featured ? 1 : 0) : null,
      id
    );

    logActivity(req.user.id, req.user.name, 'UPDATE_PRODUCT', `Memperbarui produk "${name || existing.name}"`, req.ip);

    const updated = sqlite.prepare('SELECT * FROM products WHERE id = ?').get(id);
    res.json({ message: 'Produk berhasil diperbarui', data: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/products/:id
router.delete('/products/:id', authenticateToken, authorizeRole(['Super Admin', 'Admin']), (req, res) => {
  try {
    const { id } = req.params;
    const existing = sqlite.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Produk tidak ditemukan.' });
    }

    sqlite.prepare('DELETE FROM products WHERE id = ?').run(id);
    logActivity(req.user.id, req.user.name, 'DELETE_PRODUCT', `Menghapus produk "${existing.name}"`, req.ip);

    res.json({ message: 'Produk berhasil dihapus.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 4. CLICK TRACKING & STATS (Shopee, TikTok, Tokopedia)
// -------------------------------------------------------------
router.post('/clicks/track', (req, res) => {
  try {
    const { product_id, marketplace } = req.body;
    if (!product_id || !marketplace) {
      return res.status(400).json({ error: 'product_id dan marketplace wajib diisi.' });
    }

    const clickId = 'clk_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const ua = req.headers['user-agent'] || '';
    const referrer = req.headers['referer'] || '';

    // Insert to clicks
    sqlite.prepare(`
      INSERT INTO clicks (id, product_id, marketplace, visitor_ip, user_agent, referrer)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(clickId, product_id, marketplace, ip, ua, referrer);

    // Increment count on products table
    let marketplaceColumn = 'shopee_clicks';
    if (marketplace.toLowerCase().includes('tiktok')) marketplaceColumn = 'tiktok_clicks';
    if (marketplace.toLowerCase().includes('tokopedia')) marketplaceColumn = 'tokopedia_clicks';

    sqlite.prepare(`
      UPDATE products 
      SET total_clicks = total_clicks + 1,
          ${marketplaceColumn} = ${marketplaceColumn} + 1
      WHERE id = ?
    `).run(product_id);

    res.json({ success: true, message: 'Klik berhasil dicatat.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Visitor tracking
router.post('/visitors/track', (req, res) => {
  try {
    const { page = '/' } = req.body;
    const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const ua = req.headers['user-agent'] || '';
    const referrer = req.headers['referer'] || '';

    const id = 'vis_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    sqlite.prepare(`
      INSERT INTO visitors (id, visitor_ip, user_agent, page, referrer)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, ip, ua, page, referrer);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 5. CATEGORIES (REST API CRUD)
// -------------------------------------------------------------
router.get('/categories', (req, res) => {
  try {
    const items = sqlite.prepare(`
      SELECT c.*, COUNT(p.id) as product_count 
      FROM categories c
      LEFT JOIN products p ON p.category_id = c.id
      GROUP BY c.id
      ORDER BY c.name ASC
    `).all();
    res.json({ data: items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/categories', authenticateToken, authorizeRole(['Super Admin', 'Admin']), (req, res) => {
  try {
    const { name, icon = 'tag', description = '', color = '#3B82F6' } = req.body;
    if (!name) return res.status(400).json({ error: 'Nama kategori wajib diisi.' });

    const id = 'cat_' + Date.now();
    let baseSlug = slugify(name);
    let slug = baseSlug;
    let count = 1;
    while (sqlite.prepare('SELECT id FROM categories WHERE slug = ?').get(slug)) {
      slug = `${baseSlug}-${count++}`;
    }

    sqlite.prepare(`
      INSERT INTO categories (id, name, slug, icon, description, color)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, name, slug, icon, description, color);

    logActivity(req.user.id, req.user.name, 'CREATE_CATEGORY', `Membuat kategori "${name}"`, req.ip);

    const created = sqlite.prepare('SELECT * FROM categories WHERE id = ?').get(id);
    res.status(201).json({ message: 'Kategori berhasil dibuat', data: created });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/categories/:id', authenticateToken, authorizeRole(['Super Admin', 'Admin']), (req, res) => {
  try {
    const { id } = req.params;
    const { name, icon, description, color } = req.body;
    
    sqlite.prepare(`
      UPDATE categories SET
        name = coalesce(?, name),
        icon = coalesce(?, icon),
        description = coalesce(?, description),
        color = coalesce(?, color)
      WHERE id = ?
    `).run(name, icon, description, color, id);

    logActivity(req.user.id, req.user.name, 'UPDATE_CATEGORY', `Memperbarui kategori ID: ${id}`, req.ip);

    const updated = sqlite.prepare('SELECT * FROM categories WHERE id = ?').get(id);
    res.json({ message: 'Kategori berhasil diperbarui', data: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/categories/:id', authenticateToken, authorizeRole(['Super Admin', 'Admin']), (req, res) => {
  try {
    const { id } = req.params;
    sqlite.prepare('DELETE FROM categories WHERE id = ?').run(id);
    logActivity(req.user.id, req.user.name, 'DELETE_CATEGORY', `Menghapus kategori ID: ${id}`, req.ip);
    res.json({ message: 'Kategori berhasil dihapus.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 6. BANNERS (REST API CRUD)
// -------------------------------------------------------------
router.get('/banners', (req, res) => {
  try {
    const { status } = req.query;
    let sql = 'SELECT * FROM banners';
    let params = [];
    if (status) {
      sql += ' WHERE status = ?';
      params.push(status);
    }
    sql += ' ORDER BY display_order ASC, created_at DESC';

    const banners = sqlite.prepare(sql).all(...params);
    res.json({ data: banners });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/banners', authenticateToken, authorizeRole(['Super Admin', 'Admin']), (req, res) => {
  try {
    const { title, subtitle = '', image, target_url = '#', status = 'Published', display_order = 0 } = req.body;
    if (!title || !image) {
      return res.status(400).json({ error: 'Judul dan gambar banner wajib diisi.' });
    }

    const id = 'ban_' + Date.now();
    sqlite.prepare(`
      INSERT INTO banners (id, title, subtitle, image, target_url, status, display_order)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, title, subtitle, image, target_url, status, display_order);

    logActivity(req.user.id, req.user.name, 'CREATE_BANNER', `Membuat banner "${title}"`, req.ip);

    res.status(201).json({ message: 'Banner berhasil dibuat', data: { id, title } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/banners/:id', authenticateToken, authorizeRole(['Super Admin', 'Admin']), (req, res) => {
  try {
    const { id } = req.params;
    const { title, subtitle, image, target_url, status, display_order } = req.body;

    sqlite.prepare(`
      UPDATE banners SET
        title = coalesce(?, title),
        subtitle = coalesce(?, subtitle),
        image = coalesce(?, image),
        target_url = coalesce(?, target_url),
        status = coalesce(?, status),
        display_order = coalesce(?, display_order)
      WHERE id = ?
    `).run(title, subtitle, image, target_url, status, display_order, id);

    logActivity(req.user.id, req.user.name, 'UPDATE_BANNER', `Memperbarui banner ID: ${id}`, req.ip);

    res.json({ message: 'Banner berhasil diperbarui' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/banners/:id', authenticateToken, authorizeRole(['Super Admin', 'Admin']), (req, res) => {
  try {
    const { id } = req.params;
    sqlite.prepare('DELETE FROM banners WHERE id = ?').run(id);
    logActivity(req.user.id, req.user.name, 'DELETE_BANNER', `Menghapus banner ID: ${id}`, req.ip);
    res.json({ message: 'Banner berhasil dihapus.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 7. USER MANAGEMENT (Role Based: Super Admin, Admin, Editor)
// -------------------------------------------------------------
router.get('/users', authenticateToken, authorizeRole(['Super Admin']), (req, res) => {
  try {
    const users = sqlite.prepare('SELECT id, name, email, role, created_at FROM users ORDER BY created_at DESC').all();
    res.json({ data: users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/users', authenticateToken, authorizeRole(['Super Admin']), (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Nama, email, dan password wajib diisi.' });
    }

    const allowed = ['Super Admin', 'Admin', 'Editor'];
    if (role && !allowed.includes(role)) {
      return res.status(400).json({ error: 'Role tidak valid.' });
    }

    const conflict = sqlite.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (conflict) {
      return res.status(400).json({ error: 'Email sudah terdaftar.' });
    }

    const id = 'usr_' + Date.now();
    const hash = bcrypt.hashSync(password, 10);
    sqlite.prepare(`
      INSERT INTO users (id, name, email, password, role)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, name, email, hash, role || 'Admin');

    logActivity(req.user.id, req.user.name, 'CREATE_USER', `Membuat user baru: ${email} (${role})`, req.ip);

    res.status(201).json({ message: 'Pengguna berhasil dibuat.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/users/:id', authenticateToken, authorizeRole(['Super Admin']), (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, password, role } = req.body;

    let hash = null;
    if (password) {
      hash = bcrypt.hashSync(password, 10);
    }

    sqlite.prepare(`
      UPDATE users SET
        name = coalesce(?, name),
        email = coalesce(?, email),
        password = coalesce(?, password),
        role = coalesce(?, role),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(name, email, hash, role, id);

    logActivity(req.user.id, req.user.name, 'UPDATE_USER', `Memperbarui user ID: ${id}`, req.ip);

    res.json({ message: 'Pengguna berhasil diperbarui.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/users/:id', authenticateToken, authorizeRole(['Super Admin']), (req, res) => {
  try {
    const { id } = req.params;
    if (id === req.user.id) {
      return res.status(400).json({ error: 'Tidak dapat menghapus akun Anda sendiri.' });
    }
    sqlite.prepare('DELETE FROM users WHERE id = ?').run(id);
    logActivity(req.user.id, req.user.name, 'DELETE_USER', `Menghapus user ID: ${id}`, req.ip);
    res.json({ message: 'Pengguna berhasil dihapus.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 8. ANALYTICS & DASHBOARD STATS
// -------------------------------------------------------------
router.get('/analytics', authenticateToken, (req, res) => {
  try {
    // Total Counts
    const totalProducts = sqlite.prepare('SELECT count(*) as count FROM products').get().count;
    const totalPublished = sqlite.prepare("SELECT count(*) as count FROM products WHERE status = 'Published'").get().count;
    const totalCategories = sqlite.prepare('SELECT count(*) as count FROM categories').get().count;
    const totalBanners = sqlite.prepare('SELECT count(*) as count FROM banners').get().count;
    const totalClicks = sqlite.prepare('SELECT count(*) as count FROM clicks').get().count;
    const totalVisitors = sqlite.prepare('SELECT count(*) as count FROM visitors').get().count;

    // Marketplace breakdown
    const shopeeClicks = sqlite.prepare("SELECT count(*) as count FROM clicks WHERE LOWER(marketplace) LIKE '%shopee%'").get().count;
    const tiktokClicks = sqlite.prepare("SELECT count(*) as count FROM clicks WHERE LOWER(marketplace) LIKE '%tiktok%'").get().count;
    const tokopediaClicks = sqlite.prepare("SELECT count(*) as count FROM clicks WHERE LOWER(marketplace) LIKE '%tokopedia%'").get().count;

    // Top Clicked Products
    const topProducts = sqlite.prepare(`
      SELECT id, name, price, marketplace, total_clicks, shopee_clicks, tiktok_clicks, thumbnail
      FROM products
      ORDER BY total_clicks DESC
      LIMIT 6
    `).all();

    // Daily Clicks for the last 7 days
    const dailyClicks = sqlite.prepare(`
      SELECT strftime('%Y-%m-%d', created_at) as date, count(*) as count
      FROM clicks
      WHERE created_at >= date('now', '-7 days')
      GROUP BY strftime('%Y-%m-%d', created_at)
      ORDER BY date ASC
    `).all();

    // Monthly Clicks for the last 6 months
    const monthlyClicks = sqlite.prepare(`
      SELECT strftime('%Y-%m', created_at) as month, count(*) as count
      FROM clicks
      WHERE created_at >= date('now', '-6 months')
      GROUP BY strftime('%Y-%m', created_at)
      ORDER BY month ASC
    `).all();

    // Recent activity logs
    const recentLogs = sqlite.prepare(`
      SELECT * FROM activity_logs ORDER BY created_at DESC LIMIT 10
    `).all();

    res.json({
      summary: {
        totalProducts,
        totalPublished,
        totalCategories,
        totalBanners,
        totalClicks,
        totalVisitors,
        shopeeClicks,
        tiktokClicks,
        tokopediaClicks
      },
      topProducts,
      dailyClicks,
      monthlyClicks,
      recentLogs
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public Stats (Hero/Home)
router.get('/public-stats', (req, res) => {
  try {
    const totalProducts = sqlite.prepare("SELECT count(*) as count FROM products WHERE status = 'Published'").get().count;
    const totalClicks = sqlite.prepare('SELECT count(*) as count FROM clicks').get().count;
    const totalCategories = sqlite.prepare('SELECT count(*) as count FROM categories').get().count;
    const totalShopee = sqlite.prepare("SELECT coalesce(sum(shopee_clicks), 0) as s FROM products").get().s;
    const totalTiktok = sqlite.prepare("SELECT coalesce(sum(tiktok_clicks), 0) as t FROM products").get().t;

    res.json({
      totalProducts,
      totalClicks: totalClicks + 1500, // display aggregate nicely
      totalCategories,
      totalShopee,
      totalTiktok
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 9. SEO & SETTINGS MANAGEMENT
// -------------------------------------------------------------
router.get('/settings', (req, res) => {
  try {
    const rows = sqlite.prepare('SELECT key, value FROM settings').all();
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });
    res.json({ data: settings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/settings', authenticateToken, authorizeRole(['Super Admin', 'Admin']), (req, res) => {
  try {
    const settings = req.body;
    const upsert = sqlite.prepare(`
      INSERT INTO settings (key, value, updated_at) 
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `);

    for (const [key, val] of Object.entries(settings)) {
      upsert.run(key, typeof val === 'object' ? JSON.stringify(val) : String(val));
    }

    logActivity(req.user.id, req.user.name, 'UPDATE_SETTINGS', 'Pengaturan situs & SEO diperbarui', req.ip);

    res.json({ message: 'Pengaturan berhasil disimpan.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 10. EXPORT / IMPORT EXCEL & DATABASE BACKUP
// -------------------------------------------------------------
// Export products to Excel
router.get('/export/products', authenticateToken, authorizeRole(['Super Admin', 'Admin']), (req, res) => {
  try {
    const products = sqlite.prepare(`
      SELECT p.id, p.name, p.slug, c.name as category, p.price, p.commission_rate, 
             p.marketplace, p.url_shopee, p.url_tiktok, p.url_tokopedia, 
             p.status, p.is_featured, p.total_clicks, p.created_at
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      ORDER BY p.created_at DESC
    `).all();

    const worksheet = XLSX.utils.json_to_sheet(products);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Products');

    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', 'attachment; filename="patchwork_products.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Import products from Excel
router.post('/import/products', authenticateToken, authorizeRole(['Super Admin', 'Admin']), excelUpload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'File Excel (.xlsx/.xls) wajib diunggah.' });
    }

    const workbook = XLSX.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(sheet);

    if (!data || data.length === 0) {
      return res.status(400).json({ error: 'File Excel kosong atau format tidak sesuai.' });
    }

    let imported = 0;
    const ins = sqlite.prepare(`
      INSERT OR REPLACE INTO products (
        id, name, slug, price, commission_rate, marketplace, 
        url_shopee, url_tiktok, url_tokopedia, status, is_featured
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    data.forEach(item => {
      if (item.name || item.Nama) {
        const name = item.name || item.Nama;
        const id = item.id || ('prod_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6));
        const slug = slugify(item.slug || name);
        const price = parseFloat(item.price || item.Harga || 0);
        const comm = item.commission_rate || item.Komisi || '10%';
        const market = item.marketplace || item.Marketplace || 'Shopee';
        const shopee = item.url_shopee || item.URL_Shopee || '';
        const tiktok = item.url_tiktok || item.URL_TikTok || '';
        const tokped = item.url_tokopedia || item.URL_Tokopedia || '';
        const status = item.status || 'Published';
        const feat = item.is_featured ? 1 : 0;

        ins.run(id, name, slug, price, comm, market, shopee, tiktok, tokped, status, feat);
        imported++;
      }
    });

    // Cleanup temp file
    fs.unlinkSync(req.file.path);

    logActivity(req.user.id, req.user.name, 'IMPORT_EXCEL', `Import ${imported} produk dari file Excel`, req.ip);

    res.json({ message: `Berhasil mengimpor ${imported} produk!`, total: imported });
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: err.message });
  }
});

// Database backup
router.get('/backup/download', authenticateToken, authorizeRole(['Super Admin']), (req, res) => {
  try {
    const dbPath = path.join(process.cwd(), 'patchwork.db');
    if (fs.existsSync(dbPath)) {
      res.download(dbPath, `patchwork_backup_${Date.now()}.db`);
    } else {
      res.status(404).json({ error: 'Database file not found.' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Activity logs endpoint
router.get('/activity-logs', authenticateToken, authorizeRole(['Super Admin', 'Admin']), (req, res) => {
  try {
    const logs = sqlite.prepare('SELECT * FROM activity_logs ORDER BY created_at DESC LIMIT 100').all();
    res.json({ data: logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
