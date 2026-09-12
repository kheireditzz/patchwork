-- ==========================================================
-- PATCHWORK DATABASE SCHEMA FOR SUPABASE (POSTGRESQL)
-- Project: https://your-project.supabase.co
-- ==========================================================

-- Enable UUID extension if not enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. USERS TABLE
CREATE TABLE IF NOT EXISTS public.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  phone TEXT,
  password TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'Partner' CHECK (role IN ('Super Admin', 'Admin', 'Editor', 'Partner')),
  status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Approved', 'Rejected')),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 2. CATEGORIES TABLE
CREATE TABLE IF NOT EXISTS public.categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  icon TEXT DEFAULT 'tag',
  description TEXT,
  color TEXT DEFAULT '#3B82F6',
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 3. PRODUCTS TABLE
CREATE TABLE IF NOT EXISTS public.products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  category_id UUID REFERENCES public.categories(id) ON DELETE SET NULL,
  description TEXT,
  price NUMERIC DEFAULT 0,
  commission_rate TEXT,
  marketplace TEXT NOT NULL DEFAULT 'Shopee',
  url_shopee TEXT,
  url_tiktok TEXT,
  url_tokopedia TEXT,
  thumbnail TEXT,
  gallery JSONB DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'Published' CHECK (status IN ('Draft', 'Published')),
  is_featured BOOLEAN DEFAULT FALSE,
  total_clicks INTEGER DEFAULT 0,
  shopee_clicks INTEGER DEFAULT 0,
  tiktok_clicks INTEGER DEFAULT 0,
  tokopedia_clicks INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 4. BANNERS TABLE
CREATE TABLE IF NOT EXISTS public.banners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  subtitle TEXT,
  image TEXT NOT NULL,
  target_url TEXT,
  status TEXT NOT NULL DEFAULT 'Published' CHECK (status IN ('Draft', 'Published')),
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 5. CLICKS TABLE (ANALYTICS)
CREATE TABLE IF NOT EXISTS public.clicks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  marketplace TEXT NOT NULL,
  visitor_ip TEXT,
  user_agent TEXT,
  referrer TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 6. VISITORS TABLE (PAGE VIEWS)
CREATE TABLE IF NOT EXISTS public.visitors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_ip TEXT,
  user_agent TEXT,
  page TEXT,
  referrer TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 7. SETTINGS TABLE
CREATE TABLE IF NOT EXISTS public.settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 8. ACTIVITY LOGS TABLE
CREATE TABLE IF NOT EXISTS public.activity_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  user_name TEXT,
  action TEXT NOT NULL,
  details TEXT,
  ip_address TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 9. PARTNER SUBMISSIONS TABLE (PENGAJUAN PRODUK MITRA)
CREATE TABLE IF NOT EXISTS public.partner_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_name TEXT NOT NULL,
  whatsapp TEXT NOT NULL,
  email TEXT,
  product_name TEXT NOT NULL,
  marketplace TEXT NOT NULL DEFAULT 'Shopee',
  product_url TEXT NOT NULL,
  product_price NUMERIC DEFAULT 0,
  commission_rate TEXT,
  description TEXT,
  image_url TEXT,
  status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Approved', 'Rejected')),
  admin_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_products_category ON public.products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_status ON public.products(status);
CREATE INDEX IF NOT EXISTS idx_products_featured ON public.products(is_featured);
CREATE INDEX IF NOT EXISTS idx_clicks_product ON public.clicks(product_id);
CREATE INDEX IF NOT EXISTS idx_partner_submissions_status ON public.partner_submissions(status);

-- Enable RLS (Row Level Security) and Public Read
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.banners ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_submissions ENABLE ROW LEVEL SECURITY;

-- Allow public read access to active catalogue & banners
CREATE POLICY "Public Read Products" ON public.products FOR SELECT USING (status = 'Published');
CREATE POLICY "Public Read Categories" ON public.categories FOR SELECT USING (true);
CREATE POLICY "Public Read Banners" ON public.banners FOR SELECT USING (status = 'Published');
CREATE POLICY "Public Read Settings" ON public.settings FOR SELECT USING (true);

-- Allow public to submit partner requests (INSERT only)
CREATE POLICY "Public Insert Partner Submissions" ON public.partner_submissions FOR INSERT WITH CHECK (true);

-- Allow Service Role full access
CREATE POLICY "Service Role Products" ON public.products FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service Role Partner Submissions" ON public.partner_submissions FOR ALL USING (auth.role() = 'service_role');
