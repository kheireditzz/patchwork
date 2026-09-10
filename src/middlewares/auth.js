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
    
    // Fetch user details from DB to ensure fresh status and role
    const user = sqlite.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(decoded.id);
    if (!user) {
      return res.status(403).json({ error: 'Pengguna tidak ditemukan.' });
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
