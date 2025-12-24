let isAuthenticated = false;
let selectedAlbumId = null;
let currentUser = null; // {id, email} or {admin: true}
let allImages = []; // Track all images for modal navigation
let currentImageIndex = -1; // Current image in modal
let showMeta = false; // Controls visibility of meta section
let sortKey = 'created_at';
let sortOrder = 'desc';
let commentAuthorAutoFilled = false;
let gallerySize = 'medium';

const mobileMenuBtn = document.getElementById('mobileMenuBtn');
const mobileMenuOverlay = document.getElementById('mobileMenuOverlay');
const headerActions = document.querySelector('.header-actions');

function openMobileMenu() {
  document.body.classList.add('mobile-menu-open');
}

function closeMobileMenu() {
  document.body.classList.remove('mobile-menu-open');
}

function toggleMobileMenu() {
  document.body.classList.toggle('mobile-menu-open');
}

if (mobileMenuBtn) mobileMenuBtn.addEventListener('click', toggleMobileMenu);
if (mobileMenuOverlay) mobileMenuOverlay.addEventListener('click', closeMobileMenu);
if (headerActions) {
  headerActions.addEventListener('click', (e) => {
    if (window.innerWidth <= 768 && e.target.closest('button')) {
      closeMobileMenu();
    }
  });
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMobileMenu();
});

window.addEventListener('resize', () => {
  if (window.innerWidth > 768) closeMobileMenu();
});

async function checkAuth() {
  try {
    const res = await fetch('/api/me', { credentials: 'include' });
    const data = await res.json();
    isAuthenticated = !!data.authenticated;
    currentUser = isAuthenticated ? (data.user || null) : null;
    updateAuthUI();
    updateMetaToggleUI();
    prefillCommentAuthor();
    await fetchAlbums();
  } catch (e) {
    isAuthenticated = false;
    currentUser = null;
    updateAuthUI();
    updateMetaToggleUI();
    prefillCommentAuthor();
  }
}

function applyGallerySize(size) {
  gallerySize = size;
  const galleryEl = document.getElementById('gallery');
  if (galleryEl) {
    galleryEl.classList.remove('size-small', 'size-medium', 'size-large');
    galleryEl.classList.add(`size-${size}`);
  }
  document.querySelectorAll('.size-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.size === size);
  });
  localStorage.setItem('gallery_size', size);
}

function updateAuthUI() {
  document.getElementById('loginBtn').style.display = isAuthenticated ? 'none' : 'block';
  document.getElementById('logoutBtn').style.display = isAuthenticated ? 'block' : 'none';
  document.getElementById('createAlbumBtn').style.display = isAuthenticated ? 'block' : 'none';
  const toggleUploadBtn = document.getElementById('toggleUploadBtn');
  if (toggleUploadBtn) toggleUploadBtn.style.display = isAuthenticated ? 'block' : 'none';
  
  const isAdmin = currentUser?.admin === true;
  
  const userEl = document.getElementById('userDisplay');
  if (isAuthenticated) {
    let label = currentUser?.admin ? 'admin' : (currentUser?.email || '');
    if (!currentUser?.admin && label) {
      label = label.split('@')[0];
    }
    userEl.textContent = label;
    userEl.style.display = label ? 'inline' : 'none';
    userEl.onclick = () => {
      closeMobileMenu();
      currentUser?.admin ? openDashboard() : openUserDashboard();
    };
    userEl.style.cursor = 'pointer';
  } else {
    userEl.textContent = '';
    userEl.style.display = 'none';
    userEl.onclick = null;
  }
  prefillCommentAuthor();
}

function updateMetaToggleUI() {
  document.body.classList.toggle('show-meta', showMeta);
  const btn = document.getElementById('toggleMetaBtn');
  if (btn) btn.innerHTML = showMeta ? '<i class="fa-solid fa-circle-xmark"></i> <span class="btn-label"> Info</span>' : '<i class="fa-solid fa-circle-info"></i> <span class="btn-label"> Info</span>';
}

function toggleMeta() {
  showMeta = !showMeta;
  updateMetaToggleUI();
  closeMobileMenu();
}

function openUploadModal() {
  if (!isAuthenticated) {
    openLoginModal();
    return;
  }
  document.getElementById('uploadModal').classList.add('show');
}

function closeUploadModal() {
  document.getElementById('uploadModal').classList.remove('show');
  document.getElementById('uploadStatus').textContent = '';
}

async function fetchAlbums() {
  try {
    const res = await fetch('/api/albums');
    const albums = await res.json();
    const select = document.getElementById('albumSelect');
    const list = document.getElementById('albumsList');
    
    select.innerHTML = '<option value="">No Album</option>';
    list.innerHTML = '<button class="album-btn active" onclick="selectAlbum(null)">All</button>';
    
    for (const album of albums) {
      const opt = document.createElement('option');
      opt.value = album.id;
      opt.textContent = album.name;
      select.appendChild(opt);
      
      const btn = document.createElement('button');
      btn.className = 'album-btn';
      btn.textContent = album.name;
      btn.type = 'button';
      btn.onclick = () => selectAlbum(album.id);
      btn.dataset.albumId = album.id;
      list.appendChild(btn);
    }
  } catch (e) {
    console.error('Error fetching albums:', e);
  }
}

function selectAlbum(albumId) {
  selectedAlbumId = albumId;
  document.querySelectorAll('.album-btn').forEach(btn => {
    btn.classList.remove('active');
    if ((albumId === null && btn.textContent === 'All') || 
        (albumId !== null && parseInt(btn.dataset.albumId) === albumId)) {
      btn.classList.add('active');
    }
  });
  fetchImages();
}

async function fetchImages() {
  try {
    const params = new URLSearchParams();
    if (selectedAlbumId !== null && selectedAlbumId !== undefined) {
      params.set('album_id', selectedAlbumId);
    }
    params.set('sort', sortKey);
    params.set('order', sortOrder);
    const url = `/api/images${params.toString() ? `?${params.toString()}` : ''}`;
    const res = await fetch(url);
    const data = await res.json();
    
    if (!res.ok || !Array.isArray(data)) {
      console.error('API error or invalid response:', data);
      document.getElementById('gallery').innerHTML = '<p>Error loading images</p>';
      return;
    }
    
    let items = data;
    // Client-side fallback sort for date_taken to ensure expected ordering
    if (sortKey === 'date_taken') {
      items = [...items].sort((a, b) => {
        const da = a.date_taken ? new Date(a.date_taken).getTime() : NaN;
        const db = b.date_taken ? new Date(b.date_taken).getTime() : NaN;
        // Non-null first
        const aNull = isNaN(da);
        const bNull = isNaN(db);
        if (aNull && !bNull) return 1;
        if (!aNull && bNull) return -1;
        if (aNull && bNull) return 0;
        return (sortOrder === 'asc') ? (da - db) : (db - da);
      });
    }
    const el = document.getElementById('gallery');
    el.innerHTML = '';
    
    allImages = items;
    
    if (items.length === 0) {
      el.innerHTML = '<p style="padding: 16px; color: #aaa;">No images</p>';
      return;
    }
    
    for (const it of items) {
      const card = document.createElement('div');
      card.className = 'card';
      
      const img = document.createElement('img');
      img.src = `/uploads/thumbs/${it.filename}`;
      img.alt = it.title || it.filename;
      img.onclick = () => openModal(items.indexOf(it), it.title || it.filename);
      img.onerror = () => { img.src = `/uploads/${it.filename}`; };
      card.appendChild(img);
      
      const meta = document.createElement('div');
      meta.className = 'meta';
      const title = document.createElement('div');
      title.style.marginBottom = '4px';
      title.textContent = it.title || it.filename;
      meta.appendChild(title);
      
      if (it.date_taken) {
        const dateTaken = document.createElement('div');
        dateTaken.className = 'date-taken';
        dateTaken.innerHTML = '<i class="fa-regular fa-calendar"></i> ' + new Date(it.date_taken).toLocaleDateString();
        meta.appendChild(dateTaken);
      }
      
      const metaBar = document.createElement('div');
      metaBar.className = 'meta-bar';
      
      // Like button
      const likeBtn = document.createElement('button');
      likeBtn.className = 'like-btn';
      likeBtn.innerHTML = `<i class="fa-regular fa-heart"></i> <span class="like-count">${it.like_count || 0}</span>`;
      likeBtn.style.opacity = it.user_liked ? '1' : '0.5';
      likeBtn.onclick = (e) => { e.stopPropagation(); toggleLike(it.id, likeBtn); };
      metaBar.appendChild(likeBtn);

      // Comment count display
      const commentCount = document.createElement('div');
      commentCount.className = 'comment-count';
      commentCount.innerHTML = `<i class="fa-solid fa-comments"></i> <span>${it.comment_count || 0}</span>`;
      metaBar.appendChild(commentCount);
      
      meta.appendChild(metaBar);
      
      if (isAuthenticated) {
        const isAdmin = currentUser?.admin === true;
        const isOwner = it.user_id && currentUser?.id && it.user_id === currentUser.id;
        const canEdit = isAdmin || isOwner;
        
        if (canEdit) {
          const actions = document.createElement('div');
          actions.className = 'meta-actions';
          const editBtn = document.createElement('button');
          editBtn.className = 'edit-btn';
          editBtn.textContent = 'Edit';
          editBtn.onclick = (e) => { e.stopPropagation(); editImage(it); };
          const delBtn = document.createElement('button');
          delBtn.className = 'delete-btn';
          delBtn.textContent = 'Delete';
          delBtn.onclick = (e) => { e.stopPropagation(); deleteImage(it.id); };
          actions.appendChild(editBtn);
          actions.appendChild(delBtn);
          meta.appendChild(actions);
        }
      }
      
      card.appendChild(meta);
      el.appendChild(card);
    }
  } catch (e) {
    console.error('Error fetching images:', e);
    document.getElementById('gallery').innerHTML = '<p style="padding: 16px; color: #aaa;">Error loading images</p>';
  }
}

function openModal(indexOrSrc, caption) {
  const modal = document.getElementById('modal');
  const modalImg = document.getElementById('modalImg');
  const modalCaption = document.getElementById('modalCaption');
  
  // Support both old (src) and new (index) signatures for backward compatibility
  if (typeof indexOrSrc === 'number') {
    currentImageIndex = indexOrSrc;
    const image = allImages[currentImageIndex];
    modalImg.src = `/uploads/${image.filename}`;
    modalCaption.textContent = image.title || image.filename;
    modalImg.dataset.imageId = image.id;
    prefillCommentAuthor();
    setCommentButtonState(!!image.comment_count);
    loadComments(image.id);
  } else {
    modalImg.src = indexOrSrc;
    modalCaption.textContent = caption;
    currentImageIndex = -1; // No index tracking for direct src
    delete modalImg.dataset.imageId;
    document.getElementById('commentsList').innerHTML = '';
    setCommentButtonState(false);
  }
  
  modal.classList.add('show');
}

function prevImage() {
  if (currentImageIndex > 0) {
    currentImageIndex--;
    const image = allImages[currentImageIndex];
    document.getElementById('modalImg').src = `/uploads/${image.filename}`;
    document.getElementById('modalCaption').textContent = image.title || image.filename;
  }
}

function nextImage() {
  if (currentImageIndex < allImages.length - 1) {
    currentImageIndex++;
    const image = allImages[currentImageIndex];
    document.getElementById('modalImg').src = `/uploads/${image.filename}`;
    document.getElementById('modalCaption').textContent = image.title || image.filename;
  }
}

function closeModal() {
  document.getElementById('modal').classList.remove('show');
  document.getElementById('commentsOverlay').classList.remove('show');
}

// ============ COMMENTS ============
function toggleCommentsPanel() {
  const overlay = document.getElementById('commentsOverlay');
  overlay.classList.toggle('show');
}

function prefillCommentAuthor() {
  const input = document.getElementById('commentAuthor');
  if (!input) return;
  const localId = currentUser?.email ? currentUser.email.split('@')[0] : '';
  if (localId) {
    // Only override if empty or previously auto-filled
    if (!input.value || commentAuthorAutoFilled) {
      input.value = localId;
      commentAuthorAutoFilled = true;
    }
  } else if (commentAuthorAutoFilled) {
    input.value = '';
    commentAuthorAutoFilled = false;
  }
}

function setCommentButtonState(hasComments) {
  const btn = document.getElementById('toggleCommentsBtn');
  if (!btn) return;
  btn.classList.toggle('has-comments', !!hasComments);
}

async function loadComments(imageId) {
  try {
    const res = await fetch(`/api/images/${imageId}/comments`);
    const comments = await res.json();
    const list = document.getElementById('commentsList');
    
    if (!comments || comments.length === 0) {
      list.innerHTML = '<p style="color: #999; font-size: 12px;">No comments yet</p>';
      setCommentButtonState(false);
      return;
    }
    setCommentButtonState(comments.length > 0);
    
    list.innerHTML = comments.map(c => {
      const emailLocal = c.email ? c.email.split('@')[0] : '';
      const author = emailLocal || c.author_name || 'Anonymous';
      const date = new Date(c.created_at).toLocaleDateString();
      const canDelete = isAuthenticated && (currentUser?.admin || currentUser?.id === c.user_id);
      return `
        <div class="comment-item">
          ${canDelete ? `
            <button class="comment-menu" onclick="toggleCommentDelete(this)" title="More">...</button>
            <button class="comment-delete" onclick="deleteComment(${c.id})" title="Delete">✕</button>
          ` : ''}
          <div class="comment-author">${author}</div>
          <div class="comment-time">${date}</div>
          <div class="comment-text">${escapeHtml(c.text)}</div>
        </div>
      `;
    }).join('');
  } catch (e) {
    console.error('Error loading comments:', e);
    setCommentButtonState(false);
  }
}

async function postComment(e) {
  e.preventDefault();
  const imageId = document.getElementById('modalImg').dataset.imageId;
  if (!imageId) return;
  
  const text = document.getElementById('commentText').value.trim();
  const author_name = document.getElementById('commentAuthor').value.trim();
  
  if (!text) return;
  
  try {
    const res = await fetch(`/api/images/${imageId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ text, author_name: !isAuthenticated ? author_name : undefined })
    });
    
    if (res.ok) {
      document.getElementById('commentForm').reset();
      prefillCommentAuthor();
      await loadComments(imageId);
    } else {
      alert('Failed to post comment');
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

async function deleteComment(commentId) {
  if (!confirm('Delete this comment?')) return;
  
  try {
    const imageId = document.getElementById('modalImg').dataset.imageId;
    const res = await fetch(`/api/comments/${commentId}`, {
      method: 'DELETE',
      credentials: 'include'
    });
    
    if (res.ok) {
      await loadComments(imageId);
    } else {
      alert('Failed to delete comment');
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

function toggleCommentDelete(btn) {
  const item = btn.closest('.comment-item');
  if (item) {
    item.classList.toggle('show-delete');
  }
}

function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return text.replace(/[&<>"']/g, m => map[m]);
}

document.querySelector('.modal-close').onclick = closeModal;
document.getElementById('modal').onclick = (e) => {
  if (e.target.id === 'modal') closeModal();
};
document.getElementById('toggleCommentsBtn')?.addEventListener('click', toggleCommentsPanel);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});
document.getElementById('commentForm').addEventListener('submit', postComment);

async function uploadImage(e) {
  e.preventDefault();
  const form = document.getElementById('uploadForm');
  const data = new FormData(form);
  const status = document.getElementById('uploadStatus');
  status.textContent = 'Uploading...';
  try {
    const res = await fetch('/api/images', { method: 'POST', body: data });
    if (!res.ok) throw new Error('Upload failed');
    status.textContent = 'Uploaded!';
    form.reset();
    await fetchImages();
    setTimeout(() => closeUploadModal(), 1000);
  } catch (err) {
    status.textContent = 'Error: ' + err.message;
  }
}

async function deleteImage(id) {
  if (!confirm('Delete this image?')) return;
  try {
    const res = await fetch(`/api/images/${id}`, { method: 'DELETE', credentials: 'include' });
    if (res.ok) {
      await fetchImages();
    } else {
      alert('Delete failed');
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

async function editImage(item) {
  const newTitle = prompt('Edit title:', item.title || item.filename);
  if (newTitle === null) return;
  try {
    const res = await fetch(`/api/images/${item.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ title: newTitle })
    });
    if (res.ok) {
      await fetchImages();
    } else {
      alert('Edit failed');
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

function openLoginModal() {
  document.getElementById('loginModal').classList.add('show');
}

function closeLoginModal() {
  document.getElementById('loginModal').classList.remove('show');
  document.getElementById('loginError').textContent = '';
}

function openSignupModal() {
  document.getElementById('signupModal').classList.add('show');
}

function closeSignupModal() {
  document.getElementById('signupModal').classList.remove('show');
  document.getElementById('signupError').textContent = '';
  document.getElementById('signupForm').reset();
}

function openCreateAlbumModal() {
  document.getElementById('createAlbumModal').classList.add('show');
}

function closeCreateAlbumModal() {
  document.getElementById('createAlbumModal').classList.remove('show');
  document.getElementById('albumError').textContent = '';
  document.getElementById('albumName').value = '';
  const publicBox = document.getElementById('albumPublic');
  if (publicBox) publicBox.checked = true;
}

function openUserDashboard() {
  if (!isAuthenticated) return;
  
  document.getElementById('userDashboardModal').classList.add('show');
  loadUserStats();
}

function closeUserDashboard() {
  document.getElementById('userDashboardModal').classList.remove('show');
}

async function loadUserStats() {
  try {
    const res = await fetch('/api/user/stats', { credentials: 'include' });
    if (res.ok) {
      const data = await res.json();
      document.getElementById('userEmail').textContent = data.email || '-';
      document.getElementById('userImageCount').textContent = data.imageCount || 0;
      document.getElementById('userLikesCount').textContent = data.likesCount || 0;
      document.getElementById('userCommentsCount').textContent = data.commentsCount || 0;
    }
  } catch (e) {
    console.error('Error loading user stats:', e);
  }
}

async function deleteMyAccount() {
  if (!confirm('Are you sure you want to delete your account? This action cannot be undone and will delete all your images, comments, and likes.')) return;
  if (!confirm('This is your final warning. Delete account permanently?')) return;
  
  try {
    const res = await fetch('/api/user/me', {
      method: 'DELETE',
      credentials: 'include'
    });
    
    if (res.ok) {
      alert('Account deleted successfully');
      closeUserDashboard();
      isAuthenticated = false;
      currentUser = null;
      updateAuthUI();
      await fetchImages();
    } else {
      const data = await res.json().catch(() => ({}));
      alert('Delete failed: ' + (data.error || 'Unknown error'));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

async function createAlbum(e) {
  e.preventDefault();
  const name = document.getElementById('albumName').value.trim();
  const isPublic = document.getElementById('albumPublic')?.checked ?? true;
  if (!name) return;
  try {
    const res = await fetch('/api/albums', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name, is_public: isPublic })
    });
    if (res.ok) {
      closeCreateAlbumModal();
      await fetchAlbums();
    } else {
      document.getElementById('albumError').textContent = 'Create failed';
    }
  } catch (e) {
    document.getElementById('albumError').textContent = 'Error: ' + e.message;
  }
}

async function login(e) {
  e.preventDefault();
  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username, password })
    });
    if (res.ok) {
      await checkAuth();
      closeLoginModal();
      await fetchImages();
    } else {
      document.getElementById('loginError').textContent = 'Invalid credentials';
    }
  } catch (e) {
    document.getElementById('loginError').textContent = 'Login error';
  }
}

async function signup(e) {
  e.preventDefault();
  const email = document.getElementById('signupEmail').value.trim();
  const password = document.getElementById('signupPassword').value;
  const password2 = document.getElementById('signupPassword2').value;
  const err = document.getElementById('signupError');
  err.textContent = '';
  if (password !== password2) {
    err.textContent = 'Passwords do not match';
    return;
  }
  try {
    const res = await fetch('/api/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email, password })
    });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      closeSignupModal();
      closeLoginModal();
      if (data.pendingApproval) {
        alert('Account created successfully!\n\nYour account is pending admin approval. You will be able to log in once approved.');
      } else {
        await checkAuth();
        await fetchImages();
      }
    } else {
      const data = await res.json().catch(() => ({}));
      err.textContent = data.error || 'Signup failed';
    }
  } catch (e) {
    err.textContent = 'Signup error';
  }
}

async function logout() {
  try {
    await fetch('/api/logout', { method: 'POST', credentials: 'include' });
    isAuthenticated = false;
    updateAuthUI();
    await fetchImages();
  } catch (e) {
    alert('Logout error');
  }
}

async function toggleLike(imageId, likeBtn) {
  // Verify authentication before attempting like
  const authRes = await fetch('/api/me', { credentials: 'include' });
  const authData = await authRes.json();
  
  if (!authData.authenticated) {
    openLoginModal();
    return;
  }
  
  try {
    const isLiked = likeBtn.style.opacity === '1';
    const method = isLiked ? 'DELETE' : 'POST';
    const res = await fetch(`/api/images/${imageId}/like`, {
      method,
      credentials: 'include'
    });
    
    if (res.ok) {
      const countEl = likeBtn.querySelector('.like-count');
      let count = parseInt(countEl.textContent);
      if (isLiked) {
        count--;
        likeBtn.style.opacity = '0.5';
      } else {
        count++;
        likeBtn.style.opacity = '1';
      }
      countEl.textContent = count;
    } else if (res.status === 401) {
      alert('Please log in to like images');
      await checkAuth();
      openLoginModal();
    } else {
      const errData = await res.json().catch(() => ({}));
      alert('Error: ' + (errData.error || 'Like action failed'));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

document.getElementById('loginBtn').onclick = openLoginModal;
document.getElementById('logoutBtn').onclick = logout;
document.getElementById('loginForm').addEventListener('submit', login);
document.getElementById('signupForm')?.addEventListener('submit', signup);
document.getElementById('createAlbumBtn').onclick = openCreateAlbumModal;
document.getElementById('createAlbumForm').addEventListener('submit', createAlbum);
document.getElementById('uploadForm').addEventListener('submit', uploadImage);
document.getElementById('toggleMetaBtn').onclick = toggleMeta;
document.getElementById('toggleUploadBtn')?.addEventListener('click', openUploadModal);
const sortSelectEl = document.getElementById('sortSelect');
if (sortSelectEl) {
  const setSortFromValue = (v) => {
    if (v === 'created_desc') { sortKey = 'created_at'; sortOrder = 'desc'; }
    else if (v === 'created_asc') { sortKey = 'created_at'; sortOrder = 'asc'; }
    else if (v === 'taken_desc') { sortKey = 'date_taken'; sortOrder = 'desc'; }
    else if (v === 'taken_asc') { sortKey = 'date_taken'; sortOrder = 'asc'; }
    else if (v === 'title_asc') { sortKey = 'title'; sortOrder = 'asc'; }
    else if (v === 'title_desc') { sortKey = 'title'; sortOrder = 'desc'; }
    else if (v === 'likes_desc') { sortKey = 'like_count'; sortOrder = 'desc'; }
    else if (v === 'likes_asc') { sortKey = 'like_count'; sortOrder = 'asc'; }
    else { sortKey = 'created_at'; sortOrder = 'desc'; }
  };
  const initial = localStorage.getItem('gallery_sort') || 'created_desc';
  setSortFromValue(initial);
  sortSelectEl.value = initial;
  sortSelectEl.addEventListener('change', () => {
    const v = sortSelectEl.value;
    setSortFromValue(v);
    localStorage.setItem('gallery_sort', v);
    fetchImages();
  });
}

// Gallery size buttons
const savedSize = localStorage.getItem('gallery_size');
const validSizes = new Set(['small', 'medium', 'large']);
if (savedSize && validSizes.has(savedSize)) {
  applyGallerySize(savedSize);
} else {
  applyGallerySize('medium');
}

document.querySelectorAll('.size-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const size = btn.dataset.size;
    if (validSizes.has(size)) {
      applyGallerySize(size);
    }
  });
});

async function openDashboard() {
  try {
    const res = await fetch('/api/admin/stats', { credentials: 'include' });
    if (!res.ok) {
      alert('Access denied');
      return;
    }
    const data = await res.json();
    
    // Update stats
    document.getElementById('statUsers').textContent = data.stats.users;
    document.getElementById('statImages').textContent = data.stats.images;
    document.getElementById('statAlbums').textContent = data.stats.albums;
    document.getElementById('statLikes').textContent = data.stats.likes;
    
    // Recent images
    const recentList = document.getElementById('recentImagesList');
    recentList.innerHTML = data.recentImages.map(img => `
      <div class="dashboard-item">
        <img src="/uploads/${img.filename}" alt="${img.title || img.filename}">
        <div>
          <div>${img.title || img.filename}</div>
          <div class="item-meta">${new Date(img.created_at).toLocaleString()}</div>
        </div>
      </div>
    `).join('');
    
    // Users list
    const usersList = document.getElementById('usersList');
    const canDeleteUsers = (data.users && data.users.length > 1);
    usersList.innerHTML = `
      <table class="dashboard-table">
        <thead>
          <tr><th>ID</th><th>Email</th><th>Created</th><th>Actions</th></tr>
        </thead>
        <tbody>
          ${data.users.map(u => `
            <tr>
              <td>${u.id}</td>
              <td>${u.email}</td>
              <td>${new Date(u.created_at).toLocaleString()}</td>
              <td><button class="delete-user-btn" ${canDeleteUsers ? '' : 'disabled title="Cannot delete the last user"'} onclick="deleteUser(${u.id})">Delete</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
    
    // Pending users
    const pendingRes = await fetch('/api/admin/pending-users', { credentials: 'include' });
    if (pendingRes.ok) {
      const pendingData = await pendingRes.json();
      const pendingList = document.getElementById('pendingUsersList');
      if (pendingData.users.length === 0) {
        pendingList.innerHTML = '<p class="no-pending">No pending approvals</p>';
      } else {
        pendingList.innerHTML = `
          <table class="dashboard-table">
            <thead>
              <tr><th>ID</th><th>Email</th><th>Requested</th><th>Actions</th></tr>
            </thead>
            <tbody>
              ${pendingData.users.map(u => `
                <tr>
                  <td>${u.id}</td>
                  <td>${u.email}</td>
                  <td>${new Date(u.created_at).toLocaleString()}</td>
                  <td>
                    <button class="approve-user-btn" onclick="approveUser(${u.id})">Approve</button>
                    <button class="reject-user-btn" onclick="rejectUser(${u.id})">Reject</button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `;
      }
    }
    
    // Albums management
    const albumsRes = await fetch('/api/albums');
    const albums = await albumsRes.json();
    const albumsManagement = document.getElementById('albumsManagement');
    albumsManagement.innerHTML = `
      <table class="dashboard-table">
        <thead>
          <tr><th>ID</th><th>Name</th><th>Created</th><th>Actions</th></tr>
        </thead>
        <tbody>
          ${albums.map(a => `
            <tr>
              <td>${a.id}</td>
              <td>${a.name}</td>
              <td>${new Date(a.created_at).toLocaleString()}</td>
              <td>
                <button class="edit-album-btn" onclick="editAlbum(${a.id}, '${a.name.replace(/'/g, "\\'")}')">Edit</button>
                <button class="delete-album-btn" onclick="deleteAlbum(${a.id})">Delete</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
    
    // Comments management
    const commentsRes = await fetch('/api/comments/all', { credentials: 'include' });
    if (commentsRes.ok) {
      const commentsData = await commentsRes.json();
      const commentsManagement = document.getElementById('commentsManagement');
      if (commentsData.comments && commentsData.comments.length > 0) {
        commentsManagement.innerHTML = `
          <table class="dashboard-table">
            <thead>
              <tr><th>ID</th><th>Author</th><th>Comment</th><th>Image</th><th>Created</th><th>Actions</th></tr>
            </thead>
            <tbody>
              ${commentsData.comments.map(c => `
                <tr>
                  <td>${c.id}</td>
                  <td>${c.author_name || 'Unknown'}</td>
                  <td style="max-width: 300px; overflow: hidden; text-overflow: ellipsis;">${c.text}</td>
                  <td>${c.image_title || `Image #${c.image_id}`}</td>
                  <td>${new Date(c.created_at).toLocaleString()}</td>
                  <td>
                    <button class="delete-comment-btn" onclick="deleteCommentAdmin(${c.id})">Delete</button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `;
      } else {
        commentsManagement.innerHTML = '<p class="no-pending">No comments yet</p>';
      }
    }
    
    // Show dashboard, hide gallery
    document.getElementById('adminDashboard').style.display = 'block';
    document.querySelector('.albums-bar').style.display = 'none';
    document.querySelector('.gallery').style.display = 'none';
  } catch (e) {
    alert('Error loading dashboard: ' + e.message);
  }
}

function closeDashboard() {
  document.getElementById('adminDashboard').style.display = 'none';
  document.querySelector('.albums-bar').style.display = 'flex';
  document.querySelector('.gallery').style.display = 'grid';
}

async function deleteUser(userId) {
  if (!confirm('Delete this user? This cannot be undone.')) return;
  try {
    const res = await fetch(`/api/admin/users/${userId}`, { method: 'DELETE', credentials: 'include' });
    if (res.ok) {
      // Refresh dashboard data
      await openDashboard();
    } else {
      const err = await res.json().catch(() => ({}));
      alert('Delete failed: ' + (err.error || res.statusText));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

async function approveUser(userId) {
  try {
    const res = await fetch('/api/admin/approve-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ userId })
    });
    if (res.ok) {
      await openDashboard();
    } else {
      const err = await res.json();
      alert('Approval failed: ' + (err.error || res.statusText));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

async function rejectUser(userId) {
  if (!confirm('Permanently delete this user account?')) return;
  try {
    const res = await fetch('/api/admin/reject-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ userId })
    });
    if (res.ok) {
      await openDashboard();
    } else {
      const err = await res.json();
      alert('Rejection failed: ' + (err.error || res.statusText));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

async function deleteCommentAdmin(commentId) {
  if (!confirm('Delete this comment? This cannot be undone.')) return;
  try {
    const res = await fetch(`/api/comments/${commentId}`, {
      method: 'DELETE',
      credentials: 'include'
    });
    if (res.ok) {
      await openDashboard();
    } else {
      const err = await res.json();
      alert('Delete failed: ' + (err.error || res.statusText));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

async function editAlbum(albumId, currentName) {
  const newName = prompt('Enter new album name:', currentName);
  if (newName === null || newName.trim() === '') return;
  
  try {
    const res = await fetch(`/api/albums/${albumId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name: newName.trim() })
    });
    if (res.ok) {
      await openDashboard();
      await fetchAlbums();
    } else {
      const err = await res.json().catch(() => ({}));
      alert('Edit failed: ' + (err.error || res.statusText));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

async function deleteAlbum(albumId) {
  if (!confirm('Delete this album? Images will not be deleted.')) return;
  
  try {
    const res = await fetch(`/api/albums/${albumId}`, {
      method: 'DELETE',
      credentials: 'include'
    });
    if (res.ok) {
      await openDashboard();
      await fetchAlbums();
    } else {
      const err = await res.json().catch(() => ({}));
      alert('Delete failed: ' + (err.error || res.statusText));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

checkAuth();
fetchImages();
updateMetaToggleUI();
