# PATCHWORK - Platform Manajemen Link Affiliate Multi-Marketplace

**PATCHWORK** adalah platform kurasi dan manajemen link affiliate profesional untuk mengelola produk affiliate dari **TikTok Shop**, **Shopee Affiliate**, dan **Tokopedia** dalam satu dashboard terintegrasi.

---

## 🌟 Fitur Utama

### 1. Halaman Publik (Pengunjung)
- **Hero & Dynamic Banners**: Slider banner promo dengan CTA langsung ke produk.
- **Trending / Viral Products**: Produk rekomendasi unggulan dengan badge viral & komisi.
- **Katalog Produk Terlengkap**: Filter marketplace (Shopee, TikTok Shop, Tokopedia), filter kategori, live search, serta pengurutan (terbaru, harga, popularitas).
- **Halaman Detail Produk (`/product/:slug`)**:
  - Galeri gambar resolusi tinggi (Thumbnail + Multi Gallery).
  - Tombol aksi langsung ke Shopee Affiliate, TikTok Shop, & Tokopedia.
  - Estimasi komisi affiliate & live tracking klik.
  - Tombol bagikan ke WhatsApp, copy link affiliate satu klik, dan **Generate QR Code**.
- **CTA Join Affiliate Community**: Ajak pengunjung bergabung ke channel info promo / Telegram.
- **PWA (Progressive Web App)**: Bisa diinstal di Android/iOS layaknya aplikasi native dengan offline support (`manifest.json` & `sw.js`).
- **Dark Mode / Light Mode**: Tampilan responsif dan nyaman di perangkat mobile maupun desktop.

---

### 2. Panel Admin Terpadu (`/admin`)
- **Login Autentikasi JWT**: Aman dengan bcrypt password hashing & rate limiting.
- **Multi-Role User Management**:
  - **Super Admin**: Akses penuh ke seluruh fitur, manajemen user, backup database.
  - **Admin**: Mengelola produk, kategori, banner, settings SEO, serta audit log.
  - **Editor**: Mengelola dan memperbarui produk affiliate.
- **Dashboard Analytics Real-Time**:
  - Total Produk, Klik Affiliate, Total Kategori, Banner, dan Pengunjung.
  - Perbandingan klik per marketplace (**Shopee vs TikTok vs Tokopedia**).
  - **Grafik Tren Klik 7 Hari Terakhir** interaktif bertenaga Chart.js.
  - Daftar produk terlaris & paling banyak diklik pengunjung.
- **Manajemen Produk**:
  - Tambah, edit, hapus, status (Published / Draft), status unggulan (Featured).
  - Input link Shopee, TikTok Shop, Tokopedia, harga promo, estimasi komisi, dan upload gambar thumbnail.
- **Manajemen Kategori & Banner**:
  - Custom kategori dengan slug otomatis dan icon.
  - Atur urutan tampilan dan banner campaign di homepage.
- **Alat Import / Export & Backup**:
  - **Export ke Excel (.xlsx)**: Unduh seluruh database produk & metrik klik.
  - **Import dari Excel**: Upload massal produk affiliate melalui file spreadsheet.
  - **Database Backup**: Download snapshot database SQLite dengan satu klik.
- **Audit Log Aktivitas**:
  - Mencatat waktu, aktor, aksi (login, tambah produk, ubah kategori, dll), beserta IP address.
- **Manajemen SEO**:
  - Konfigurasi Meta Title, Meta Description, Open Graph Image, Robots.txt, dan **Dynamic Sitemap XML** (`/sitemap.xml`).

---

### 3. Arsitektur Database & Backend
- **Database Hybrid**:
  - Mendukung **Supabase PostgreSQL** lengkap dengan **Row Level Security (RLS)** & Supabase Storage. File skema telah disiapkan di [`supabase_schema.sql`](file:///data/data/com.termux/files/home/patchwork/supabase_schema.sql).
  - Dilengkapi SQLite WASM engine (`patchwork.db`) bawaan yang **100% siap pakai tanpa konfigurasi tambahan**.
- **Keamanan Berlapis**:
  - JWT Authentication Middleware.
  - Role-Based Access Control (RBAC).
  - Helmet HTTP Security Headers.
  - Rate Limiting untuk perlindungan Brute-force & API abuse.
  - Audit Trail Activity Logs.

---

## 🚀 Panduan Menjalankan Aplikasi

### Akses Server
Aplikasi saat ini telah aktif di port `3000`:
- **Halaman Utama (Publik)**: `http://localhost:3000`
- **Panel Admin**: `http://localhost:3000/admin`
- **Sitemap XML**: `http://localhost:3000/sitemap.xml`
- **Robots.txt**: `http://localhost:3000/robots.txt`

### Akun Login Admin
Panel admin diakses langsung lewat **`/admin`** (tanpa link publik). Kredensial Super Admin ditentukan dari variabel lingkungan `ADMIN_EMAIL` & `ADMIN_PASSWORD` di file `.env` lokal (tidak pernah masuk ke kode atau GitHub).
