const loginSection = document.getElementById('loginSection');
const portalSection = document.getElementById('portalSection');
const loginForm = document.getElementById('portalLoginForm');
const phoneInput = document.getElementById('phoneInput');
const loginError = document.getElementById('loginError');
const filesList = document.getElementById('filesList');
const welcomeName = document.getElementById('welcomeName');
const logoutBtn = document.getElementById('logoutBtn');
const darkToggle = document.getElementById('darkToggle');

// Dark Mode
const isDark = localStorage.getItem('planixa_dark') === 'true';
if (isDark) document.body.classList.add('dark-mode');
darkToggle.addEventListener('click', () => {
  document.body.classList.toggle('dark-mode');
  localStorage.setItem('planixa_dark', document.body.classList.contains('dark-mode'));
});

// Auth Flow
let userPhone = localStorage.getItem('portal_phone');

function checkAuth() {
  if (userPhone) {
    loginSection.style.display = 'none';
    portalSection.style.display = 'block';
    loadFiles(userPhone);
  } else {
    loginSection.style.display = 'block';
    portalSection.style.display = 'none';
  }
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const phone = phoneInput.value.trim();
  if (!phone) return;
  
  try {
    const res = await fetch('/api/portal/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone })
    });
    
    if (res.ok) {
      const data = await res.json();
      userPhone = phone;
      localStorage.setItem('portal_phone', phone);
      checkAuth();
    } else {
      loginError.style.display = 'block';
    }
  } catch (err) {
    loginError.textContent = 'Error de conexión. Intenta de nuevo.';
    loginError.style.display = 'block';
  }
});

logoutBtn.addEventListener('click', () => {
  userPhone = null;
  localStorage.removeItem('portal_phone');
  checkAuth();
});

async function loadFiles(phone) {
  filesList.innerHTML = '<p style="text-align:center; color:var(--text-light);">Cargando documentos...</p>';
  try {
    const res = await fetch('/api/portal/files?phone=' + phone);
    if (!res.ok) throw new Error();
    const data = await res.json();
    
    if (data.name) welcomeName.textContent = `¡Hola, Profe ${data.name.split(' ')[0]}!`;
    
    if (!data.files || data.files.length === 0) {
      filesList.innerHTML = '<p style="text-align:center; color:var(--text-light);">Aún no tienes planificaciones generadas.</p>';
      return;
    }
    
    filesList.innerHTML = '';
    data.files.forEach(f => {
      const div = document.createElement('div');
      div.className = 'file-card';
      const dateStr = new Date(f.date).toLocaleDateString();
      div.innerHTML = `
        <div>
          <h3 style="margin:0 0 5px 0;">${f.title || 'Planificación Docente'}</h3>
          <p style="color:var(--text-light); font-size:12px; margin:0;">Generado el ${dateStr} - Vía WhatsApp</p>
        </div>
        <div style="display:flex; gap:10px;">
          <a href="/api/portal/download?id=${f.id}&type=pdf&phone=${phone}" target="_blank" class="btn-download" style="background:var(--accent);">PDF</a>
          <a href="/api/portal/download?id=${f.id}&type=docx&phone=${phone}" target="_blank" class="btn-download" style="background:#2563eb;">Word</a>
        </div>
      `;
      filesList.appendChild(div);
    });
  } catch (err) {
    filesList.innerHTML = '<p style="text-align:center; color:red;">Error cargando el historial.</p>';
  }
}

checkAuth();
