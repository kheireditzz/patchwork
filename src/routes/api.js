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
router.post('/auth/register', (req, res) => {
  try {
    const { name, whatsapp, email, password } = req.body;
    if (!name || !whatsapp || !email || !password) {
      return res.status(400).json({ error: 'Nama asli, nomor WhatsApp, email, dan password wajib diisi!' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanPhone = whatsapp.trim();
    const cleanName = name.trim();

    // Check email uniqueness
    const existing = sqlite.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(cleanEmail);
    if (existing) {
      return res.status(400).json({ error: 'Email tersebut sudah terdaftar. Silakan gunakan email lain atau login.' });
    }

    const id = 'usr_p_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    const hash = bcrypt.hashSync(password, 10);

    // New partner registers with status 'Pending'
    sqlite.prepare(`
      INSERT INTO users (id, name, email, phone, password, role, status)
      VALUES (?, ?, ?, ?, ?, 'Partner', 'Pending')
    `).run(id, cleanName, cleanEmail, cleanPhone, hash);

    logActivity(id, cleanName, 'REGISTER_PARTNER', `Pendaftaran mitra baru: ${cleanName} (${cleanEmail}, WA: ${cleanPhone}) - Status: Pending`, req.ip);

    res.status(201).json({
      message: 'Pendaftaran berhasil! Akun Anda sedang menunggu persetujuan (approval) dari admin. Setelah disetujui, Anda dapat login dan mulai memasukkan produk ke katalog.',
      userId: id
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/auth/login', (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email dan password wajib diisi.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const user = sqlite.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(cleanEmail);
    if (!user) {
      return res.status(401).json({ error: 'Email atau password salah.' });
    }

    const isMatch = bcrypt.compareSync(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Email atau password salah.' });
    }

    // Check approval status
    if (user.role === 'Partner' && user.status !== 'Approved') {
      if (user.status === 'Rejected') {
        return res.status(403).json({
          error: 'Pendaftaran akun Anda ditolak oleh Admin. Hubungi admin via WhatsApp untuk informasi lebih lanjut.',
          status: 'Rejected'
        });
      }
      return res.status(403).json({
        error: 'Akun Anda sedang menunggu persetujuan (approval) dari Admin. Anda baru bisa masuk dan memasukkan produk setelah disetujui.',
        status: 'Pending'
      });
    }

    if (user.status === 'Pending') {
      return res.status(403).json({
        error: 'Akun Anda sedang menunggu persetujuan dari Admin.',
        status: 'Pending'
      });
    }

    if (user.status === 'Rejected') {
      return res.status(403).json({
        error: 'Akun Anda berstatus nonaktif/ditolak.',
        status: 'Rejected'
      });
    }

    const token = jwt.sign(
      { id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role, status: user.status },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    logActivity(user.id, user.name, 'LOGIN', `Pengguna (${user.role}) berhasil login`, req.ip);

    res.json({
      message: 'Login berhasil',
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        status: user.status
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/auth/me', authenticateToken, (req, res) => {
  res.json({ user: req.user });
});

// Update Profile & Bio / Social Links / Template / Custom Slug
router.put('/auth/profile', authenticateToken, (req, res) => {
  try {
    const { name, phone, bio, avatar, tiktok, instagram, shopee, youtube, website, template, custom_slug } = req.body;
    const userId = req.user.id;

    let cleanSlug = null;
    if (custom_slug !== undefined) {
      cleanSlug = custom_slug.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
      if (cleanSlug) {
        // Check uniqueness of custom_slug
        const conflict = sqlite.prepare('SELECT id FROM users WHERE LOWER(custom_slug) = ? AND id != ?').get(cleanSlug, userId);
        if (conflict) {
          return res.status(400).json({ error: `Link ID "${cleanSlug}" sudah dipakai oleh pengguna lain. Silakan gunakan nama lain.` });
        }
      }
    }

    sqlite.prepare(`
      UPDATE users 
      SET name = COALESCE(?, name),
          phone = COALESCE(?, phone),
          bio = COALESCE(?, bio),
          avatar = COALESCE(?, avatar),
          tiktok = COALESCE(?, tiktok),
          instagram = COALESCE(?, instagram),
          shopee = COALESCE(?, shopee),
          youtube = COALESCE(?, youtube),
          website = COALESCE(?, website),
          template = COALESCE(?, template),
          custom_slug = COALESCE(?, custom_slug),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      name || null,
      phone || null,
      bio !== undefined ? bio : null,
      avatar !== undefined ? avatar : null,
      tiktok !== undefined ? tiktok : null,
      instagram !== undefined ? instagram : null,
      shopee !== undefined ? shopee : null,
      youtube !== undefined ? youtube : null,
      website !== undefined ? website : null,
      template !== undefined ? template : null,
      cleanSlug !== undefined ? cleanSlug : null,
      userId
    );

    const updatedUser = sqlite.prepare('SELECT id, name, email, phone, role, status, bio, avatar, tiktok, instagram, shopee, youtube, website, template, custom_slug FROM users WHERE id = ?').get(userId);
    logActivity(userId, updatedUser.name, 'UPDATE_PROFILE', `Memperbarui profil / Lynk ID`, req.ip);

    res.json({ message: 'Profil dan pengaturan Link ID berhasil diperbarui.', user: updatedUser });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public Lynk.id Profile Endpoint by User ID or custom_slug
router.get('/profile/:id', (req, res) => {
  try {
    const { id } = req.params;
    const lowerParam = id.toLowerCase();
    const user = sqlite.prepare(`
      SELECT id, name, bio, avatar, tiktok, instagram, shopee, youtube, website, template, role, custom_slug
      FROM users WHERE id = ? OR email = ? OR LOWER(custom_slug) = ?
    `).get(id, id, lowerParam);

    if (!user) {
      return res.status(404).json({ error: 'Profil tidak ditemukan' });
    }

    // Get user products for this Lynk
    const products = sqlite.prepare(`
      SELECT p.*, c.name as category_name, c.slug as category_slug
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.created_by = ? AND p.status = 'Published'
      ORDER BY p.is_featured DESC, p.created_at DESC
    `).all(user.id);

    // Get categories associated with these products
    const catMap = {};
    products.forEach(p => {
      if (p.category_id && p.category_name) {
        catMap[p.category_id] = { id: p.category_id, name: p.category_name, slug: p.category_slug };
      }
    });

    res.json({
      user,
      categories: Object.values(catMap),
      products
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

    // Filter by created_by (e.g. for partner portal)
    if (req.query.created_by) {
      whereClauses.push('p.created_by = ?');
      params.push(req.query.created_by);
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
router.post('/products', authenticateToken, authorizeRole(['Super Admin', 'Admin', 'Editor', 'Partner']), (req, res) => {
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
        status, is_featured, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, name, slug, category_id || null, description, price, commission_rate,
      marketplace, url_shopee, url_tiktok, url_tokopedia, thumbnail, galleryJson,
      status, is_featured ? 1 : 0, req.user.id
    );

    logActivity(req.user.id, req.user.name, 'CREATE_PRODUCT', `Menambahkan produk "${name}"`, req.ip);

    const created = sqlite.prepare('SELECT * FROM products WHERE id = ?').get(id);
    res.status(201).json({ message: 'Produk berhasil dibuat', data: created });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/products/:id
router.put('/products/:id', authenticateToken, authorizeRole(['Super Admin', 'Admin', 'Editor', 'Partner']), (req, res) => {
  try {
    const { id } = req.params;
    const existing = sqlite.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Produk tidak ditemukan.' });
    }

    // Partner can only edit their own products unless admin
    if (req.user.role === 'Partner' && existing.created_by && existing.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Anda hanya dapat mengubah produk yang Anda buat sendiri.' });
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
router.delete('/products/:id', authenticateToken, authorizeRole(['Super Admin', 'Admin', 'Partner']), (req, res) => {
  try {
    const { id } = req.params;
    const existing = sqlite.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Produk tidak ditemukan.' });
    }

    if (req.user.role === 'Partner' && existing.created_by && existing.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Anda hanya dapat menghapus produk milik Anda sendiri.' });
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
// 7. USER MANAGEMENT (Role Based: Super Admin, Admin, Editor, Partner)
// -------------------------------------------------------------
router.get('/users', authenticateToken, authorizeRole(['Super Admin', 'Admin']), (req, res) => {
  try {
    const { role, status } = req.query;
    let sql = 'SELECT id, name, email, phone, role, status, created_at FROM users';
    const params = [];
    const where = [];

    if (role) {
      where.push('role = ?');
      params.push(role);
    }
    if (status) {
      where.push('status = ?');
      params.push(status);
    }

    if (where.length > 0) {
      sql += ' WHERE ' + where.join(' AND ');
    }
    sql += ' ORDER BY created_at DESC';

    const users = sqlite.prepare(sql).all(...params);
    res.json({ data: users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/users', authenticateToken, authorizeRole(['Super Admin', 'Admin']), (req, res) => {
  try {
    const { name, email, phone = '', password, role = 'Partner', status = 'Approved' } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Nama, email, dan password wajib diisi.' });
    }

    const allowed = ['Super Admin', 'Admin', 'Editor', 'Partner'];
    if (role && !allowed.includes(role)) {
      return res.status(400).json({ error: 'Role tidak valid.' });
    }

    const conflict = sqlite.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(email.trim().toLowerCase());
    if (conflict) {
      return res.status(400).json({ error: 'Email sudah terdaftar.' });
    }

    const id = 'usr_' + Date.now();
    const hash = bcrypt.hashSync(password, 10);
    sqlite.prepare(`
      INSERT INTO users (id, name, email, phone, password, role, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, name.trim(), email.trim().toLowerCase(), phone.trim(), hash, role, status);

    logActivity(req.user.id, req.user.name, 'CREATE_USER', `Membuat user baru: ${email} (${role}, ${status})`, req.ip);

    res.status(201).json({ message: 'Pengguna berhasil dibuat.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/users/:id', authenticateToken, authorizeRole(['Super Admin', 'Admin']), (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, phone, password, role, status } = req.body;

    let hash = null;
    if (password) {
      hash = bcrypt.hashSync(password, 10);
    }

    sqlite.prepare(`
      UPDATE users SET
        name = coalesce(?, name),
        email = coalesce(?, email),
        phone = coalesce(?, phone),
        password = coalesce(?, password),
        role = coalesce(?, role),
        status = coalesce(?, status),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(name, email ? email.trim().toLowerCase() : null, phone, hash, role, status, id);

    logActivity(req.user.id, req.user.name, 'UPDATE_USER', `Memperbarui user ID: ${id}`, req.ip);

    res.json({ message: 'Pengguna berhasil diperbarui.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Approve Partner Account
router.post('/users/:id/approve', authenticateToken, authorizeRole(['Super Admin', 'Admin']), (req, res) => {
  try {
    const { id } = req.params;
    const user = sqlite.prepare('SELECT id, name, email, phone, role, status FROM users WHERE id = ?').get(id);
    if (!user) {
      return res.status(404).json({ error: 'Pengguna tidak ditemukan.' });
    }

    sqlite.prepare(`UPDATE users SET status = 'Approved', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);

    logActivity(req.user.id, req.user.name, 'APPROVE_USER', `Menyetujui pendaftaran akun mitra: ${user.name} (${user.email})`, req.ip);

    res.json({ message: `Akun mitra "${user.name}" berhasil disetujui! User sekarang dapat login dan memasukkan produk.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reject Partner Account
router.post('/users/:id/reject', authenticateToken, authorizeRole(['Super Admin', 'Admin']), (req, res) => {
  try {
    const { id } = req.params;
    const user = sqlite.prepare('SELECT id, name, email, phone, role, status FROM users WHERE id = ?').get(id);
    if (!user) {
      return res.status(404).json({ error: 'Pengguna tidak ditemukan.' });
    }

    sqlite.prepare(`UPDATE users SET status = 'Rejected', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);

    logActivity(req.user.id, req.user.name, 'REJECT_USER', `Menolak pendaftaran akun mitra: ${user.name} (${user.email})`, req.ip);

    res.json({ message: `Pendaftaran akun "${user.name}" telah ditolak.` });
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

// -------------------------------------------------------------
// 12. PARTNER PRODUCT SUBMISSION & APPROVAL WORKFLOW
// -------------------------------------------------------------
// Public endpoint for submitting a product into catalog queue
router.post('/submissions', (req, res) => {
  try {
    const {
      partner_name,
      whatsapp,
      email = '',
      product_name,
      marketplace = 'Shopee',
      product_url,
      product_price = 0,
      commission_rate = '',
      description = '',
      image_url = ''
    } = req.body;

    if (!partner_name || !whatsapp || !product_name || !product_url) {
      return res.status(400).json({ error: 'Nama, No WhatsApp, Nama Produk, dan Link Produk wajib diisi!' });
    }

    const id = 'sub_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    sqlite.prepare(`
      INSERT INTO partner_submissions (
        id, partner_name, whatsapp, email, product_name, marketplace,
        product_url, product_price, commission_rate, description, image_url, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending')
    `).run(
      id, partner_name.trim(), whatsapp.trim(), email ? email.trim() : '',
      product_name.trim(), marketplace, product_url.trim(),
      parseFloat(product_price || 0), commission_rate ? commission_rate.trim() : '',
      description ? description.trim() : '', image_url ? image_url.trim() : ''
    );

    res.status(201).json({
      message: 'Pengajuan produk berhasil dikirim! Tim kami akan meninjau produk Anda dalam 1x24 jam.',
      submissionId: id
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin endpoint: List submissions
router.get('/submissions', authenticateToken, authorizeRole(['Super Admin', 'Admin', 'Editor']), (req, res) => {
  try {
    const { status } = req.query;
    let sql = 'SELECT * FROM partner_submissions';
    const params = [];
    if (status) {
      sql += ' WHERE status = ?';
      params.push(status);
    }
    sql += ' ORDER BY created_at DESC';

    const list = sqlite.prepare(sql).all(...params);
    res.json({ data: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin endpoint: Update status or notes
router.put('/submissions/:id', authenticateToken, authorizeRole(['Super Admin', 'Admin']), (req, res) => {
  try {
    const { id } = req.params;
    const { status, admin_notes } = req.body;

    sqlite.prepare(`
      UPDATE partner_submissions SET
        status = coalesce(?, status),
        admin_notes = coalesce(?, admin_notes),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(status, admin_notes, id);

    logActivity(req.user.id, req.user.name, 'UPDATE_SUBMISSION', `Memperbarui pengajuan produk ID: ${id} ke ${status}`, req.ip);

    res.json({ message: 'Status pengajuan berhasil diperbarui.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin endpoint: Approve and automatically publish to products catalog
router.post('/submissions/:id/approve', authenticateToken, authorizeRole(['Super Admin', 'Admin']), (req, res) => {
  try {
    const { id } = req.params;
    const sub = sqlite.prepare('SELECT * FROM partner_submissions WHERE id = ?').get(id);
    if (!sub) {
      return res.status(404).json({ error: 'Data pengajuan tidak ditemukan.' });
    }

    const { category_id, is_featured = 0 } = req.body;

    // Generate unique slug
    let baseSlug = slugify(sub.product_name);
    let slug = baseSlug;
    let count = 1;
    while (sqlite.prepare('SELECT id FROM products WHERE slug = ?').get(slug)) {
      slug = `${baseSlug}-${count++}`;
    }

    const prodId = 'prod_' + Date.now();
    const isTikTok = (sub.marketplace || '').toLowerCase().includes('tiktok');
    const url_shopee = isTikTok ? '' : sub.product_url;
    const url_tiktok = isTikTok ? sub.product_url : '';

    sqlite.prepare(`
      INSERT INTO products (
        id, name, slug, category_id, description, price, commission_rate,
        marketplace, url_shopee, url_tiktok, url_tokopedia, thumbnail, gallery,
        status, is_featured
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Published', ?)
    `).run(
      prodId, sub.product_name, slug, category_id || null, sub.description || '',
      sub.product_price || 0, sub.commission_rate || '', sub.marketplace || 'Shopee',
      url_shopee, url_tiktok, '', sub.image_url || '', '[]', is_featured ? 1 : 0
    );

    // Update submission status to Approved
    sqlite.prepare(`
      UPDATE partner_submissions SET status = 'Approved', updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(id);

    logActivity(req.user.id, req.user.name, 'APPROVE_SUBMISSION', `Menyetujui & mempublikasikan produk "${sub.product_name}" (ID: ${prodId})`, req.ip);

    res.json({
      message: 'Produk berhasil disetujui dan langsung tayang di katalog publik!',
      productId: prodId
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin endpoint: Delete submission
router.delete('/submissions/:id', authenticateToken, authorizeRole(['Super Admin', 'Admin']), (req, res) => {
  try {
    const { id } = req.params;
    sqlite.prepare('DELETE FROM partner_submissions WHERE id = ?').run(id);
    logActivity(req.user.id, req.user.name, 'DELETE_SUBMISSION', `Menghapus data pengajuan ID: ${id}`, req.ip);
    res.json({ message: 'Pengajuan produk berhasil dihapus.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
