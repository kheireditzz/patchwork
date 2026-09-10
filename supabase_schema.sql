-- =========================================================================
-- PATCHWORK SUPABASE POSTGRESQL SCHEMA & ROW LEVEL SECURITY (RLS)
-- =========================================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- USERS TABLE
CREATE TABLE IF NOT EXISTS public.users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT CHECK (role IN ('Super Admin', 'Admin', 'Editor')) NOT NULL DEFAULT 'Admin',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- CATEGORIES TABLE
CREATE TABLE IF NOT EXISTS public.categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    icon TEXT DEFAULT 'tag',
    description TEXT,
    color TEXT DEFAULT '#3B82F6',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- PRODUCTS TABLE
CREATE TABLE IF NOT EXISTS public.products (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    category_id UUID REFERENCES public.categories(id) ON DELETE SET NULL,
    description TEXT,
    price NUMERIC(15,2) DEFAULT 0,
    commission_rate TEXT,
    marketplace TEXT DEFAULT 'Shopee',
    url_shopee TEXT,
    url_tiktok TEXT,
    url_tokopedia TEXT,
    thumbnail TEXT,
    gallery JSONB DEFAULT '[]'::jsonb,
    status TEXT CHECK (status IN ('Draft', 'Published')) NOT NULL DEFAULT 'Published',
    is_featured BOOLEAN DEFAULT false,
    total_clicks BIGINT DEFAULT 0,
    shopee_clicks BIGINT DEFAULT 0,
    tiktok_clicks BIGINT DEFAULT 0,
    tokopedia_clicks BIGINT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- BANNERS TABLE
CREATE TABLE IF NOT EXISTS public.banners (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title TEXT NOT NULL,
    subtitle TEXT,
    image TEXT NOT NULL,
    target_url TEXT,
    status TEXT CHECK (status IN ('Draft', 'Published')) NOT NULL DEFAULT 'Published',
    display_order INT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- CLICKS TABLE
CREATE TABLE IF NOT EXISTS public.clicks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_id UUID REFERENCES public.products(id) ON DELETE CASCADE,
    marketplace TEXT NOT NULL,
    visitor_ip TEXT,
    user_agent TEXT,
    referrer TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- VISITORS TABLE
CREATE TABLE IF NOT EXISTS public.visitors (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    visitor_ip TEXT,
    user_agent TEXT,
    page TEXT,
    referrer TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- SETTINGS TABLE
CREATE TABLE IF NOT EXISTS public.settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ACTIVITY LOGS TABLE
CREATE TABLE IF NOT EXISTS public.activity_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID,
    user_name TEXT,
    action TEXT NOT NULL,
    details JSONB,
    ip_address TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ROW LEVEL SECURITY (RLS) POLICIES
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.banners ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clicks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.visitors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;

-- Public can read published products, categories, banners, settings
CREATE POLICY "Public products view" ON public.products FOR SELECT USING (status = 'Published');
CREATE POLICY "Public categories view" ON public.categories FOR SELECT USING (true);
CREATE POLICY "Public banners view" ON public.banners FOR SELECT USING (status = 'Published');
CREATE POLICY "Public settings view" ON public.settings FOR SELECT USING (true);
CREATE POLICY "Public can log clicks" ON public.clicks FOR INSERT WITH CHECK (true);
CREATE POLICY "Public can log visitors" ON public.visitors FOR INSERT WITH CHECK (true);

-- Authenticated admins have full management access
CREATE POLICY "Admin manage products" ON public.products FOR ALL TO authenticated USING (true);
CREATE POLICY "Admin manage categories" ON public.categories FOR ALL TO authenticated USING (true);
CREATE POLICY "Admin manage banners" ON public.banners FOR ALL TO authenticated USING (true);
CREATE POLICY "Admin manage settings" ON public.settings FOR ALL TO authenticated USING (true);
CREATE POLICY "Admin view clicks" ON public.clicks FOR ALL TO authenticated USING (true);
CREATE POLICY "Admin view visitors" ON public.visitors FOR ALL TO authenticated USING (true);
CREATE POLICY "Admin view activity" ON public.activity_logs FOR ALL TO authenticated USING (true);
CREATE POLICY "Admin manage users" ON public.users FOR ALL TO authenticated USING (true);

-- Supabase Storage Bucket Creation SQL
INSERT INTO storage.buckets (id, name, public) VALUES ('patchwork', 'patchwork', true) ON CONFLICT (id) DO NOTHING;
CREATE POLICY "Public Access Storage" ON storage.objects FOR SELECT USING (bucket_id = 'patchwork');
CREATE POLICY "Auth Upload Storage" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'patchwork');
