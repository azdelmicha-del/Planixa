let token = localStorage.getItem('planif_token');
let userId = localStorage.getItem('planif_userId');
let currentConversationId = null;
let isSending = false;
let editingMsgIndex = -1;
var panelCache = new Set();

const $ = id => document.getElementById(id);
const WELCOME_HTML = $('welcomeMsg')?.outerHTML || '';
function on(id, event, fn) {
  const el = $(id);
  if (el) { el.addEventListener(event, fn); return; }
  document.addEventListener(event, function(e) {
    const target = e.target.closest('#' + id);
    if (target) fn.call(target, e);
  });
}
const api = async (method, url, body) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  if (r.status === 401 && url !== '/api/login') {
      localStorage.removeItem('planif_token');
      localStorage.removeItem('planif_userId');
      token = null; userId = null;
      $('appLayout').style.display = 'none';
      $('authOverlay').style.display = 'flex';
      showToast('Sesión expirada. Por favor inicia sesión de nuevo.', 'error');
      return { success: false, error: 'Sesión expirada' };
  }
  return r.json();
};

function showToast(msg, type) {
  const t = $('toast');
  t.textContent = msg; t.className = 'toast ' + type + ' show';
  setTimeout(() => t.classList.remove('show'), 3000);
}

/* ── AUTH ── */
document.querySelectorAll('.auth-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
    tab.classList.add('active');
    $(tab.dataset.tab + 'Form').classList.add('active');
    document.querySelectorAll('.auth-error').forEach(e => e.style.display = 'none');
  });
});

on("loginForm", "submit", async e => {
  e.preventDefault();
  const btn = $('loginBtn'); btn.disabled = true; btn.textContent = 'Entrando...';
  const err = $('loginError'); err.style.display = 'none';
  const res = await api('POST', '/api/login', { phone: $('loginPhone').value, password: $('loginPassword').value });
  if (res.success) {
    token = res.token; userId = res.user.id;
    localStorage.setItem('planif_token', token);
    localStorage.setItem('planif_userId', userId);
    enterApp();
  } else {
    err.textContent = res.message; err.style.display = 'block';
  }
  btn.disabled = false; btn.textContent = 'Entrar';
});

on("registerForm", "submit", async e => {
  e.preventDefault();
  const btn = $('registerBtn'); btn.disabled = true; btn.textContent = 'Registrando...';
  const err = $('registerError'); err.style.display = 'none';
  const res = await api('POST', '/api/register', {
    name: $('regName').value,
    phone: $('regPhone').value,
    password: $('regPassword').value
  });
  if (res.success) {
    showToast('Registrado correctamente. Ahora inicia sesión.', 'success');
    document.querySelectorAll('.auth-tab')[0].click();
    $('loginPhone').value = $('regPhone').value;
  } else {
    err.textContent = res.message; err.style.display = 'block';
  }
  btn.disabled = false; btn.textContent = 'Crear cuenta';
});

/* ── APP ── */
let currentUser = null;

async function loadComponents() {
  try {
    const r = await fetch('/public/components/modals.html');
    if(r.ok) document.getElementById('modals-container').innerHTML = await r.text();
  } catch(e) { console.error('Error loading components', e); }
}

async function enterApp() {
  await loadComponents();
  $('authOverlay').style.display = 'none';
  $('appLayout').style.display = 'flex';
  currentUser = await api('GET', '/api/user');
  updateSidebarUser();
  if (currentUser.is_admin) {
    if ($('adminPanelBtn')) $('adminPanelBtn').style.display = 'inline-flex';
      if ($('adminNavTab')) {
        $('adminNavTab').style.display = 'inline-block';
        if ($('supervisorNavTab')) $('supervisorNavTab').style.display = 'inline-block';
        document.querySelectorAll('.nav-tab').forEach(t => {
        const allowed = ['admin', 'supervisor'];
        if (!allowed.includes(t.dataset.tab)) t.style.display = 'none';
      });
      if ($('topNewBtn')) $('topNewBtn').style.display = 'none';
      if ($('sidebar')) $('sidebar').style.display = 'none';
      if ($('adminLogoutContainer')) $('adminLogoutContainer').style.display = 'block';
      if ($('darkToggleAdmin')) $('darkToggleAdmin').style.display = 'block';
      if ($('headerActions')) $('headerActions').style.display = 'none';
    }
    await loadPanelContent('chat-main');
    loadConversations();
    checkBoot();
    $('profLang').value = currentUser.lang || 'es';
    await switchTab('admin');
    if (typeof loadAdminUsers === 'function') loadAdminUsers();
    if ($('adminTabDash')) $('adminTabDash').click();
  } else {
    // Load chat panel first so its elements exist
    await loadPanelContent('chat-main');
    loadConversations();
    checkBoot();
    $('profLang').value = currentUser.lang || 'es';
    switchTab('chat');
  }
}

function updateSidebarUser() {
  $('sidebarUserName').textContent = currentUser.name || currentUser.phone;
  const parts = [];
  if (currentUser.grade) parts.push(currentUser.grade);
  if (currentUser.area) parts.push(currentUser.area);
  if (currentUser.school) parts.push(currentUser.school);
  $('sidebarUserMeta').textContent = parts.length ? parts.join(' · ') : 'Configura tu perfil';
}

on("profileBtn", "click", () => {
  $('profName').value = currentUser.name || '';
  $('profGrade').value = currentUser.grade || '';
  $('profArea').value = currentUser.area || '';
  $('profSchool').value = currentUser.school || '';
  $('profLang').value = currentUser.lang || 'es';
  $('profileOverlay').style.display = 'block';
});

function closeProfile() { $('profileOverlay').style.display = 'none'; }
on("profileOverlay", "click", e => { if (e.target === $('profileOverlay')) closeProfile(); });

async function saveProfile() {
  const lang = $('profLang').value;
  const res = await api('PUT', '/api/user/profile', {
    name: $('profName').value,
    grade: $('profGrade').value,
    area: $('profArea').value,
    school: $('profSchool').value
  });
  await api('PUT', '/api/user/lang', { lang });
  if (res.success) {
    currentUser.name = res.name;
    currentUser.grade = res.grade;
    currentUser.area = res.area;
    currentUser.school = res.school;
    currentUser.lang = lang;
    updateSidebarUser();
    closeProfile();
    showToast('Perfil actualizado', 'success');
    if (lang !== 'es') showToast('Idioma cambiado a ' + ({en:'English',ht:'Kreyòl'})[lang], 'success');
  } else {
    showToast('Error al guardar', 'error');
  }
}

on("adminPanelBtn", "click", () => {
  closeSidebar();
  switchTab('admin');
  if (typeof loadAdminUsers === 'function') loadAdminUsers();
});

on("logoutBtn", "click", () => {
  localStorage.removeItem('planif_token');
  localStorage.removeItem('planif_userId');
  location.reload();
});
on("logoutBtnAdmin", "click", () => {
  localStorage.removeItem('planif_token');
  localStorage.removeItem('planif_userId');
  location.reload();
});

/* ── CONVERSATIONS ── */
async function loadConversations() {
  const list = $('conversationList');
  if (!list) return;
  list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-light);font-size:13px;">Cargando...</div>';
  const res = await api('GET', '/api/conversations');
  if (!res.conversations || res.conversations.length === 0) {
    list.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-light);font-size:13px;">No tienes planificaciones guardadas</div>';
    return;
  }
  list.innerHTML = res.conversations.map(c => `
    <div class="conv-item ${c.id === currentConversationId ? 'active' : ''}" data-id="${c.id}">
      <div class="title">${escHtml(c.title)}</div>
      <div class="meta">${c.messageCount} msgs · ${timeAgo(c.createdAt)}${c.hasPdf ? ' \u{1F4C4}' : ''}</div>
      <button class="delete-btn" data-id="${c.id}" title="Eliminar">&times;</button>
    </div>
  `).join('');
  list.querySelectorAll('.conv-item').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.classList.contains('delete-btn')) return;
      loadConversation(el.dataset.id);
    });
  });
  list.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      if (!confirm('¿Eliminar esta planificación?')) return;
      await api('DELETE', '/api/conversations/' + btn.dataset.id);
      if (currentConversationId === btn.dataset.id) {
        currentConversationId = null;
        $('chatTitle').textContent = 'Nueva planificación';
        $('messagesContainer').innerHTML = WELCOME_HTML;
        $('pdfBtn').style.display = 'none';
        $('pdfEnhancedBtn').style.display = 'none';
        $('docxBtn').style.display = 'none';
        $('txtBtn').style.display = 'none';
        $('shareBtn').style.display = 'none';
      }
      loadConversations();
    });
  });
}

async function loadConversation(id) {
  currentConversationId = id;
  const res = await api('GET', '/api/conversations/' + id);
  if (!res.id) { showToast('Error cargando', 'error'); return; }
  $('chatTitle').textContent = res.title;
  $('pdfBtn').style.display = 'inline-flex';
  $('pdfEnhancedBtn').style.display = 'inline-flex';
  $('docxBtn').style.display = 'inline-flex';
  $('txtBtn').style.display = 'inline-flex';
  $('shareBtn').style.display = 'inline-flex';

  const container = $('messagesContainer');
  container.innerHTML = '';
  const msgs = res.messages || [];
  if (msgs.length === 0) {
    container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-light);">Conversación vacía</div>';
    const docEditor = $('documentEditor');
    if (docEditor) docEditor.innerHTML = '<h1 style="color:#ccc; font-weight:normal; text-align:center; margin-top:20%;">Hoja en blanco</h1><p style="color:#ccc; text-align:center;">Pide al asistente que genere tu planificación y aparecerá aquí.</p>';
  } else {
    let lastAssistantMsg = null;
    msgs.forEach((m, i) => {
      if (m.role === 'assistant') lastAssistantMsg = m.content;
      let displayMsg = m.content;
      if (m.role === 'assistant' && displayMsg.length > 250) {
        displayMsg = '✅ ¡Listo profe! He generado tu planificación. Puedes verla y editarla en el documento central a tu izquierda.';
      }
      container.appendChild(createMessageElement(m.role, displayMsg, i));
    });
    const docEditor = $('documentEditor');
    if (docEditor) {
      if (lastAssistantMsg && lastAssistantMsg.length > 250) {
        docEditor.innerHTML = '<div style="white-space: pre-wrap; font-family: inherit;">' + escHtml(lastAssistantMsg) + '</div>';
      } else {
        docEditor.innerHTML = '<h1 style="color:#ccc; font-weight:normal; text-align:center; margin-top:20%;">Hoja en blanco</h1><p style="color:#ccc; text-align:center;">Pide al asistente que genere tu planificación y aparecerá aquí.</p>';
      }
    }
  }
  container.scrollTop = container.scrollHeight;
  loadConversations();
}

/* ── NEW CONVERSATION ── */
function newConversation() {
  currentConversationId = null;
  $('chatTitle').textContent = 'Nueva planificación';
  const docEditor = $('documentEditor');
  if (docEditor) docEditor.innerHTML = '<h1 style="color:#ccc; font-weight:normal; text-align:center; margin-top:20%;">Hoja en blanco</h1><p style="color:#ccc; text-align:center;">Pide al asistente que genere tu planificación y aparecerá aquí.</p>';
  $('pdfBtn').style.display = 'none';
  $('pdfEnhancedBtn').style.display = 'none';
  $('docxBtn').style.display = 'none';
  $('txtBtn').style.display = 'none';
  $('shareBtn').style.display = 'none';
  $('versionBtn').style.display = 'none';
  const container = $('messagesContainer');
  if (!container) return;
  container.innerHTML = WELCOME_HTML;
  container.querySelectorAll('.suggestion-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $('messageInput').value = btn.dataset.msg;
      sendMessage();
    });
  });
  $('messageInput').focus();
  closeSidebar();
}

on("newConversationBtn", "click", newConversation);
on("topNewBtn", "click", newConversation);
on("exportZipBtn2", "click", exportZip);
on("importPlanBtn2", "click", () => $('importModal').style.display = 'block');
on("exportXlsxBtn", "click", async () => {
  try {
    const r = await fetch('/api/export/students/xlsx', { headers: { 'Authorization': 'Bearer ' + token } });
    if (!r.ok) { showToast('Error generando Excel', 'error'); return; }
    const blob = await r.blob(); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'estudiantes.xlsx'; a.click(); URL.revokeObjectURL(url);
    showToast('Excel descargado', 'success');
  } catch (e) { showToast('Error', 'error'); }
});

/* ── PDF REFERENCE UPLOAD ── */
on("uploadRefBtn2", "click", () => $('pdfFileInput').click());
on("pdfFileInput", "change", async e => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.type !== 'application/pdf') { showToast('Solo archivos PDF', 'error'); return; }
  if (file.size > 15 * 1024 * 1024) { showToast('Máximo 15MB', 'error'); return; }

  const btn = $('uploadRefBtn2');
  const orig = btn.innerHTML;
  btn.innerHTML = '&#128197; Procesando...'; btn.disabled = true;

  const fd = new FormData();
  fd.append('pdf', file);
  try {
    const r = await fetch('/api/references/upload', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token },
      body: fd
    });
    const res = await r.json();
    if (res.success) {
      showToast(res.message, 'success');
      loadReferences();
    } else {
      showToast(res.error || 'Error al procesar PDF', 'error');
    }
  } catch (err) {
    showToast('Error de conexión', 'error');
  }
  btn.innerHTML = orig; btn.disabled = false;
  $('pdfFileInput').value = '';
});

async function loadReferences() {
  const list = $('refList');
  if (!list) return;
  try {
    const res = await api('GET', '/api/references');
    if (!res.references || res.references.length === 0) {
      list.innerHTML = 'Sin referencias. Sube un PDF del MINERD.';
      return;
    }
    list.innerHTML = res.references.map(r =>
      '<div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid #f1f5f9;">' +
      '<span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">📄 ' + escHtml(r.name || 'PDF') + '</span>' +
      '<button class="del-ref" data-id="' + r.id + '" style="background:none;border:none;color:#dc2626;font-size:14px;cursor:pointer;" title="Eliminar">&times;</button>' +
      '</div>'
    ).join('');
    list.querySelectorAll('.del-ref').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        await api('DELETE', '/api/references/' + btn.dataset.id);
        loadReferences();
        showToast('Referencia eliminada', 'success');
      });
    });
  } catch (e) {
    list.innerHTML = 'Error cargando referencias';
  }
}

/* ── SEND MESSAGE ── */
on("sendBtn", "click", sendMessage);
on("messageInput", "keydown", e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
on("messageInput", "input", function() {
  this.style.height = 'auto'; this.style.height = Math.min(this.scrollHeight, 120) + 'px';
});

async function sendMessage() {
  const input = $('messageInput');
  const msg = input.value.trim();
  if (!msg || isSending) return;
  input.value = ''; input.style.height = 'auto';
  isSending = true; $('sendBtn').disabled = true;

  const container = $('messagesContainer');
  if (container.querySelector('.welcome-msg')) container.innerHTML = '';

  const isEdit = editingMsgIndex >= 0;

  if (isEdit) {
    container.querySelectorAll('.message.user').forEach(el => el.style.cursor = '');
    const editBtn = $('sendBtn');
    editBtn.textContent = '\u{276F}';
    try {
      await api('PUT', `/api/conversations/${currentConversationId}/messages/${editingMsgIndex}`, { content: msg });
      editingMsgIndex = -1;
      const convRes = await api('GET', '/api/conversations/' + currentConversationId);
      container.innerHTML = '';
      (convRes.messages || []).forEach((m, i) => {
        container.appendChild(createMessageElement(m.role, m.content, i));
      });
      container.scrollTop = container.scrollHeight;
    } catch (e) {
      showToast('Error al editar', 'error');
      isSending = false; $('sendBtn').disabled = false;
      return;
    }
  }

  if (!isEdit) {
    container.appendChild(createMessageElement('user', msg));
    container.scrollTop = container.scrollHeight;
  }

  const typingEl = document.createElement('div');
  typingEl.className = 'typing-indicator';
  typingEl.innerHTML = '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>';
  container.appendChild(typingEl);
  container.scrollTop = container.scrollHeight;

  try {
    const res = await api('POST', '/chat', {
      message: msg,
      conversationId: currentConversationId
    });

    typingEl.remove();

    const reply = res.response || 'Lo siento, no pude procesar tu solicitud.';
    
    let displayReply = reply;
    if (reply.length > 250) {
      const docEditor = $('documentEditor');
      if (docEditor) docEditor.innerHTML = '<div style="white-space: pre-wrap; font-family: inherit;">' + escHtml(reply) + '</div>';
      displayReply = '✅ ¡Listo profe! He generado tu planificación. Puedes verla y editarla en el documento central a tu izquierda.';
      const chatTab = document.querySelector('.nav-tab[data-tab="chat"]');
      if (chatTab && !chatTab.classList.contains('active')) chatTab.click();
    }

    container.appendChild(createMessageElement('assistant', displayReply));
    container.scrollTop = container.scrollHeight;

    if (!currentConversationId) {
      const title = msg.length > 50 ? msg.slice(0, 50) + '...' : msg;
      const convRes = await api('POST', '/api/conversations', {
        title: 'Planificación: ' + title,
        message: msg,
        reply: reply
      });
      if (convRes.id) {
        currentConversationId = convRes.id;
        $('chatTitle').textContent = 'Planificación: ' + title;
        $('pdfBtn').style.display = 'inline-flex';
        $('pdfEnhancedBtn').style.display = 'inline-flex';
        $('docxBtn').style.display = 'inline-flex';
        $('txtBtn').style.display = 'inline-flex';
        $('shareBtn').style.display = 'inline-flex';
        $('versionBtn').style.display = 'inline-flex';
        loadConversations();
      }
    } else {
      await api('POST', '/api/conversations/' + currentConversationId + '/messages', {
        message: msg,
        reply: reply
      });
      loadConversations();
    }
  } catch (e) {
    typingEl.remove();
    if (!isEdit) {
      container.appendChild(createMessageElement('assistant', 'Error de conexión. Intenta de nuevo.'));
    }
    showToast('Error de conexión', 'error');
  }
  isSending = false; $('sendBtn').disabled = false;
}

function createMessageElement(role, content, msgIndex) {
  const div = document.createElement('div');
  div.className = 'message ' + role;
  const label = role === 'user' ? 'Tú' : 'Planixa';

  const actions = role === 'assistant'
    ? '<button class="copy-msg-btn" title="Copiar respuesta" style="background:none;border:none;color:var(--text-light);font-size:12px;cursor:pointer;padding:2px 6px;border-radius:4px;transition:all 0.15s;opacity:0.5;float:right;">📋</button>'
    : '';

  div.innerHTML = '<div class="label">' + label + actions + '</div>' + escHtml(content);

  if (role === 'user' && typeof msgIndex === 'number') {
    div.style.cursor = 'pointer';
    div.title = 'Clic para editar';
    div.addEventListener('click', function(e) {
      if (e.target.closest('.copy-msg-btn')) return;
      const msgs = document.querySelectorAll('.messages-container > .message.user');
      const lastUserIdx = msgs.length - 1;
      const isLast = Array.from(msgs).indexOf(this) === lastUserIdx;
      if (!isLast) { showToast('Solo puedes editar el último mensaje', 'error'); return; }
      $('messageInput').value = content;
      $('messageInput').focus();
      editingMsgIndex = msgIndex;
      $('sendBtn').textContent = '\u270F\uFE0F';
      showToast('Edita y envía para actualizar', 'success');
    });
  }

  if (role === 'assistant') {
    const copyBtn = div.querySelector('.copy-msg-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        navigator.clipboard.writeText(content).then(() => {
          showToast('Copiado al portapapeles', 'success');
        }).catch(() => {
          const ta = document.createElement('textarea');
          ta.value = content; document.body.appendChild(ta); ta.select(); document.execCommand('copy');
          document.body.removeChild(ta);
          showToast('Copiado al portapapeles', 'success');
        });
      });
    }
  }

  return div;
}

/* ── EXPORT ── */
async function downloadExport(endpoint, ext, label) {
  if (!currentConversationId) { showToast('No hay planificación para exportar', 'error'); return; }
  const btn = ext === 'pdf' ? $('pdfBtn') : $('docxBtn');
  btn.disabled = true; btn.innerHTML = `\u23F3 ${label}...`;
  try {
    const r = await fetch('/api/conversations/' + currentConversationId + '/' + endpoint, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!r.ok) { showToast('Error generando ' + label, 'error'); return; }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'planificacion.' + ext; a.click();
    URL.revokeObjectURL(url);
    showToast(label + ' descargado', 'success');
  } catch (e) { showToast('Error generando ' + label, 'error'); }
  btn.disabled = false; btn.innerHTML = ext === 'pdf' ? '&#128196; <span>PDF</span>' : '&#128209; <span>Word</span>';
}
on("pdfBtn", "click", () => downloadExport('pdf', 'pdf', 'PDF'));
on("docxBtn", "click", () => downloadExport('docx', 'docx', 'Word'));

/* ── QUICK ACTIONS (MODAL) ── */
const genLabels = { unit: 'Unidad Didáctica', daily: 'Plan Diario', weekly: 'Plan Semanal', rubric: 'Rúbrica' };
let genType = 'unit';

document.querySelectorAll('.qa-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    genType = btn.dataset.type;
    $('genModalTitle').textContent = `\u{1F4CB} Generar ${genLabels[genType]}`;
    $('genGrade').value = currentUser?.grade || '';
    $('genArea').value = currentUser?.area || '';
    $('genTopic').value = '';
    $('generateOverlay').style.display = 'block';
    setTimeout(() => $('genTopic').focus(), 100);
  });
});

function closeGenerateModal() { $('generateOverlay').style.display = 'none'; }
on("generateOverlay", "click", e => { if (e.target === $('generateOverlay')) closeGenerateModal(); });

on("genSubmitBtn", "click", async () => {
  const grade = $('genGrade').value.trim();
  const area = $('genArea').value.trim();
  const topic = $('genTopic').value.trim();
  if (!topic) { showToast('Escribe un tema', 'error'); return; }
  closeGenerateModal();

  const params = { grade, area, topic };
  const msg = `Genera ${genType === 'unit' ? 'una' : 'un'} ${genLabels[genType]} para ${grade || 'mi clase'} de ${area || 'mi materia'}. Tema: ${topic}.`;

  $('messageInput').value = msg;
  await sendMessage();
});

/* ── DARK MODE ── */
function applyTheme(dark) {
  document.body.classList.toggle('dark', dark);
  localStorage.setItem('planif_dark', dark ? '1' : '0');
  $('darkToggle').textContent = dark ? '\u2600\uFE0F' : '\uD83C\uDF19';
}
on("darkToggle", "click", () => applyTheme(!document.body.classList.contains('dark')));
on("darkToggleAdmin", "click", () => applyTheme(!document.body.classList.contains('dark')));
if (localStorage.getItem('planif_dark') === '1') applyTheme(true);

/* ── SEARCH ── */
on("convSearch", "input", function() {
  const q = this.value.toLowerCase();
  document.querySelectorAll('.conv-item').forEach(el => {
    const title = el.querySelector('.title')?.textContent?.toLowerCase() || '';
    el.style.display = title.includes(q) ? '' : 'none';
  });
});

/* ── RENAME CONVERSATION ── */
on("chatTitle", "dblclick", async function() {
  if (!currentConversationId) return;
  const newTitle = prompt('Nuevo título:', this.textContent);
  if (!newTitle || newTitle.trim() === this.textContent) return;
  const res = await api('PUT', '/api/conversations/' + currentConversationId, { title: newTitle.trim() });
  if (res.success) {
    this.textContent = newTitle.trim();
    loadConversations();
    showToast('Renombrado', 'success');
  } else {
    showToast('Error al renombrar', 'error');
  }
});

/* ── EXPORT .TXT ── */
on("txtBtn", "click", async () => {
  if (!currentConversationId) { showToast('No hay planificación para exportar', 'error'); return; }
  const btn = $('txtBtn');
  btn.disabled = true; btn.innerHTML = '\u23F3 Texto...';
  try {
    const r = await fetch('/api/conversations/' + currentConversationId + '/txt', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!r.ok) { showToast('Error generando TXT', 'error'); return; }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'planificacion.txt'; a.click();
    URL.revokeObjectURL(url);
    showToast('Texto descargado', 'success');
  } catch (e) { showToast('Error generando TXT', 'error'); }
  btn.disabled = false; btn.innerHTML = '\u{1F4CB} <span>Texto</span>';
});

/* ── PWA ── */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

/* ── NAV TABS ── */

async function loadPanelContent(id) {
  if (panelCache.has(id)) return;
  const el = $(id);
  if (!el || el.getAttribute('data-panel') === null) return;
  const name = el.dataset.panel;
  try {
    const r = await fetch('/public/panels/' + name + '.html');
    if (!r.ok) return;
    el.innerHTML = await r.text();
    panelCache.add(id);
    if (name === 'admin' && typeof initAdminPanel === 'function') initAdminPanel();
  } catch (e) { /* panel file not available */ }
}

async function switchTab(tab) {
  document.querySelectorAll('.nav-tab').forEach(t => {
    if (t.dataset.tab === tab) {
      t.classList.add('active');
    } else {
      t.classList.remove('active');
    }
    // Remove old hardcoded styles so CSS can take over
    t.style.color = '';
    t.style.fontWeight = '';
    t.style.borderBottomColor = '';
  });
  const panels = ['chat-main', 'adminPanel', 'calendarPanel', 'templatesPanel', 'studentsPanel', 'schedulePanel', 'annualPanel', 'statsPanel', 'remindersPanel', 'customTemplatesPanel', 'journalPanel', 'competenciasPanel', 'clientsPanel', 'supervisorPanel', 'evalSchedulePanel'];
  const tabLower = tab.toLowerCase();
  for (const id of panels) {
    const el = $(id);
    if (!el) continue;
    el.style.display = '';
    el.classList.remove('active-panel');
    if (id === 'chat-main') continue;
  }
  if (tab === 'admin' || tab === 'supervisor') {
    const side = $('aiChatSidepanel'); if (side) side.style.display = 'none';
    const voiceBtn = $('voiceBtn'); if (voiceBtn) voiceBtn.style.display = 'none';
  } else {
    const side = $('aiChatSidepanel'); if (side) side.style.display = 'flex';
    const voiceBtn = $('voiceBtn'); if (voiceBtn && ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) voiceBtn.style.display = 'block';
  }

  if (tab === 'chat') {
    const el = $('chat-main');
    if (el) {
      await loadPanelContent('chat-main');
      el.classList.add('active-panel'); el.style.display = 'flex';
    }
  } else {
    const targetId = panels.find(id => id.replace('Panel', '').toLowerCase() === tabLower) || '';
    const el = $(targetId);
    if (el) {
      await loadPanelContent(targetId);
      el.classList.add('active-panel');
      el.style.display = 'flex';
    }
  }
  if (tab === 'calendar') renderCalendar();
  if (tab === 'templates') { loadTemplates(); loadReferences(); }
  if (tab === 'students') loadStudents();
  if (tab === 'schedule') loadSchedule();
  if (tab === 'annual') loadAnnualPlans();
  if (tab === 'stats') loadStats();
  if (tab === 'reminders') loadReminders();
  if (tab === 'customTemplates') loadCustomTemplates();
  if (tab === 'journal') loadJournal();
  if (tab === 'competencias') loadCompetencias();
  if (tab === 'evalSchedule') loadEvalSchedule();
}
document.querySelectorAll('.nav-tab').forEach(tab => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

/* ── CALENDAR ── */
let calYear = new Date().getFullYear();
let calMonth = new Date().getMonth() + 1;

function renderCalendar() {
  $('calTitle').textContent = new Date(calYear, calMonth - 1).toLocaleDateString('es-DO', { month: 'long', year: 'numeric' });
  const first = new Date(calYear, calMonth - 1, 1).getDay();
  const daysInMonth = new Date(calYear, calMonth, 0).getDate();
  const grid = $('calGrid');
  grid.innerHTML = '';

  api('GET', `/api/conversations/calendar?year=${calYear}&month=${calMonth}`).then(res => {
    const daysData = res.days || {};
    for (let i = 0; i < first; i++) {
      const d = document.createElement('div');
      d.style.cssText = 'padding:10px;border-radius:8px;min-height:60px;';
      grid.appendChild(d);
    }
    for (let day = 1; day <= daysInMonth; day++) {
      const d = document.createElement('div');
      const plans = daysData[day] || [];
      d.style.cssText = `padding:8px;border-radius:8px;min-height:60px;background:var(--card);border:1px solid var(--border);cursor:${plans.length ? 'pointer' : 'default'};`;
      d.innerHTML = `<div style="font-size:13px;font-weight:700;color:var(--text);">${day}</div>`;
      if (plans.length) {
        d.style.borderColor = 'var(--primary)';
        d.style.background = '#eff6ff';
        d.innerHTML += plans.slice(0, 2).map(p => `<div style="font-size:9px;color:var(--primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">📋 ${escHtml(p.title)}</div>`).join('');
        if (plans.length > 2) d.innerHTML += `<div style="font-size:9px;color:var(--text-light);">+${plans.length-2} más</div>`;
        d.addEventListener('click', () => { switchTab('chat'); });
      }
      grid.appendChild(d);
    }
  });
}
on("calPrev", "click", () => { calMonth--; if (calMonth < 1) { calMonth = 12; calYear--; } renderCalendar(); });
on("calNext", "click", () => { calMonth++; if (calMonth > 12) { calMonth = 1; calYear++; } renderCalendar(); });

/* ── TEMPLATES ── */
async function loadTemplates() {
  const list = $('templatesList');
  list.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-light);">Cargando...</div>';
  const res = await api('GET', '/api/templates');
  if (!res.templates || !res.templates.length) {
    list.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-light);">Sin plantillas disponibles</div>';
    return;
  }
  list.innerHTML = res.templates.map(t => `
    <div style="background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:16px;cursor:pointer;transition:all 0.2s;" class="tmpl-card" data-grade="${escHtml(t.grade)}" data-area="${escHtml(t.area)}" data-topic="${escHtml(t.topic)}" data-title="${escHtml(t.title)}">
      <div style="font-size:14px;font-weight:700;color:var(--text);margin-bottom:4px;">${escHtml(t.title)}</div>
      <div style="font-size:11px;color:var(--text-light);margin-bottom:8px;">${escHtml(t.description)}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <span style="background:#dbeafe;color:#1a56db;font-size:10px;padding:2px 8px;border-radius:10px;font-weight:600;">${escHtml(t.grade)}</span>
        <span style="background:#d1fae5;color:#065f46;font-size:10px;padding:2px 8px;border-radius:10px;font-weight:600;">${escHtml(t.area)}</span>
      </div>
    </div>
  `).join('');
  list.querySelectorAll('.tmpl-card').forEach(el => {
    el.addEventListener('click', () => {
      const msg = `Necesito una planificación de ${el.dataset.area} para ${el.dataset.grade}, tema: ${el.dataset.topic}`;
      switchTab('chat');
      $('messageInput').value = msg;
      sendMessage();
    });
  });
}

/* ── STUDENTS ── */
let editingStudentId = null;

async function loadStudents() {
  const list = $('studentsList');
  list.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-light);">Cargando...</div>';
  const res = await api('GET', '/api/students');
  if (!res.students || !res.students.length) {
    list.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-light);font-size:14px;">No has agregado estudiantes aún.<br>Agrega el primero para llevar asistencia y notas.</div>';
    return;
  }
  list.innerHTML = res.students.map(s => {
    const total = s.attendance?.length || 0;
    const present = s.attendance?.filter(a => a.present).length || 0;
    const grades = s.grades || [];
    const avg = grades.length ? (grades.reduce((a, g) => a + (g.score / g.maxScore * 100), 0) / grades.length).toFixed(1) : '-';
    return `<div style="background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:16px;">
      <div style="display:flex;justify-content:space-between;align-items:start;">
        <div>
          <div style="font-size:15px;font-weight:700;">${escHtml(s.name)}</div>
          <div style="font-size:11px;color:var(--text-light);">${s.grade || ''} ${s.section ? '· ' + s.section : ''}</div>
        </div>
        <div>
          <button class="stud-report" data-id="${s.id}" style="background:none;border:none;color:#7c3aed;font-size:12px;cursor:pointer;" title="Boletín PDF">📄</button>
          ${s.parentPhone ? `<button class="stud-notify" data-id="${s.id}" data-name="${escHtml(s.name)}" data-phone="${escHtml(s.parentPhone)}" style="background:none;border:none;color:#d97706;font-size:12px;cursor:pointer;" title="Notificar padre">📱</button>` : ''}
          <button class="stud-calc" data-id="${s.id}" style="background:none;border:none;color:var(--accent);font-size:12px;cursor:pointer;" title="Calculadora de promedios">🧮</button>
          <button class="stud-edit" data-id="${s.id}" style="background:none;border:none;color:var(--primary);font-size:12px;cursor:pointer;font-weight:600;">✏️</button>
          <button class="stud-del" data-id="${s.id}" data-name="${escHtml(s.name)}" style="background:none;border:none;color:#dc2626;font-size:12px;cursor:pointer;font-weight:600;">🗑️</button>
        </div>
      </div>
      <div style="display:flex;gap:16px;margin-top:10px;font-size:12px;color:var(--text-light);">
        <span>📋 Asistencia: ${present}/${total}</span>
        <span>📊 Promedio: ${avg}${avg !== '-' ? '%' : ''}</span>
      </div>
      ${s.parentPhone ? `<div style="font-size:11px;color:var(--text-light);margin-top:4px;">📞 ${escHtml(s.parentPhone)}</div>` : ''}
    </div>`;
  }).join('');
  list.querySelectorAll('.stud-report').forEach(btn => {
    btn.addEventListener('click', async () => {
      const r = await fetch('/api/students/' + btn.dataset.id + '/report-card', { headers: { 'Authorization': 'Bearer ' + token } });
      if (r.ok) { const blob = await r.blob(); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'boletin.pdf'; a.click(); URL.revokeObjectURL(url); showToast('Boletín descargado', 'success'); }
      else { showToast('Error generando boletín', 'error'); }
    });
  });
  list.querySelectorAll('.stud-notify').forEach(btn => {
    btn.addEventListener('click', async () => {
      const msg = prompt('Mensaje para el padre de ' + btn.dataset.name + ' (' + btn.dataset.phone + '):', 'Saludos, le informamos sobre el progreso académico de su hijo/a.');
      if (!msg) return;
      const res = await api('POST', '/api/notify-parent', { studentId: btn.dataset.id, message: msg });
      showToast(res.sent ? 'Mensaje enviado' : (res.message || 'Simulado (sin WA configurado)'), res.sent ? 'success' : 'error');
    });
  });
  list.querySelectorAll('.stud-calc').forEach(btn => {
    btn.addEventListener('click', () => openCalcModal(btn.dataset.id));
  });
  list.querySelectorAll('.stud-edit').forEach(btn => {
    btn.addEventListener('click', () => openStudentModal(btn.dataset.id));
  });
  list.querySelectorAll('.stud-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`¿Eliminar a ${btn.dataset.name}?`)) return;
      await api('DELETE', '/api/students/' + btn.dataset.id);
      loadStudents();
      showToast('Estudiante eliminado', 'success');
    });
  });
}

function openStudentModal(id) {
  editingStudentId = id || null;
  $('studentModalTitle').textContent = id ? '✏️ Editar estudiante' : '👨‍🎓 Nuevo estudiante';
  $('sName').value = ''; $('sGrade').value = ''; $('sSection').value = ''; $('sParent').value = ''; $('sNotes').value = '';
  if (id) {
    api('GET', '/api/students').then(res => {
      const s = res.students?.find(st => st.id === id);
      if (s) { $('sName').value = s.name; $('sGrade').value = s.grade || ''; $('sSection').value = s.section || ''; $('sParent').value = s.parentPhone || ''; $('sNotes').value = s.notes || ''; }
    });
  }
  $('studentModal').style.display = 'block';
}
function closeStudentModal() { $('studentModal').style.display = 'none'; editingStudentId = null; }
on("studentModal", "click", e => { if (e.target === $('studentModal')) closeStudentModal(); });
on("addStudentBtn", "click", () => openStudentModal(null));
on("saveStudentBtn", "click", async () => {
  const name = $('sName').value.trim();
  if (!name) { showToast('Nombre requerido', 'error'); return; }
  const body = { name, grade: $('sGrade').value.trim(), section: $('sSection').value.trim(), parentPhone: $('sParent').value.trim(), notes: $('sNotes').value.trim() };
  if (editingStudentId) {
    await api('PUT', '/api/students/' + editingStudentId, body);
    showToast('Estudiante actualizado', 'success');
  } else {
    await api('POST', '/api/students', body);
    showToast('Estudiante agregado', 'success');
  }
  closeStudentModal();
  loadStudents();
});

/* ── EXAM ── */
on("examBtn2", "click", () => {
  $('exGrade').value = currentUser?.grade || '';
  $('exArea').value = currentUser?.area || '';
  $('exTopic').value = ''; $('exNum').value = '10';
  $('examModal').style.display = 'block';
});
function closeExamModal() { $('examModal').style.display = 'none'; }
on("examModal", "click", e => { if (e.target === $('examModal')) closeExamModal(); });
on("generateExamBtn", "click", async () => {
  const topic = $('exTopic').value.trim();
  if (!topic) { showToast('Escribe un tema', 'error'); return; }
  closeExamModal();
  const msg = `Genera un examen de ${$('exArea').value.trim() || 'mi materia'} para ${$('exGrade').value.trim() || 'el grado'} sobre "${topic}". Tipo: ${$('exType').value}. Preguntas: ${parseInt($('exNum').value) || 10}.`;
  switchTab('chat');
  $('messageInput').value = msg;
  await sendMessage();
});

/* ── SCHEDULE ── */
let editingSchedId = null;

async function loadSchedule() {
  const body = $('scheduleBody');
  body.innerHTML = '<tr><td colspan="6" style="padding:20px;text-align:center;color:var(--text-light);">Cargando...</td></tr>';
  const res = await api('GET', '/api/schedule');
  const dayNames = {1:'Lun',2:'Mar',3:'Mié',4:'Jue',5:'Vie'};
  if (!res.schedule || !res.schedule.length) {
    body.innerHTML = '<tr><td colspan="6" style="padding:20px;text-align:center;color:var(--text-light);">Sin horario. Agrega tus clases.</td></tr>';
    return;
  }
  const byTime = {};
  res.schedule.forEach(s => {
    const key = s.startTime || '00:00';
    if (!byTime[key]) byTime[key] = {};
    byTime[key][s.day] = s;
  });
  const times = Object.keys(byTime).sort();
  body.innerHTML = times.map(t => {
    const row = byTime[t];
    const cells = [1,2,3,4,5].map(d => {
      const e = row[d];
      return e ? `<td style="padding:6px;border:1px solid var(--border);font-size:11px;background:#eff6ff;">
        <strong>${escHtml(e.subject)}</strong><br>
        <span style="color:var(--text-light);font-size:10px;">${escHtml(e.grade)} ${e.room ? '· ' + escHtml(e.room) : ''}</span>
        <button class="sched-del" data-id="${e.id}" style="display:block;background:none;border:none;color:#dc2626;font-size:10px;cursor:pointer;margin-top:2px;">×</button>
      </td>` : `<td style="padding:6px;border:1px solid var(--border);font-size:10px;color:var(--text-light);text-align:center;">—</td>`;
    }).join('');
    return `<tr><td style="padding:6px;border:1px solid var(--border);font-weight:600;font-size:11px;white-space:nowrap;">${t} - ${row[Object.keys(row)[0]]?.endTime || ''}</td>${cells}</tr>`;
  }).join('');
  body.querySelectorAll('.sched-del').forEach(btn => {
    btn.addEventListener('click', async e => { e.stopPropagation(); await api('DELETE', '/api/schedule/' + btn.dataset.id); loadSchedule(); showToast('Clase eliminada', 'success'); });
  });
}

function openSchedModal(id) {
  editingSchedId = id || null;
  $('schedModalTitle').textContent = id ? '✏️ Editar clase' : '🗓️ Nueva clase';
  $('scDay').value = '1'; $('scStart').value = ''; $('scEnd').value = ''; $('scSubject').value = ''; $('scGrade').value = ''; $('scRoom').value = '';
  if (id) {
    api('GET', '/api/schedule').then(res => {
      const s = res.schedule?.find(e => e.id === id);
      if (s) { $('scDay').value = s.day; $('scStart').value = s.startTime; $('scEnd').value = s.endTime; $('scSubject').value = s.subject; $('scGrade').value = s.grade || ''; $('scRoom').value = s.room || ''; }
    });
  }
  $('scheduleModal').style.display = 'block';
}
function closeSchedModal() { $('scheduleModal').style.display = 'none'; editingSchedId = null; }
on("scheduleModal", "click", e => { if (e.target === $('scheduleModal')) closeSchedModal(); });
on("addScheduleBtn", "click", () => openSchedModal(null));
on("saveSchedBtn", "click", async () => {
  const body = { day: parseInt($('scDay').value), startTime: $('scStart').value, endTime: $('scEnd').value, subject: $('scSubject').value.trim(), grade: $('scGrade').value.trim(), room: $('scRoom').value.trim() };
  if (!body.subject) { showToast('Materia requerida', 'error'); return; }
  if (editingSchedId) { await api('PUT', '/api/schedule/' + editingSchedId, body); } else { await api('POST', '/api/schedule', body); }
  showToast('Horario guardado', 'success'); closeSchedModal(); loadSchedule();
});

/* ── ANNUAL PLAN ── */
let editingAnnualId = null;

async function loadAnnualPlans() {
  const list = $('annualList');
  list.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-light);">Cargando...</div>';
  const res = await api('GET', '/api/annual-plan');
  if (!res.plans || !res.plans.length) {
    list.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-light);">No has creado planes anuales aún.</div>';
    return;
  }
  list.innerHTML = res.plans.map(p => `
    <div style="background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:16px;">
      <div style="display:flex;justify-content:space-between;align-items:start;">
        <div>
          <div style="font-size:14px;font-weight:700;">${escHtml(p.subject)} · ${escHtml(p.grade)}</div>
          <div style="font-size:11px;color:var(--text-light);">${escHtml(p.period)} ${p.year}</div>
        </div>
        <div>
          <button class="annual-edit" data-id="${p.id}" style="background:none;border:none;color:var(--primary);cursor:pointer;">✏️</button>
          <button class="annual-del" data-id="${p.id}" style="background:none;border:none;color:#dc2626;cursor:pointer;">🗑️</button>
        </div>
      </div>
      ${p.content ? `<div style="margin-top:8px;font-size:12px;color:var(--text);">📚 ${escHtml(p.content.slice(0, 100))}${p.content.length > 100 ? '...' : ''}</div>` : ''}
      ${p.goals ? `<div style="margin-top:4px;font-size:11px;color:var(--accent);">🎯 ${escHtml(p.goals.slice(0, 80))}</div>` : ''}
    </div>
  `).join('');
  list.querySelectorAll('.annual-edit').forEach(btn => btn.addEventListener('click', () => openAnnualModal(btn.dataset.id)));
  list.querySelectorAll('.annual-del').forEach(btn => btn.addEventListener('click', async () => { await api('DELETE', '/api/annual-plan/' + btn.dataset.id); loadAnnualPlans(); showToast('Plan eliminado', 'success'); }));
}

function openAnnualModal(id) {
  editingAnnualId = id || null;
  $('annualModalTitle').textContent = id ? '✏️ Editar Plan Anual' : '📆 Nuevo Plan Anual';
  $('apYear').value = new Date().getFullYear(); $('apPeriod').value = '1er Período'; $('apSubject').value = ''; $('apGrade').value = ''; $('apContent').value = ''; $('apGoals').value = '';
  if (id) {
    api('GET', '/api/annual-plan').then(res => {
      const p = res.plans?.find(x => x.id === id);
      if (p) { $('apYear').value = p.year; $('apPeriod').value = p.period; $('apSubject').value = p.subject; $('apGrade').value = p.grade; $('apContent').value = p.content; $('apGoals').value = p.goals; }
    });
  }
  $('annualModal').style.display = 'block';
}
function closeAnnualModal() { $('annualModal').style.display = 'none'; editingAnnualId = null; }
on("annualModal", "click", e => { if (e.target === $('annualModal')) closeAnnualModal(); });
on("addAnnualBtn", "click", () => openAnnualModal(null));
on("saveAnnualBtn", "click", async () => {
  const body = { year: parseInt($('apYear').value), period: $('apPeriod').value, subject: $('apSubject').value.trim(), grade: $('apGrade').value.trim(), content: $('apContent').value.trim(), goals: $('apGoals').value.trim() };
  if (!body.subject || !body.period) { showToast('Materia y período requeridos', 'error'); return; }
  if (editingAnnualId) { await api('PUT', '/api/annual-plan/' + editingAnnualId, body); } else { await api('POST', '/api/annual-plan', body); }
  showToast('Plan anual guardado', 'success'); closeAnnualModal(); loadAnnualPlans();
});

/* ── STATS ── */
async function loadStats() {
  const res = await api('GET', '/api/stats');
  if (!res.conversations && res.conversations !== 0) { $('statsGrid').innerHTML = '<div style="color:var(--text-light);">Error cargando estadísticas</div>'; return; }
  const cards = [
    { label: 'Planificaciones', value: res.conversations, color: '#1a56db' },
    { label: 'Este mes', value: res.thisMonth, color: '#059669' },
    { label: 'Mensajes', value: res.messages, color: '#7c3aed' },
    { label: 'Estudiantes', value: res.students, color: '#d97706' },
    { label: 'Asistencias', value: res.attendanceRecords, color: '#0891b2' },
    { label: 'Notas registradas', value: res.gradeRecords, color: '#db2777' },
    { label: 'Presentes', value: res.presentCount, color: '#059669' },
    { label: 'Referencias PDF', value: res.references, color: '#64748b' },
  ];
  $('statsGrid').innerHTML = cards.map(c => `
    <div style="background:var(--card);border-radius:var(--radius);padding:16px;border:1px solid var(--border);text-align:center;">
      <div style="font-size:28px;font-weight:700;color:${c.color};">${c.value}</div>
      <div style="font-size:11px;color:var(--text-light);margin-top:4px;">${c.label}</div>
    </div>
  `).join('');
  const convChart = $('convChart');
  convChart.innerHTML = '';
  const months = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const m = (now.getMonth() - i + 12) % 12;
    const bar = document.createElement('div');
    bar.style.cssText = 'flex:1;background:var(--primary);border-radius:4px 4px 0 0;min-height:4px;opacity:0.7;';
    bar.title = months[m];
    convChart.appendChild(bar);
    convChart.innerHTML += `<span style="font-size:8px;color:var(--text-light);text-align:center;">${months[m].slice(0,3)}</span>`;
  }
  const attendChart = $('attendChart');
  if (res.attendanceRecords > 0) {
    const pct = Math.round(res.presentCount / res.attendanceRecords * 100);
    attendChart.innerHTML = `
      <div style="flex:1;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:end;">
        <div style="width:60%;background:var(--accent);border-radius:4px 4px 0 0;height:${pct}%;transition:height 0.5s;" title="${pct}%"></div>
        <span style="font-size:10px;font-weight:700;color:var(--accent);margin-top:4px;">${pct}%</span>
        <span style="font-size:9px;color:var(--text-light);">Asistencia</span>
      </div>
      <div style="flex:1;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:end;">
        <div style="width:60%;background:#dc2626;border-radius:4px 4px 0 0;height:${100-pct}%;transition:height 0.5s;" title="${100-pct}%"></div>
        <span style="font-size:10px;font-weight:700;color:#dc2626;margin-top:4px;">${100-pct}%</span>
        <span style="font-size:9px;color:var(--text-light);">Ausencia</span>
      </div>`;
  } else {
    attendChart.innerHTML = '<div style="color:var(--text-light);font-size:12px;text-align:center;width:100%;">Sin datos</div>';
  }
}

/* ── LANGUAGE ── */
async function initLang() {
  const user = await api('GET', '/api/user');
  if (user.lang) {
    if (user.lang === 'en') {
      document.title = 'Planixa - MINERD Lesson Planner';
    }
  }
}

/* ── SHARE ── */
on("shareBtn", "click", async () => {
  if (!currentConversationId) { showToast('No hay planificación para compartir', 'error'); return; }
  const res = await api('POST', '/api/conversations/' + currentConversationId + '/share');
  if (res.success) {
    const url = window.location.origin + res.url;
    try {
      await navigator.clipboard.writeText(url);
      showToast('Enlace copiado al portapapeles', 'success');
    } catch {
      showToast('Enlace: ' + url, 'success');
    }
  } else {
    showToast('Error al compartir', 'error');
  }
});

/* ── PDF+ ── */
on("pdfEnhancedBtn", "click", async () => {
  if (!currentConversationId) { showToast('No hay planificación para exportar', 'error'); return; }
  const btn = $('pdfEnhancedBtn');
  btn.disabled = true; btn.innerHTML = '\u23F3 PDF+...';
  try {
    const r = await fetch('/api/conversations/' + currentConversationId + '/pdf-enhanced', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!r.ok) { showToast('Error generando PDF+', 'error'); return; }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'planificacion-profesional.pdf'; a.click();
    URL.revokeObjectURL(url);
    showToast('PDF+ descargado', 'success');
  } catch (e) { showToast('Error generando PDF+', 'error'); }
  btn.disabled = false; btn.innerHTML = '&#128196; <span>PDF+</span>';
});

/* ── EXPORT ZIP ── */
async function exportZip() {
  const btn = $('exportZipBtn2');
  btn.disabled = true; btn.innerHTML = '\u23F3 ZIP...';
  try {
    const r = await fetch('/api/export/zip', { headers: { 'Authorization': 'Bearer ' + token } });
    if (!r.ok) { showToast('Error generando ZIP', 'error'); return; }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'planificaciones.zip'; a.click();
    URL.revokeObjectURL(url);
    showToast('ZIP descargado', 'success');
  } catch (e) { showToast('Error generando ZIP', 'error'); }
  btn.disabled = false; btn.innerHTML = '&#128451; <span>Respaldo ZIP</span>';
}

/* ── PROJECT ── */
on("projectBtn2", "click", () => {
  switchTab('chat');
  const grade = currentUser?.grade || '';
  const area = currentUser?.area || '';
  $('messageInput').value = `Diseña un proyecto de aprendizaje basado en proyectos (ABP) para ${grade || 'mi clase'} de ${area || 'mi materia'}.`;
  sendMessage();
});

/* ── CALCULATOR ── */
let calcStudentId = null;
on("addCalcRow", "click", () => {
  const row = document.createElement('div');
  row.className = 'calc-row';
  row.style.cssText = 'display:flex;gap:8px;margin-bottom:8px;';
  row.innerHTML = '<input class="calc-name" placeholder="Evaluación" style="flex:2;padding:8px;border:1.5px solid var(--border);border-radius:6px;font-size:13px;background:var(--bg);color:var(--text);"><input class="calc-score" type="number" placeholder="Nota" style="flex:1;padding:8px;border:1.5px solid var(--border);border-radius:6px;font-size:13px;background:var(--bg);color:var(--text);"><input class="calc-max" type="number" placeholder="Máx" value="100" style="flex:1;padding:8px;border:1.5px solid var(--border);border-radius:6px;font-size:13px;background:var(--bg);color:var(--text);"><button class="calc-remove" style="background:none;border:none;color:#dc2626;font-size:18px;cursor:pointer;">×</button>';
  row.querySelector('.calc-remove').addEventListener('click', () => { row.remove(); updateCalc(); });
  row.querySelectorAll('input').forEach(inp => inp.addEventListener('input', updateCalc));
  $('calcGrades').appendChild(row);
});
on("calcGrades", "input", updateCalc);
function updateCalc() {
  const rows = $('calcGrades').querySelectorAll('.calc-row');
  let total = 0, count = 0;
  rows.forEach(r => {
    const score = parseFloat(r.querySelector('.calc-score')?.value);
    const max = parseFloat(r.querySelector('.calc-max')?.value) || 100;
    if (!isNaN(score) && max > 0) { total += (score / max) * 100; count++; }
  });
  $('calcResult').textContent = count ? `Promedio: ${(total / count).toFixed(1)}%` : 'Promedio: —';
}
on("calcFromStudent", "click", async () => {
  if (!calcStudentId) { showToast('Selecciona un estudiante primero', 'error'); return; }
  const res = await api('GET', '/api/students/' + calcStudentId + '/report');
  if (res.grades && res.grades.length) {
    $('calcGrades').innerHTML = '';
    res.grades.forEach(g => {
      const row = document.createElement('div');
      row.className = 'calc-row';
      row.style.cssText = 'display:flex;gap:8px;margin-bottom:8px;';
      row.innerHTML = `<input class="calc-name" value="${escHtml(g.name)}" style="flex:2;padding:8px;border:1.5px solid var(--border);border-radius:6px;font-size:13px;background:var(--bg);color:var(--text);"><input class="calc-score" type="number" value="${g.score}" style="flex:1;padding:8px;border:1.5px solid var(--border);border-radius:6px;font-size:13px;background:var(--bg);color:var(--text);"><input class="calc-max" type="number" value="${g.maxScore}" style="flex:1;padding:8px;border:1.5px solid var(--border);border-radius:6px;font-size:13px;background:var(--bg);color:var(--text);"><button class="calc-remove" style="background:none;border:none;color:#dc2626;font-size:18px;cursor:pointer;">×</button>`;
      row.querySelector('.calc-remove').addEventListener('click', () => { row.remove(); updateCalc(); });
      $('calcGrades').appendChild(row);
    });
    updateCalc();
    showToast('Notas cargadas', 'success');
  } else {
    showToast('Este estudiante no tiene notas aún', 'error');
  }
});
function openCalcModal(studentId) { calcStudentId = studentId || null; $('calcModal').style.display = 'block'; updateCalc(); }
function closeCalcModal() { $('calcModal').style.display = 'none'; }
on("calcModal", "click", e => { if (e.target === $('calcModal')) closeCalcModal(); });

/* ── REMINDERS ── */
let editingRemId = null;
async function loadReminders() {
  const list = $('remindersList');
  if (!list) return;
  const res = await api('GET', '/api/reminders');
  if (!res.reminders || !res.reminders.length) { list.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-light);">Sin recordatorios aún.</div>'; return; }
  const icons = { general: '📌', exam: '📝', meeting: '🤝', class: '📚', deadline: '⏰' };
  list.innerHTML = res.reminders.map(r => `
    <div style="background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:16px;${r.done ? 'opacity:0.6;' : ''}">
      <div style="display:flex;justify-content:space-between;align-items:start;">
        <div>
          <div style="font-size:14px;font-weight:700;">${icons[r.type] || '📌'} ${escHtml(r.title)}</div>
          ${r.description ? `<div style="font-size:12px;color:var(--text-light);margin-top:4px;">${escHtml(r.description)}</div>` : ''}
          ${r.dueDate ? `<div style="font-size:11px;color:var(--text-light);margin-top:4px;">📅 ${new Date(r.dueDate).toLocaleDateString()}</div>` : ''}
        </div>
        <div style="display:flex;gap:4px;">
          <button class="rem-done" data-id="${r.id}" style="background:none;border:none;font-size:16px;cursor:pointer;">${r.done ? '↩️' : '✅'}</button>
          <button class="rem-edit" data-id="${r.id}" style="background:none;border:none;font-size:14px;cursor:pointer;">✏️</button>
          <button class="rem-del" data-id="${r.id}" style="background:none;border:none;color:#dc2626;font-size:14px;cursor:pointer;">🗑️</button>
        </div>
      </div>
    </div>
  `).join('');
  list.querySelectorAll('.rem-done').forEach(btn => btn.addEventListener('click', async () => { await api('PUT', '/api/reminders/' + btn.dataset.id, { done: true }); loadReminders(); }));
  list.querySelectorAll('.rem-edit').forEach(btn => btn.addEventListener('click', () => openRemModal(btn.dataset.id)));
  list.querySelectorAll('.rem-del').forEach(btn => btn.addEventListener('click', async () => { await api('DELETE', '/api/reminders/' + btn.dataset.id); loadReminders(); showToast('Eliminado', 'success'); }));
}
function openRemModal(id) {
  editingRemId = id || null;
  $('remModalTitle').textContent = id ? '✏️ Editar recordatorio' : '⏰ Nuevo recordatorio';
  $('remTitle').value = ''; $('remDate').value = ''; $('remType').value = 'general'; $('remDesc').value = '';
  if (id) { api('GET', '/api/reminders').then(res => { const r = res.reminders?.find(x => x.id === id); if (r) { $('remTitle').value = r.title; $('remDate').value = r.dueDate ? r.dueDate.slice(0,10) : ''; $('remType').value = r.type; $('remDesc').value = r.description || ''; } }); }
  $('reminderModal').style.display = 'block';
}
function closeRemModal() { $('reminderModal').style.display = 'none'; editingRemId = null; }
on("reminderModal", "click", e => { if (e.target === $('reminderModal')) closeRemModal(); });
on("addReminderBtn", "click", () => openRemModal(null));
on("saveRemBtn", "click", async () => {
  const body = { title: $('remTitle').value.trim(), dueDate: $('remDate').value, type: $('remType').value, description: $('remDesc').value.trim() };
  if (!body.title) { showToast('Título requerido', 'error'); return; }
  if (editingRemId) { await api('PUT', '/api/reminders/' + editingRemId, body); } else { await api('POST', '/api/reminders', body); }
  showToast('Recordatorio guardado', 'success'); closeRemModal(); loadReminders();
});

/* ── CUSTOM TEMPLATES ── */
let editingCtId = null;
async function loadCustomTemplates() {
  const list = $('customTmplList');
  list.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-light);">Cargando...</div>';
  const res = await api('GET', '/api/custom-templates');
  if (!res.templates || !res.templates.length) { list.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-light);">No has creado plantillas aún. Crea una para empezar.</div>'; return; }
  list.innerHTML = res.templates.map(t => `
    <div style="background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:16px;">
      <div style="display:flex;justify-content:space-between;align-items:start;">
        <div>
          <div style="font-size:14px;font-weight:700;">${escHtml(t.name)}</div>
          ${t.grade || t.area ? `<div style="font-size:11px;color:var(--text-light);">${[t.grade, t.area].filter(Boolean).join(' · ')}</div>` : ''}
        </div>
        <div style="display:flex;gap:4px;">
          <button class="ct-use" data-id="${t.id}" style="background:var(--primary);border:none;color:#fff;padding:4px 10px;border-radius:4px;font-size:11px;cursor:pointer;">Usar</button>
          <button class="ct-edit" data-id="${t.id}" style="background:none;border:none;font-size:14px;cursor:pointer;">✏️</button>
          <button class="ct-del" data-id="${t.id}" style="background:none;border:none;color:#dc2626;font-size:14px;cursor:pointer;">🗑️</button>
        </div>
      </div>
      <div style="font-size:11px;color:var(--text-light);margin-top:6px;font-style:italic;">${escHtml(t.prompt?.slice(0, 120))}${t.prompt?.length > 120 ? '...' : ''}</div>
    </div>
  `).join('');
  list.querySelectorAll('.ct-use').forEach(btn => btn.addEventListener('click', async () => {
    const res = await api('GET', '/api/custom-templates');
    const t = res.templates?.find(x => x.id === btn.dataset.id);
    if (t) { switchTab('chat'); $('messageInput').value = t.prompt; sendMessage(); }
  }));
  list.querySelectorAll('.ct-edit').forEach(btn => btn.addEventListener('click', () => openCtModal(btn.dataset.id)));
  list.querySelectorAll('.ct-del').forEach(btn => btn.addEventListener('click', async () => { await api('DELETE', '/api/custom-templates/' + btn.dataset.id); loadCustomTemplates(); showToast('Plantilla eliminada', 'success'); }));
}
function openCtModal(id) {
  editingCtId = id || null;
  $('ctModalTitle').textContent = id ? '✏️ Editar plantilla' : '📝 Nueva plantilla';
  $('ctName').value = ''; $('ctGrade').value = ''; $('ctArea').value = ''; $('ctPrompt').value = '';
  if (id) { api('GET', '/api/custom-templates').then(res => { const t = res.templates?.find(x => x.id === id); if (t) { $('ctName').value = t.name; $('ctGrade').value = t.grade || ''; $('ctArea').value = t.area || ''; $('ctPrompt').value = t.prompt; } }); }
  $('customTmplModal').style.display = 'block';
}
function closeCtModal() { $('customTmplModal').style.display = 'none'; editingCtId = null; }
on("customTmplModal", "click", e => { if (e.target === $('customTmplModal')) closeCtModal(); });
on("addCustomTmplBtn", "click", () => openCtModal(null));
on("saveCtBtn", "click", async () => {
  const body = { name: $('ctName').value.trim(), grade: $('ctGrade').value.trim(), area: $('ctArea').value.trim(), prompt: $('ctPrompt').value.trim() };
  if (!body.name || !body.prompt) { showToast('Nombre y prompt requeridos', 'error'); return; }
  if (editingCtId) { await api('PUT', '/api/custom-templates/' + editingCtId, body); } else { await api('POST', '/api/custom-templates', body); }
  showToast('Plantilla guardada', 'success'); closeCtModal(); loadCustomTemplates();
});

/* ── VERSIONS ── */
on("versionBtn", "click", async () => {
  if (!currentConversationId) { showToast('No hay planificación', 'error'); return; }
  $('versionsList').innerHTML = '<div style="text-align:center;color:var(--text-light);">Cargando...</div>';
  $('versionModal').style.display = 'block';
  const res = await api('GET', '/api/conversations/' + currentConversationId + '/versions');
  if (!res.versions || !res.versions.length) { $('versionsList').innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-light);">Sin versiones guardadas aún.</div>'; return; }
  $('versionsList').innerHTML = res.versions.map(v => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px;border-bottom:1px solid var(--border);">
      <div>
        <div style="font-size:13px;font-weight:600;">${escHtml(v.title)}</div>
        <div style="font-size:11px;color:var(--text-light);">${v.msgCount} mensajes · ${timeAgo(v.savedAt)}</div>
      </div>
      <button class="ver-restore" data-id="${v.id}" style="background:var(--primary);border:none;color:#fff;padding:4px 12px;border-radius:4px;font-size:11px;cursor:pointer;">Restaurar</button>
    </div>
  `).join('');
  $('versionsList').querySelectorAll('.ver-restore').forEach(btn => btn.addEventListener('click', async () => {
    const ver = await api('GET', '/api/versions/' + btn.dataset.id);
    if (ver.messages) {
      const container = $('messagesContainer');
      container.innerHTML = '';
      ver.messages.forEach((m, i) => container.appendChild(createMessageElement(m.role, m.content, i)));
      showToast('Versión restaurada', 'success');
      closeVersionModal();
    }
  }));
});
on("saveVersionBtn", "click", async () => {
  if (!currentConversationId) { showToast('No hay planificación', 'error'); return; }
  await api('POST', '/api/conversations/' + currentConversationId + '/version');
  showToast('Versión guardada', 'success');
});
function closeVersionModal() { $('versionModal').style.display = 'none'; }
on("versionModal", "click", e => { if (e.target === $('versionModal')) closeVersionModal(); });

/* ── PRESENTATION MODE ── */
on("presentBtn", "click", () => {
  if (!currentConversationId) { showToast('No hay planificación', 'error'); return; }
  const container = $('messagesContainer');
  if (container.requestFullscreen) { container.requestFullscreen(); }
  else if (container.webkitRequestFullscreen) { container.webkitRequestFullscreen(); }
  showToast('Modo presentación. Presiona ESC para salir.', 'success');
});

/* ── IMPORT ── */
function closeImportModal() { $('importModal').style.display = 'none'; $('importResult').textContent = ''; }
on("importModal", "click", e => { if (e.target === $('importModal')) closeImportModal(); });
on("processImportBtn", "click", async () => {
  const fileInput = $('importFileInput');
  const file = fileInput.files[0];
  if (!file) { showToast('Selecciona un archivo', 'error'); return; }
  const fd = new FormData();
  fd.append('file', file);
  const r = await fetch('/api/import/plan', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token }, body: fd });
  const res = await r.json();
  if (res.success) {
    $('importResult').innerHTML = `<div style="color:var(--accent);">✅ Extraído: ${res.name} (${res.text.length} caracteres)</div>
      <button onclick="useImportText()" style="margin-top:8px;background:var(--primary);border:none;color:#fff;padding:8px 16px;border-radius:6px;font-size:13px;cursor:pointer;">Usar en el chat</button>`;
    window._importedText = res.text;
  } else {
    $('importResult').innerHTML = `<div style="color:#dc2626;">❌ ${res.error || 'Error'}</div>`;
  }
});
function useImportText() {
  if (window._importedText) { switchTab('chat'); $('messageInput').value = 'Aquí está mi planificación, revísala y sugiérame mejoras:\n\n' + window._importedText.slice(0, 3000); sendMessage(); closeImportModal(); }
}

/* ── PIN LOCK ── */
async function checkPin() {
  const user = await api('GET', '/api/user');
  if (user.id && user.plan === 'free') return;
}
async function savePin() {
  const pin = prompt('Configura un PIN de 4 dígitos (deja vacío para eliminar):');
  if (pin === null) return;
  if (pin && pin.length !== 4) { showToast('El PIN debe ser de 4 dígitos', 'error'); return; }
  const res = await api('PUT', '/api/user/pin', { pin });
  if (res.success) showToast(res.hasPin ? 'PIN configurado' : 'PIN eliminado', 'success');
}
on("pinUnlockBtn", "click", async () => {
  const pin = $('pinInput').value;
  const res = await api('POST', '/api/user/verify-pin', { pin });
  if (res.valid) { $('pinOverlay').style.display = 'none'; $('pinError').style.display = 'none'; $('pinInput').value = ''; }
  else { $('pinError').style.display = 'block'; }
});
on("pinInput", "keydown", e => { if (e.key === 'Enter') $('pinUnlockBtn').click(); });

/* ── ONBOARDING ── */
let onbStep = 0;
const onbSteps = [
  { icon: '👋', title: '¡Bienvenido a Planixa!', desc: 'Tu asistente personal de planificación docente del MINERD. Crea unidades, planificaciones diarias, semanales, rúbricas y exámenes con IA.' },
  { icon: '💬', title: 'Chat con IA', desc: 'Escribe lo que necesitas y el AI te generará la planificación completa. Usa los botones rápidos para Unidad, Plan Diario, Semanal, Rúbrica y Examen.' },
  { icon: '📋', title: 'Organiza tu trabajo', desc: 'Usa las pestañas para ver tu calendario, plantillas, estudiantes, horario, plan anual y estadísticas. Todo en un solo lugar.' }
];
on("onbNextBtn", "click", () => {
  onbStep++;
  if (onbStep >= onbSteps.length) { $('onboardingOverlay').style.display = 'none'; localStorage.setItem('planif_onboarded', '1'); return; }
  const s = onbSteps[onbStep];
  $('onbStep').textContent = s.icon;
  $('onbTitle').textContent = s.title;
  $('onbDesc').textContent = s.desc;
  document.querySelectorAll('.onb-dot').forEach((dot, i) => dot.style.background = i <= onbStep ? 'var(--primary)' : 'var(--border)');
});
on("onbSkipBtn", "click", () => { $('onboardingOverlay').style.display = 'none'; localStorage.setItem('planif_onboarded', '1'); });

async function checkBoot() {
  const user = currentUser;
  if (user?.id) {
  }
  if (!localStorage.getItem('planif_onboarded')) {
    setTimeout(() => { $('onbStep').textContent = onbSteps[0].icon; $('onbTitle').textContent = onbSteps[0].title; $('onbDesc').textContent = onbSteps[0].desc; $('onboardingOverlay').style.display = 'flex'; }, 500);
  }
}

/* ── VOICE ── */
if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
  $('voiceBtn').style.display = 'block';
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const recognition = new SpeechRecognition();
  recognition.lang = 'es-DO'; recognition.continuous = false; recognition.interimResults = false;
  on("voiceBtn", "click", () => {
    try { recognition.start(); showToast('🎤 Escuchando...', 'success'); } catch (e) { showToast('Error al iniciar voz', 'error'); }
  });
  recognition.onresult = (e) => {
    const text = e.results[0][0].transcript;
    $('messageInput').value = ($('messageInput').value + ' ' + text).trim();
    $('messageInput').dispatchEvent(new Event('input'));
    showToast('✅ Texto reconocido', 'success');
  };
  recognition.onerror = () => showToast('🎤 No se pudo reconocer la voz', 'error');
}

/* ── JOURNAL ── */
async function loadJournal() {
  const list = $('journalList');
  list.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-light);">Cargando...</div>';
  const res = await api('GET', '/api/journal');
  if (!res.entries || !res.entries.length) { list.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-light);">Sin entradas en el diario.</div>'; return; }
  const moods = { excelente: '😊', bueno: '🙂', neutral: '😐', malo: '😞' };
  list.innerHTML = res.entries.map(e => `
    <div style="background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:16px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <div style="font-size:13px;font-weight:700;">${moods[e.mood] || '😐'} ${new Date(e.date).toLocaleDateString()}</div>
        <button class="jr-del" data-id="${e.id}" style="background:none;border:none;color:#dc2626;font-size:14px;cursor:pointer;">🗑️</button>
      </div>
      <div style="font-size:13px;color:var(--text);line-height:1.6;">${escHtml(e.content)}</div>
      ${e.tags?.length ? `<div style="margin-top:8px;display:flex;gap:4px;flex-wrap:wrap;">${e.tags.map(t => `<span style="background:#f1f5f9;padding:2px 8px;border-radius:10px;font-size:10px;color:var(--text-light);">${escHtml(t)}</span>`).join('')}</div>` : ''}
    </div>
  `).join('');
  list.querySelectorAll('.jr-del').forEach(btn => btn.addEventListener('click', async () => { await api('DELETE', '/api/journal/' + btn.dataset.id); loadJournal(); showToast('Eliminado', 'success'); }));
}
on("addJournalBtn", "click", () => {
  $('jrDate').value = new Date().toISOString().slice(0,10);
  $('jrMood').value = 'neutral'; $('jrContent').value = ''; $('jrTags').value = '';
  $('journalModal').style.display = 'block';
});
function closeJournalModal() { $('journalModal').style.display = 'none'; }
on("journalModal", "click", e => { if (e.target === $('journalModal')) closeJournalModal(); });
on("saveJournalBtn", "click", async () => {
  const body = { date: $('jrDate').value, mood: $('jrMood').value, content: $('jrContent').value.trim(), tags: $('jrTags').value.split(',').map(s => s.trim()).filter(Boolean) };
  if (!body.content) { showToast('Escribe tu reflexión', 'error'); return; }
  await api('POST', '/api/journal', body);
  showToast('Entrada guardada', 'success'); closeJournalModal(); loadJournal();
});

/* ── COMPETENCIAS ── */
async function loadCompetencias() {
  const res = await api('GET', '/api/competencias');
  const cfList = $('cfList');
  cfList.innerHTML = (res.fundamentales || []).map(c => `
    <div style="background:var(--card);border:1px solid var(--border);border-radius:8px;padding:12px;">
      <div style="font-size:13px;font-weight:700;color:var(--primary);">${c.code} - ${c.name}</div>
      <div style="font-size:12px;color:var(--text-light);">${c.desc}</div>
    </div>
  `).join('');
  const caList = $('caList');
  caList.innerHTML = '';
  Object.entries(res.areas || {}).forEach(([area, comps]) => {
    caList.innerHTML += `<div style="background:var(--card);border:1px solid var(--border);border-radius:8px;padding:12px;">
      <div style="font-size:13px;font-weight:700;color:var(--accent);margin-bottom:4px;">${area}</div>
      ${comps.map(c => `<div style="font-size:12px;color:var(--text-light);padding:2px 0;">· ${c}</div>`).join('')}
    </div>`;
  });
}

/* ── EVALUATION SCHEDULE ── */
async function loadEvalSchedule() {
  const list = $('evalList');
  list.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-light);">Cargando...</div>';
  const res = await api('GET', '/api/evaluation-schedule');
  if (!res.evaluations || !res.evaluations.length) { list.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-light);">Sin evaluaciones programadas.</div>'; return; }
  const icons = { exam: '📝', quiz: '📄', project: '📐', homework: '📚', oral: '🎤' };
  list.innerHTML = res.evaluations.map(e => `
    <div style="background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:16px;">
      <div style="display:flex;justify-content:space-between;align-items:start;">
        <div>
          <div style="font-size:14px;font-weight:700;">${icons[e.type] || '📝'} ${escHtml(e.title)}</div>
          <div style="font-size:11px;color:var(--text-light);">📅 ${new Date(e.date).toLocaleDateString()} · ${escHtml(e.subject)} · ${escHtml(e.grade)}</div>
        </div>
        <button class="eval-del" data-id="${e.id}" style="background:none;border:none;color:#dc2626;font-size:14px;cursor:pointer;">🗑️</button>
      </div>
      ${e.notes ? `<div style="font-size:12px;color:var(--text);margin-top:6px;">${escHtml(e.notes)}</div>` : ''}
    </div>
  `).join('');
  list.querySelectorAll('.eval-del').forEach(btn => btn.addEventListener('click', async () => { await api('DELETE', '/api/evaluation-schedule/' + btn.dataset.id); loadEvalSchedule(); showToast('Eliminado', 'success'); }));
}
on("addEvalBtn", "click", () => {
  $('evTitle').value = ''; $('evDate').value = ''; $('evType').value = 'exam'; $('evSubject').value = ''; $('evGrade').value = ''; $('evNotes').value = '';
  $('evalModal').style.display = 'block';
});
function closeEvalModal() { $('evalModal').style.display = 'none'; }
on("evalModal", "click", e => { if (e.target === $('evalModal')) closeEvalModal(); });
on("saveEvalBtn", "click", async () => {
  const body = { title: $('evTitle').value.trim(), date: $('evDate').value, type: $('evType').value, subject: $('evSubject').value.trim(), grade: $('evGrade').value.trim(), notes: $('evNotes').value.trim() };
  if (!body.title) { showToast('Nombre requerido', 'error'); return; }
  await api('POST', '/api/evaluation-schedule', body);
  showToast('Evaluación agregada', 'success'); closeEvalModal(); loadEvalSchedule();
});

/* ── CLIENTS ── */
let selectedClientPhone = null;
async function loadClients() {
  const res = await api('GET', '/api/clients');
  const list = $('clientList');
  $('clientCount').textContent = res.clients?.length + ' clientes' || '0';
  list.innerHTML = (res.clients || []).map(c => `
    <div class="client-item" data-phone="${escHtml(c.phone)}" style="padding:14px 16px;cursor:pointer;border-bottom:1px solid var(--border);transition:background 0.15s;">
      <div style="font-size:14px;font-weight:700;">${escHtml(c.name)}</div>
      <div style="font-size:11px;color:var(--text-light);margin-top:2px;">${escHtml(c.phone)} · ${c.incoming} msgs</div>
      <div style="font-size:12px;color:var(--text);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml((c.lastMsg || '').slice(0, 80))}</div>
      <div style="font-size:10px;color:var(--text-light);margin-top:2px;">${timeAgo(c.lastDate)}</div>
    </div>
  `).join('');
  list.querySelectorAll('.client-item').forEach(el => el.addEventListener('click', () => selectClient(el.dataset.phone)));
  if (selectedClientPhone) { const match = list.querySelector(`[data-phone="${selectedClientPhone}"]`); if (match) selectClient(selectedClientPhone); else { selectedClientPhone = null; $('clientThreadHeader').textContent = ''; $('clientMessages').innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-light);">Selecciona un cliente</div>'; $('clientReplyArea').style.display = 'none'; } }
}
async function selectClient(phone) {
  selectedClientPhone = phone;
  document.querySelectorAll('.client-item').forEach(el => el.style.background = '');
  const el = document.querySelector(`.client-item[data-phone="${phone}"]`);
  if (el) el.style.background = 'var(--primary-light, #eff6ff)';
  $('clientThreadHeader').textContent = '💬 ' + phone;
  $('clientMessages').innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-light);">Cargando...</div>';
  $('clientReplyArea').style.display = 'flex';
  $('clientReplyInput').value = '';
  const res = await api('GET', `/api/clients/${phone}/messages`);
  $('clientMessages').innerHTML = (res.messages || []).map(m => `
    <div style="align-self:${m.direction === 'incoming' ? 'flex-start' : 'flex-end'};max-width:80%;padding:10px 14px;border-radius:12px;font-size:13px;line-height:1.5;${m.direction === 'incoming' ? 'background:var(--card);border:1px solid var(--border);border-bottom-left-radius:4px;' : "background:var(--primary);color:#fff;border-bottom-right-radius:4px;"}">
      <div style="font-size:10px;font-weight:700;margin-bottom:3px;opacity:0.7;">${m.direction === 'incoming' ? '📩 Cliente' : '📤 ' + (m.employeeName || 'Tú')}</div>
      <div style="white-space:pre-wrap;">${escHtml(m.message)}</div>
      <div style="font-size:9px;opacity:0.5;margin-top:4px;">${timeAgo(m.createdAt)}</div>
    </div>
  `).join('') || '<div style="text-align:center;padding:40px;color:var(--text-light);">Sin mensajes</div>';
  $('clientMessages').scrollTop = $('clientMessages').scrollHeight;
}
on("clientSearch", "input", function() {
  const q = this.value.toLowerCase();
  document.querySelectorAll('.client-item').forEach(el => {
    el.style.display = el.textContent.toLowerCase().includes(q) ? 'block' : 'none';
  });
});
on("clientReplyBtn", "click", async () => {
  const msg = $('clientReplyInput').value.trim();
  if (!msg || !selectedClientPhone) return;
  $('clientReplyBtn').disabled = true; $('clientReplyBtn').textContent = 'Enviando...';
  const res = await api('POST', `/api/clients/${selectedClientPhone}/reply`, { message: msg });
  $('clientReplyBtn').disabled = false; $('clientReplyBtn').textContent = 'Enviar';
  if (res.sent || res.simulated) {
    showToast(res.sent ? '✅ Mensaje enviado' : '📝 Guardado (WA no configurado)', res.sent ? 'success' : 'error');
    selectClient(selectedClientPhone);
  } else {
    showToast('Error al enviar', 'error');
  }
});

/* ── ADECUACIÓN ── */
on("adecuacionBtn2", "click", () => {
  $('adGrade').value = currentUser?.grade || '';
  $('adArea').value = currentUser?.area || '';
  $('adTopic').value = ''; $('adNeeds').value = '';
  $('adecuacionModal').style.display = 'block';
});
function closeAdecuacionModal() { $('adecuacionModal').style.display = 'none'; }
on("adecuacionModal", "click", e => { if (e.target === $('adecuacionModal')) closeAdecuacionModal(); });
on("generateAdecuacionBtn", "click", async () => {
  const topic = $('adTopic').value.trim();
  if (!topic) { showToast('Tema requerido', 'error'); return; }
  closeAdecuacionModal();
  switchTab('chat');
  $('messageInput').value = `Genera una adecuación curricular para ${$('adGrade').value.trim() || 'el grado'} de ${$('adArea').value.trim() || 'la materia'}. Tema: ${topic}. Necesidades: ${$('adNeeds').value.trim() || 'dificultades generales'}.`;
  sendMessage();
});

/* ── SIDEBAR ── */
on("menuBtn", "click", toggleSidebar);
on("closeSidebar", "click", closeSidebar);
on("sidebarBackdrop", "click", closeSidebar);
function toggleSidebar() { $('sidebar').classList.toggle('closed'); $('sidebarBackdrop').classList.toggle('open'); }
function openSidebar() { $('sidebar').classList.remove('closed'); $('sidebarBackdrop').classList.add('open'); }
function closeSidebar() { $('sidebar').classList.add('closed'); $('sidebarBackdrop').classList.remove('open'); }

/* ── UTILS ── */
function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
function timeAgo(d) {
  const diff = Date.now() - new Date(d).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'ahora';
  if (mins < 60) return mins + ' min';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h';
  const days = Math.floor(hrs / 24);
  if (days < 7) return days + 'd';
  return new Date(d).toLocaleDateString('es-DO', { day: 'numeric', month: 'short' });
}

/* ── BOOT ── */
if (token && userId) {
  enterApp();
} else {
  $('authOverlay').style.display = 'flex';
}
