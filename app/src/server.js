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

const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const thumbsDir = path.join(uploadDir, 'thumbs');
fs.mkdirSync(thumbsDir, { recursive: true });
app.use('/uploads', express.static(uploadDir));

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme';

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
    const [rows] = await pool.query('SELECT id, email, password_hash FROM users WHERE email = ?', [identifier]);
    if (!rows || rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
    const user = rows[0];
    const ok = await bcrypt.compare(password || '', user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
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
    const [rows] = await pool.query('SELECT id, name, created_at FROM albums ORDER BY created_at DESC');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'DB error', details: e.message });
  }
});

app.post('/api/albums', requireAuth, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || name.trim().length === 0) return res.status(400).json({ error: 'Album name required' });
    const pool = getPool();
    const [result] = await pool.query('INSERT INTO albums (name) VALUES (?)', [name]);
    res.status(201).json({ id: result.insertId, name });
  } catch (e) {
    res.status(500).json({ error: 'Create failed', details: e.message });
  }
});

// Update album
app.put('/api/albums/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  
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
    
    // Update the album
    await pool.query('UPDATE albums SET name = ? WHERE id = ?', [name.trim(), id]);
    res.json({ message: 'Album updated successfully' });
  } catch (err) {
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
    const [result] = await pool.query('INSERT INTO users (email, password_hash) VALUES (?, ?)', [normalizedEmail, hash]);
    // auto-login after signup
    req.session.authenticated = true;
    req.session.userId = result.insertId;
    req.session.isAdmin = false;
    res.status(201).json({ success: true, user: { id: result.insertId, email: normalizedEmail } });
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

    let query = 'SELECT i.id, i.album_id, i.user_id, i.filename, i.title, i.date_taken, i.created_at, COUNT(l.id) as like_count';
    let params = [];
    if (userId) {
      query += ', MAX(CASE WHEN l.user_id = ? THEN 1 ELSE 0 END) as user_liked';
      params.push(userId);
    }
    query += ' FROM images i LEFT JOIN likes l ON i.id = l.image_id';
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
    await pool.query('INSERT INTO images (album_id, user_id, filename, title, date_taken) VALUES (?, ?, ?, ?, ?)', [albumId, uploaderId, file.filename, title, dateTaken]);
    res.status(201).json({ filename: file.filename, title, album_id: albumId, date_taken: dateTaken });
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
    const { title } = req.body;
    const pool = getPool();
    const [rows] = await pool.query('SELECT user_id FROM images WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Image not found' });
    const image = rows[0];
    const isAdmin = req.session.isAdmin === true;
    const isOwner = image.user_id && req.session.userId && image.user_id === req.session.userId;
    if (!isAdmin && !isOwner) {
      return res.status(403).json({ error: 'You do not have permission to edit this image' });
    }
    await pool.query('UPDATE images SET title = ? WHERE id = ?', [title, req.params.id]);
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


const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`App listening on ${port}`);
});
