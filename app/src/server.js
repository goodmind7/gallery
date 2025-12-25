const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const multer = require('multer');
const sharp = require('sharp');
const fs = require('fs');
const session = require('express-session');
const { getPool } = require('./db');
const bcrypt = require('bcryptjs');
const exifr = require('exifr');

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(morgan('dev'));
app.use(session({
  secret: process.env.SESSION_SECRET || 'changeme-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, httpOnly: true, maxAge: 24*60*60*1000 }
}));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Ensure DB schema upgrades (idempotent)
async function ensureSchema() {
  try {
    const pool = getPool();
    await pool.query('ALTER TABLE images ADD COLUMN IF NOT EXISTS description TEXT NULL');
  } catch (e) {
    // Ignore if DB not ready or lacks permissions; routes may error until fixed
    console.log('Schema check: ', e.message);
  }
}
ensureSchema();

const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const thumbsDir = path.join(uploadDir, 'thumbs');
fs.mkdirSync(thumbsDir, { recursive: true });

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme';

// Protected file serving for uploads (including thumbs)
app.get('/uploads/*', async (req, res) => {
  try {
    const relPath = req.params[0]; // e.g., 'thumbs/file.jpg' or 'file.jpg'
    if (!relPath) return res.status(400).json({ error: 'Missing file path' });

    // Prevent path traversal
    const safePath = path.normalize(relPath).replace(/^\.\/+/, '');
    const absPath = path.join(uploadDir, safePath);
    if (!absPath.startsWith(uploadDir)) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    // Always allow thumbnails to be publicly viewable
    if (relPath.startsWith('thumbs/')) {
      if (!fs.existsSync(absPath)) return res.status(404).json({ error: 'Not found' });
      return res.sendFile(absPath);
    }

    const baseName = path.basename(relPath); // use filename to look up DB record

    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT i.id, i.album_id, a.is_public AS album_public
       FROM images i
       LEFT JOIN albums a ON a.id = i.album_id
       WHERE i.filename = ?
       LIMIT 1`,
      [baseName]
    );

    const img = rows && rows[0];
    const isPrivateAlbum = img && img.album_public === 0;
    const isPublicAlbum = img && img.album_public === 1;
    const isOrphan = img && img.album_id === null; // treat no-album images as public
    const loggedIn = !!(req.session && req.session.authenticated);

    const allowed = !img || isPublicAlbum || isOrphan || loggedIn;
    if (!allowed) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (!fs.existsSync(absPath)) {
      return res.status(404).json({ error: 'Not found' });
    }

    return res.sendFile(absPath);
  } catch (e) {
    return res.status(500).json({ error: 'Failed to serve file' });
  }
});

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ts = Date.now();
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-z0-9_-]/gi, '_');
    cb(null, `${base}_${ts}${ext}`);
  }
});
const upload = multer({ storage });

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/login', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    const identifier = (email || username || '').trim();

    // Admin fallback login
    if (identifier === ADMIN_USER && password === ADMIN_PASS) {
      req.session.authenticated = true;
      req.session.userId = null;
      req.session.isAdmin = true;
      return res.json({ success: true, user: { admin: true } });
    }

    // DB user login by email
    const pool = getPool();
    const [rows] = await pool.query('SELECT id, email, password_hash, approved FROM users WHERE email = ?', [identifier]);
    if (!rows || rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
    const user = rows[0];
    const ok = await bcrypt.compare(password || '', user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    if (!user.approved) return res.status(403).json({ error: 'Account pending admin approval' });
    req.session.authenticated = true;
    req.session.userId = user.id;
    req.session.isAdmin = false;
    return res.json({ success: true, user: { id: user.id, email: user.email } });
  } catch (e) {
    res.status(500).json({ error: 'Login failed', details: e.message });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/auth/check', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

app.get('/api/me', async (req, res) => {
  try {
    if (!(req.session && req.session.authenticated)) {
      return res.json({ authenticated: false });
    }
    if (req.session.isAdmin) {
      return res.json({ authenticated: true, user: { admin: true, email: null } });
    }
    const pool = getPool();
    const [rows] = await pool.query('SELECT id, email FROM users WHERE id = ?', [req.session.userId]);
    if (!rows || rows.length === 0) return res.json({ authenticated: false });
    res.json({ authenticated: true, user: rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch user', details: e.message });
  }
});

app.get('/api/admin/stats', async (req, res) => {
  try {
    if (!(req.session && req.session.authenticated && req.session.isAdmin)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const pool = getPool();
    const [userCount] = await pool.query('SELECT COUNT(*) as count FROM users');
    const [imageCount] = await pool.query('SELECT COUNT(*) as count FROM images');
    const [albumCount] = await pool.query('SELECT COUNT(*) as count FROM albums');
    const [likeCount] = await pool.query('SELECT COUNT(*) as count FROM likes');
    const [recentImages] = await pool.query('SELECT id, filename, title, created_at FROM images ORDER BY created_at DESC LIMIT 5');
    const [users] = await pool.query('SELECT id, email, created_at FROM users ORDER BY created_at DESC');

    res.json({
      stats: {
        users: userCount[0].count,
        images: imageCount[0].count,
        albums: albumCount[0].count,
        likes: likeCount[0].count
      },
      recentImages,
      users
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch stats', details: e.message });
  }
});

app.get('/api/albums', async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT a.id, a.name, a.is_public, a.created_at, COUNT(i.id) as image_count
       FROM albums a
       LEFT JOIN images i ON a.id = i.album_id
       GROUP BY a.id, a.name, a.is_public, a.created_at
       ORDER BY a.created_at DESC`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'DB error', details: e.message });
  }
});

app.post('/api/albums', requireAuth, async (req, res) => {
  try {
    const { name, is_public } = req.body;
    if (!name || name.trim().length === 0) return res.status(400).json({ error: 'Album name required' });
    const isPublic = is_public === undefined ? 1 : (is_public ? 1 : 0);
    const pool = getPool();
    const [result] = await pool.query('INSERT INTO albums (name, is_public) VALUES (?, ?)', [name, isPublic]);
    res.status(201).json({ id: result.insertId, name, is_public: !!isPublic });
  } catch (e) {
    res.status(500).json({ error: 'Create failed', details: e.message });
  }
});

// Update album
app.put('/api/albums/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { name, is_public } = req.body;
  
  console.log('PUT /api/albums/:id', { id, name, is_public });
  
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Album name is required' });
  }
  
  try {
    const pool = getPool();
    // Check if album exists
    const [albums] = await pool.query('SELECT * FROM albums WHERE id = ?', [id]);
    
    if (!albums || albums.length === 0) {
      return res.status(404).json({ error: 'Album not found' });
    }
    
    const updates = ['name = ?'];
    const params = [name.trim()];
    if (is_public !== undefined) {
      updates.push('is_public = ?');
      params.push(is_public ? 1 : 0);
    }
    params.push(id);
    console.log('Query:', `UPDATE albums SET ${updates.join(', ')} WHERE id = ?`, params);
    const result = await pool.query(`UPDATE albums SET ${updates.join(', ')} WHERE id = ?`, params);
    console.log('Update result:', result);
    res.json({ message: 'Album updated successfully' });
  } catch (err) {
    console.error('Error updating album:', err);
    res.status(500).json({ error: 'Failed to update album' });
  }
});

// Delete album
app.delete('/api/albums/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  
  try {
    const pool = getPool();
    // Check if album exists
    const [albums] = await pool.query('SELECT * FROM albums WHERE id = ?', [id]);
    
    if (!albums || albums.length === 0) {
      return res.status(404).json({ error: 'Album not found' });
    }
    
    // Remove album_id from images (set to NULL)
    await pool.query('UPDATE images SET album_id = NULL WHERE album_id = ?', [id]);
    
    // Delete the album
    await pool.query('DELETE FROM albums WHERE id = ?', [id]);
    
    res.json({ message: 'Album deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete album' });
  }
});

// Admin: Get pending users (not approved)
app.get('/api/admin/pending-users', requireAuth, async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Admin only' });
  try {
    const pool = getPool();
    const [users] = await pool.query('SELECT id, email, created_at FROM users WHERE approved = 0 ORDER BY created_at DESC');
    res.json({ users });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch pending users' });
  }
});

// Admin: Approve user
app.post('/api/admin/approve-user', requireAuth, async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Admin only' });
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    const pool = getPool();
    await pool.query('UPDATE users SET approved = 1 WHERE id = ?', [userId]);
    res.json({ success: true, message: 'User approved' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to approve user' });
  }
});

// Admin: Reject user (delete account)
app.post('/api/admin/reject-user', requireAuth, async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Admin only' });
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    const pool = getPool();
    await pool.query('DELETE FROM users WHERE id = ?', [userId]);
    res.json({ success: true, message: 'User rejected and deleted' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to reject user' });
  }
});

app.post('/api/signup', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const normalizedEmail = (email || '').trim().toLowerCase();
    if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return res.status(400).json({ error: 'Valid email required' });
    }
    if (!password || String(password).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    const pool = getPool();
    const [exists] = await pool.query('SELECT id FROM users WHERE email = ?', [normalizedEmail]);
    if (exists.length > 0) return res.status(409).json({ error: 'Email already in use' });
    const hash = await bcrypt.hash(password, 10);
    const [result] = await pool.query('INSERT INTO users (email, password_hash, approved) VALUES (?, ?, 0)', [normalizedEmail, hash]);
    // Don't auto-login; user needs admin approval
    res.status(201).json({ success: true, message: 'Account created. Awaiting admin approval before you can log in.', pendingApproval: true });
  } catch (e) {
    res.status(500).json({ error: 'Signup failed', details: e.message });
  }
});

app.get('/api/images', async (req, res) => {
  try {
    const pool = getPool();
    const albumId = req.query.album_id ? parseInt(req.query.album_id) : null;
    const userId = (req.session && req.session.userId) || null;
    // Sorting allowlist
    let sort = (req.query.sort || 'created_at').toString();
    let order = (req.query.order || 'desc').toString().toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const allowedSorts = new Set(['created_at', 'date_taken', 'title', 'like_count']);
    if (!allowedSorts.has(sort)) sort = 'created_at';
    // Include album public flag
    let query = 'SELECT i.id, i.album_id, i.user_id, i.filename, i.title, i.description, i.date_taken, i.created_at, COUNT(l.id) as like_count, (SELECT COUNT(*) FROM comments c WHERE c.image_id = i.id) AS comment_count, MAX(a.is_public) AS album_public';
    let params = [];
    if (userId) {
      query += ', MAX(CASE WHEN l.user_id = ? THEN 1 ELSE 0 END) as user_liked';
      params.push(userId);
    }
    query += ' FROM images i LEFT JOIN likes l ON i.id = l.image_id LEFT JOIN albums a ON a.id = i.album_id';
    if (albumId) {
      query += ' WHERE i.album_id = ?';
      params.push(albumId);
    }
    // ORDER BY mapping
    let orderByExpr = 'i.created_at';
    if (sort === 'date_taken') {
      // Put non-null dates first, then sort by date
      orderByExpr = `i.date_taken IS NULL, i.date_taken ${order}`;
      // Secondary tie-breaker
      query += ` GROUP BY i.id ORDER BY ${orderByExpr}, i.created_at ${order}`;
    } else if (sort === 'title') {
      orderByExpr = `i.title IS NULL, i.title ${order}`;
      query += ` GROUP BY i.id ORDER BY ${orderByExpr}, i.created_at ${order}`;
    } else if (sort === 'like_count') {
      orderByExpr = `like_count ${order}`;
      query += ` GROUP BY i.id ORDER BY ${orderByExpr}, i.created_at ${order}`;
    } else {
      // created_at default
      query += ` GROUP BY i.id ORDER BY i.created_at ${order}, i.id DESC`;
    }
    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'DB error', details: e.message });
  }
});

// ============ COMMENTS (MUST BE BEFORE GENERIC :id ROUTES) ============
// Get comments for an image
app.get('/api/images/:id/comments', async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query(`
      SELECT 
        c.id, 
        c.text, 
        c.author_name, 
        c.user_id, 
        c.created_at,
        u.email
      FROM comments c
      LEFT JOIN users u ON c.user_id = u.id
      WHERE c.image_id = ?
      ORDER BY c.created_at ASC
    `, [req.params.id]);
    res.json(rows || []);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch comments', details: e.message });
  }
});

// Create a comment
app.post('/api/images/:id/comments', async (req, res) => {
  try {
    const pool = getPool();
    const { text, author_name } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Comment text is required' });
    }
    
    const userId = req.session?.userId || null;
    const nameToUse = userId ? null : (author_name || 'Anonymous');
    
    const [result] = await pool.query(
      'INSERT INTO comments (image_id, user_id, author_name, text) VALUES (?, ?, ?, ?)',
      [req.params.id, userId, nameToUse, text.trim()]
    );
    
    res.json({ id: result.insertId, text: text.trim(), author_name: nameToUse, user_id: userId, created_at: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: 'Failed to create comment', details: e.message });
  }
});

// Delete a comment
app.delete('/api/comments/:id', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const [comment] = await pool.query('SELECT user_id, image_id FROM comments WHERE id = ?', [req.params.id]);
    if (!comment || comment.length === 0) {
      return res.status(404).json({ error: 'Comment not found' });
    }
    
    const isAdmin = req.session?.isAdmin === true;
    const isOwner = comment[0].user_id === req.session?.userId;
    
    if (!isAdmin && !isOwner) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    
    await pool.query('DELETE FROM comments WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete comment', details: e.message });
  }
});

// Admin: Get all comments
app.get('/api/comments/all', requireAuth, async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Admin only' });
  try {
    const pool = getPool();
    const [comments] = await pool.query(`
      SELECT 
        c.id, 
        c.text, 
        c.author_name, 
        c.user_id, 
        c.image_id,
        c.created_at,
        i.title as image_title,
        u.email
      FROM comments c
      LEFT JOIN users u ON c.user_id = u.id
      LEFT JOIN images i ON c.image_id = i.id
      ORDER BY c.created_at DESC
    `);
    res.json({ comments: comments || [] });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch comments', details: e.message });
  }
});

app.post('/api/images', upload.single('image'), async (req, res) => {
  try {
    const file = req.file;
    const title = req.body.title || null;
    const albumId = req.body.album_id ? parseInt(req.body.album_id) : null;
    let dateTaken = req.body.date_taken || null;
    
    if (!file) return res.status(400).json({ error: 'No image file uploaded' });
    
    // Extract EXIF date if date_taken not provided
    if (!dateTaken) {
      try {
        const filePath = path.join(uploadDir, file.filename);
        const exif = await exifr.parse(filePath, { pick: ['DateTimeOriginal', 'CreateDate', 'DateTime'] });
        if (exif) {
          const exifDate = exif.DateTimeOriginal || exif.CreateDate || exif.DateTime;
          if (exifDate) {
            // Format as YYYY-MM-DD for MySQL DATE type
            const d = new Date(exifDate);
            if (!isNaN(d.getTime())) {
              dateTaken = d.toISOString().split('T')[0];
            }
          }
        }
      } catch (exifErr) {
        // EXIF parsing failed, continue without date
        console.log('EXIF parsing failed:', exifErr.message);
      }
    }
    
    // Generate thumbnail (same filename under /thumbs/)
    try {
      const srcPath = path.join(uploadDir, file.filename);
      const thumbPath = path.join(thumbsDir, file.filename);
      await sharp(srcPath)
        .rotate()
        .resize({ width: 360, height: 240, fit: 'cover' })
        .jpeg({ quality: 75 })
        .toFile(thumbPath);
    } catch (thumbErr) {
      console.log('Thumbnail generation failed:', thumbErr.message);
    }

    const pool = getPool();
    const uploaderId = (req.session && req.session.userId) || null;
    const description = req.body.description || null;
    await pool.query('INSERT INTO images (album_id, user_id, filename, title, description, date_taken) VALUES (?, ?, ?, ?, ?, ?)', [albumId, uploaderId, file.filename, title, description, dateTaken]);
    res.status(201).json({ filename: file.filename, title, description, album_id: albumId, date_taken: dateTaken });
  } catch (e) {
    res.status(500).json({ error: 'Upload failed', details: e.message });
  }
});

app.delete('/api/images/:id', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query('SELECT filename, user_id FROM images WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const image = rows[0];
    const isAdmin = req.session.isAdmin === true;
    const isOwner = image.user_id && req.session.userId && image.user_id === req.session.userId;
    if (!isAdmin && !isOwner) {
      return res.status(403).json({ error: 'You do not have permission to delete this image' });
    }
    await pool.query('DELETE FROM images WHERE id = ?', [req.params.id]);
    const filename = image.filename;
    const filePath = path.join(uploadDir, filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    const thumbPath = path.join(thumbsDir, filename);
    if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Delete failed', details: e.message });
  }
});
// Admin endpoint to regenerate missing thumbnails for existing images
app.post('/api/admin/thumbnails/regenerate', async (req, res) => {
  try {
    if (!(req.session && req.session.authenticated && req.session.isAdmin)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const pool = getPool();
    const [images] = await pool.query('SELECT filename FROM images');
    let generated = 0;
    for (const img of images) {
      const srcPath = path.join(uploadDir, img.filename);
      const thumbPath = path.join(thumbsDir, img.filename);
      if (fs.existsSync(srcPath) && !fs.existsSync(thumbPath)) {
        try {
          await sharp(srcPath)
            .rotate()
            .resize({ width: 360, height: 240, fit: 'cover' })
            .jpeg({ quality: 75 })
            .toFile(thumbPath);
          generated++;
        } catch (err) {
          console.log('Failed thumb for', img.filename, err.message);
        }
      }
    }
    res.json({ success: true, generated });
  } catch (e) {
    res.status(500).json({ error: 'Regenerate failed', details: e.message });
  }
});

app.put('/api/images/:id', requireAuth, async (req, res) => {
  try {
    const { title, description } = req.body;
    const pool = getPool();
    const [rows] = await pool.query('SELECT user_id FROM images WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Image not found' });
    const image = rows[0];
    const isAdmin = req.session.isAdmin === true;
    const isOwner = image.user_id && req.session.userId && image.user_id === req.session.userId;
    if (!isAdmin && !isOwner) {
      return res.status(403).json({ error: 'You do not have permission to edit this image' });
    }
    const fields = [];
    const params = [];
    if (title !== undefined) { fields.push('title = ?'); params.push(title); }
    if (description !== undefined) { fields.push('description = ?'); params.push(description); }
    if (fields.length === 0) { return res.status(400).json({ error: 'No fields to update' }); }
    params.push(req.params.id);
    await pool.query(`UPDATE images SET ${fields.join(', ')} WHERE id = ?`, params);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Update failed', details: e.message });
  }
});

app.post('/api/images/:id/like', async (req, res) => {
  try {
    if (!(req.session && req.session.authenticated && req.session.userId)) {
      return res.status(401).json({ error: 'Must be logged in to like' });
    }
    const pool = getPool();
    const imageId = req.params.id;
    const userId = req.session.userId;
    // Check if image exists
    const [imgRows] = await pool.query('SELECT id FROM images WHERE id = ?', [imageId]);
    if (!imgRows || imgRows.length === 0) return res.status(404).json({ error: 'Image not found' });
    // Insert like (unique constraint will prevent duplicates)
    await pool.query('INSERT IGNORE INTO likes (user_id, image_id) VALUES (?, ?)', [userId, imageId]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Like failed', details: e.message });
  }
});

app.delete('/api/images/:id/like', async (req, res) => {
  try {
    if (!(req.session && req.session.authenticated && req.session.userId)) {
      return res.status(401).json({ error: 'Must be logged in to unlike' });
    }
    const pool = getPool();
    const imageId = req.params.id;
    const userId = req.session.userId;
    await pool.query('DELETE FROM likes WHERE user_id = ? AND image_id = ?', [userId, imageId]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Unlike failed', details: e.message });
  }
});

// Admin: delete a user and their likes
app.delete('/api/admin/users/:id', async (req, res) => {
  try {
    if (!(req.session && req.session.authenticated && req.session.isAdmin)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const userId = parseInt(req.params.id);
    if (!userId || Number.isNaN(userId)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }
    const pool = getPool();
    // Prevent deleting the last remaining user
    const [countRows] = await pool.query('SELECT COUNT(*) AS cnt FROM users');
    const userCount = countRows?.[0]?.cnt ?? 0;
    if (userCount <= 1) {
      return res.status(400).json({ error: 'Cannot delete the last remaining user' });
    }
    // Check existence
    const [rows] = await pool.query('SELECT id FROM users WHERE id = ?', [userId]);
    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    // Remove likes by this user (no FK defined on users)
    await pool.query('DELETE FROM likes WHERE user_id = ?', [userId]);
    // Delete user
    await pool.query('DELETE FROM users WHERE id = ?', [userId]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Delete user failed', details: e.message });
  }
});

// User stats endpoint
app.get('/api/user/stats', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const userId = req.session.userId;
    
    const [imageCount] = await pool.query('SELECT COUNT(*) as count FROM images WHERE user_id = ?', [userId]);
    const [likesCount] = await pool.query('SELECT COUNT(*) as count FROM likes l JOIN images i ON l.image_id = i.id WHERE i.user_id = ?', [userId]);
    const [commentsCount] = await pool.query('SELECT COUNT(*) as count FROM comments WHERE user_id = ?', [userId]);
    const [userInfo] = await pool.query('SELECT email FROM users WHERE id = ?', [userId]);
    
    res.json({
      email: userInfo[0]?.email || '',
      imageCount: imageCount[0]?.count || 0,
      likesCount: likesCount[0]?.count || 0,
      commentsCount: commentsCount[0]?.count || 0
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch stats', details: e.message });
  }
});

// Delete own account endpoint
app.delete('/api/user/me', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const userId = req.session.userId;
    
    // Prevent deleting if admin
    if (req.session.admin === true) {
      return res.status(400).json({ error: 'Admin accounts cannot be deleted this way' });
    }
    
    // Check user count
    const [countRows] = await pool.query('SELECT COUNT(*) AS cnt FROM users');
    const userCount = countRows?.[0]?.cnt ?? 0;
    if (userCount <= 1) {
      return res.status(400).json({ error: 'Cannot delete the last remaining user' });
    }
    
    // Delete user's comments
    await pool.query('DELETE FROM comments WHERE user_id = ?', [userId]);
    // Delete user's likes
    await pool.query('DELETE FROM likes WHERE user_id = ?', [userId]);
    // Delete user's images (this will cascade to likes on those images)
    await pool.query('DELETE FROM images WHERE user_id = ?', [userId]);
    // Delete user
    await pool.query('DELETE FROM users WHERE id = ?', [userId]);
    
    // Destroy session
    req.session.destroy();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Delete account failed', details: e.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`App listening on ${port}`);
});
