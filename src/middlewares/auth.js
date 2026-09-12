import jwt from 'jsonwebtoken';
import { sqlite } from '../database/db.js';

export const JWT_SECRET = process.env.JWT_SECRET || 'patchwork_super_secret_jwt_key_2026';

export function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : req.cookies?.token;

  if (!token) {
    return res.status(401).json({ error: 'Akses ditolak: Token autentikasi diperlukan.' });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ error: 'Token tidak valid atau telah kedaluwarsa.' });
    }
    
    // Fetch user details from DB to ensure fresh status, role, and profile fields
    let user = sqlite.prepare('SELECT id, name, email, phone, role, status, bio, avatar, tiktok, instagram, shopee, youtube, website, template, custom_slug FROM users WHERE id = ?').get(decoded.id);
    if (!user && decoded.email) {
      user = sqlite.prepare('SELECT id, name, email, phone, role, status, bio, avatar, tiktok, instagram, shopee, youtube, website, template, custom_slug FROM users WHERE email = ?').get(decoded.email);
    }
    if (!user && decoded.role) {
      // If user was created in previous container instance, allow valid decoded token payload
      user = { id: decoded.id, name: decoded.name, email: decoded.email, phone: decoded.phone, role: decoded.role, status: decoded.status || 'Approved' };
    }
    if (!user) {
      return res.status(403).json({ error: 'Pengguna tidak ditemukan.' });
    }

    if (user.status === 'Pending') {
      return res.status(403).json({ error: 'Akun Anda masih menunggu persetujuan dari Admin. Harap tunggu hingga akun di-approve.' });
    }
    if (user.status === 'Rejected') {
      return res.status(403).json({ error: 'Pendaftaran akun Anda ditolak oleh Admin. Silakan hubungi admin.' });
    }

    req.user = user;
    next();
  });
}

export function authorizeRole(allowedRoles = []) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Tidak terotentikasi.' });
    }
    
    if (allowedRoles.length > 0 && !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ 
        error: `Akses ditolak. Peran '${req.user.role}' tidak memiliki izin untuk tindakan ini. Diperlukan salah satu dari: ${allowedRoles.join(', ')}` 
      });
    }
    next();
  };
}
