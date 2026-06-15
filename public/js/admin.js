let adminUsers = [];
let adminActiveUserId = null;

// Initialize Admin Panel bindings
window.initAdminPanel = function() {
  const adminNavTab = document.getElementById('adminNavTab');
  if (adminNavTab) {
    adminNavTab.addEventListener('click', () => {
      loadAdminUsers();
      document.getElementById('adminTabDash')?.click();
    });
  }

  function switchAdminTab(activeTabId, activeViewId, callback) {
    const tabs = ['adminTabDash', 'adminTabUsers', 'adminTabManage', 'adminTabBroadcast', 'adminTabConfig', 'adminTabFormats'];
    const views = ['adminDashView', 'adminChatView', 'adminManageView', 'adminBroadcastView', 'adminPromptView', 'adminFormatView'];
    
    tabs.forEach(tab => {
      const el = document.getElementById(tab);
      if(el) {
        if(tab === activeTabId) {
          el.style.color = 'var(--primary)';
          el.style.fontWeight = 'bold';
        } else {
          el.style.color = 'var(--text-light)';
          el.style.fontWeight = 'normal';
        }
      }
    });

    views.forEach(view => {
      const el = document.getElementById(view);
      if(el) {
        if(view === activeViewId) el.style.display = view === 'adminChatView' || view === 'adminDashView' ? 'flex' : 'block';
        else el.style.display = 'none';
      }
    });
    
    // Toggle side columns based on view
    const col1 = document.querySelector('.admin-col-1');
    const col3 = document.querySelector('.admin-col-3');
    if (activeViewId === 'adminChatView') {
      if (col1) col1.style.display = 'flex';
      if (col3) col3.style.display = 'flex';
    } else {
      if (col1) col1.style.display = 'none';
      if (col3) col3.style.display = 'none';
    }

    if(callback) callback();
  }

  document.getElementById('adminTabDash')?.addEventListener('click', () => switchAdminTab('adminTabDash', 'adminDashView', loadAdminDashboard));
  document.getElementById('adminTabUsers')?.addEventListener('click', () => switchAdminTab('adminTabUsers', 'adminChatView'));
  document.getElementById('adminTabManage')?.addEventListener('click', () => switchAdminTab('adminTabManage', 'adminManageView', renderAdminManageTable));
  document.getElementById('adminTabBroadcast')?.addEventListener('click', () => switchAdminTab('adminTabBroadcast', 'adminBroadcastView'));
  document.getElementById('adminTabConfig')?.addEventListener('click', () => switchAdminTab('adminTabConfig', 'adminPromptView', loadAdminPrompts));
  document.getElementById('adminTabFormats')?.addEventListener('click', () => switchAdminTab('adminTabFormats', 'adminFormatView', loadAdminFormats));


  document.getElementById('adminSearchUsers')?.addEventListener('input', (e) => {
    renderAdminUserList(e.target.value);
    if (document.getElementById('adminManageView').style.display === 'block') {
      renderAdminManageTable(e.target.value);
    }
  });

  document.getElementById('adminEditCancelBtn')?.addEventListener('click', () => {
    document.getElementById('adminEditModal').style.display = 'none';
  });

  document.getElementById('adminEditSaveBtn')?.addEventListener('click', async () => {
    const userId = document.getElementById('adminEditUserId').value;
    const plan = document.getElementById('adminEditPlan').value;
    const expires = document.getElementById('adminEditExpires').value;
    const resetCount = document.getElementById('adminEditResetCount').checked;
    try {
      const res = await fetch('/api/admin/users/' + userId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('planif_token') },
        body: JSON.stringify({ plan, plan_expires: expires || null, resetCount })
      });
      if (res.ok) {
        document.getElementById('adminEditModal').style.display = 'none';
        loadAdminUsers(); // refresh
      } else {
        alert('Error guardando membresía');
      }
    } catch (err) {
      console.error(err);
    }
  });

  // Prompts logic
  document.getElementById('adminNewPromptBtn')?.addEventListener('click', () => openPromptModal(null));
  document.getElementById('adminPromptCancelBtn')?.addEventListener('click', () => { document.getElementById('adminPromptModal').style.display = 'none'; });
  document.getElementById('adminPromptSaveBtn')?.addEventListener('click', saveAdminPrompt);
  document.getElementById('adminPromptDeleteBtn')?.addEventListener('click', deleteAdminPrompt);

  // Formats logic
  document.getElementById('adminNewFormatBtn')?.addEventListener('click', () => openFormatModal(null));
  document.getElementById('adminFormatCancelBtn')?.addEventListener('click', () => { document.getElementById('adminFormatModal').style.display = 'none'; });
  document.getElementById('adminFormatSaveBtn')?.addEventListener('click', saveAdminFormat);
  document.getElementById('adminFormatDeleteBtn')?.addEventListener('click', deleteAdminFormat);

  // Admin AI Chat
  document.getElementById('adminAiSendBtn')?.addEventListener('click', sendAdminAiMessage);
  document.getElementById('adminAiInput')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendAdminAiMessage();
  });

  const adminVoiceBtn = document.getElementById('adminAiVoiceBtn');
  if (adminVoiceBtn && ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const adminRecognition = new SpeechRecognition();
    adminRecognition.lang = 'es-DO'; adminRecognition.continuous = false; adminRecognition.interimResults = false;
    adminVoiceBtn.addEventListener('click', () => {
      try { adminRecognition.start(); showToast('🎤 Escuchando...', 'success'); } catch (e) { showToast('Error al iniciar voz', 'error'); }
    });
    adminRecognition.onresult = (e) => {
      const text = e.results[0][0].transcript;
      const input = document.getElementById('adminAiInput');
      input.value = (input.value + ' ' + text).trim();
      showToast('✅ Texto reconocido', 'success');
    };
    adminRecognition.onerror = () => showToast('🎤 No se pudo reconocer la voz', 'error');
  } else if (adminVoiceBtn) {
    adminVoiceBtn.style.display = 'none';
  }
};


async function loadAdminUsers() {
  try {
    const res = await fetch('/api/admin/users', {
      headers: { 'Authorization': 'Bearer ' + localStorage.getItem('planif_token') }
    });
    const data = await res.json();
    console.log("Admin Users Data:", data);
    adminUsers = data.users || [];
    renderAdminUserList();
    if (document.getElementById('adminManageView').style.display === 'block') {
      renderAdminManageTable();
    }
  } catch (err) {
    console.error('Error loading admin users', err);
  }
}

function renderAdminUserList(filter = '') {
  const container = document.getElementById('adminUserList');
  if (!container) return;
  container.innerHTML = '';
  
  const filtered = adminUsers.filter(u => 
    (u.name || '').toLowerCase().includes(filter.toLowerCase()) || 
    (u.phone || '').includes(filter)
  );

  filtered.forEach(u => {
    const div = document.createElement('div');
    div.style.padding = '10px';
    div.style.background = adminActiveUserId === u.id ? 'var(--primary)' : 'var(--bg-hover)';
    div.style.color = adminActiveUserId === u.id ? 'white' : 'var(--text)';
    div.style.borderRadius = '8px';
    div.style.cursor = 'pointer';
    div.style.fontSize = '13px';
    div.innerHTML = `<strong>${u.name || 'Sin nombre'}</strong><br><span style="opacity:0.8">${u.phone}</span>`;
    div.onclick = () => {
      adminActiveUserId = u.id;
      document.getElementById('adminActiveUserName').innerText = '- ' + (u.name || u.phone);
      renderAdminUserList(filter); // re-render to update active styling
      loadAdminUserChat(u.id);
    };
    container.appendChild(div);
  });
}

function renderAdminManageTable(filter = '') {
  const tbody = document.getElementById('adminManageTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';
  
  const filtered = adminUsers.filter(u => 
    (u.name || '').toLowerCase().includes(filter.toLowerCase()) || 
    (u.phone || '').includes(filter)
  );

  filtered.forEach(u => {
    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid var(--border)';
    
    let expiresStr = 'N/A';
    if (u.plan_expires) {
      expiresStr = new Date(u.plan_expires).toLocaleDateString();
    }

    tr.innerHTML = `
      <td style="padding:10px;">${u.name || 'Sin nombre'}</td>
      <td>${u.phone}</td>
      <td><span style="background:var(--bg-hover); padding:2px 6px; border-radius:4px; font-size:11px;">${u.plan || 'trial'}</span></td>
      <td>${u.plans_count || 0}</td>
      <td>${expiresStr}</td>
      <td>
        <button onclick="editUserMembership('${u.id}', '${u.plan}', '${u.plan_expires}')" style="background:var(--primary); color:white; border:none; border-radius:4px; padding:4px 8px; cursor:pointer; font-size:11px;">Editar</button>
        <button onclick="deleteAdminUser('${u.id}')" style="background:#dc2626; color:white; border:none; border-radius:4px; padding:4px 8px; cursor:pointer; font-size:11px;">Eliminar</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

window.editUserMembership = function(userId, plan, expires) {
  document.getElementById('adminEditUserId').value = userId;
  document.getElementById('adminEditPlan').value = plan;
  document.getElementById('adminEditExpires').value = expires ? expires.split('T')[0] : '';
  document.getElementById('adminEditResetCount').checked = true;
  document.getElementById('adminEditModal').style.display = 'flex';
}

// --- PROMPTS LOGIC ---
let adminPrompts = [];

async function loadAdminPrompts() {
  try {
    const res = await fetch('/api/admin/prompts', { headers: { 'Authorization': 'Bearer ' + localStorage.getItem('planif_token') } });
    if (res.ok) {
      adminPrompts = await res.json();
      renderAdminPrompts();
    }
  } catch (err) { console.error(err); }
}

function renderAdminPrompts() {
  const list = document.getElementById('adminPromptList');
  if (!list) return;
  list.innerHTML = '';
  adminPrompts.forEach(p => {
    const card = document.createElement('div');
    card.style.padding = '15px';
    card.style.background = 'var(--bg-hover)';
    card.style.border = '1px solid var(--border)';
    card.style.borderRadius = '8px';
    card.style.cursor = 'pointer';
    card.innerHTML = `
      <h4 style="margin:0 0 5px 0;">${p.name}</h4>
      <p style="font-size:12px; color:var(--text-light); margin:0;">${(p.description || '').substring(0, 80)}...</p>
    `;
    card.onclick = () => openPromptModal(p);
    list.appendChild(card);
  });
}

function openPromptModal(prompt) {
  document.getElementById('adminPromptModal').style.display = 'flex';
  if (prompt) {
    document.getElementById('adminPromptModalTitle').innerText = 'Editar Agente';
    document.getElementById('adminPromptId').value = prompt.id;
    document.getElementById('adminPromptName').value = prompt.name || '';
    document.getElementById('adminPromptDesc').value = prompt.description || '';
    document.getElementById('adminPromptContent').value = prompt.content || '';
    document.getElementById('adminPromptDeleteBtn').style.display = 'block';
  } else {
    document.getElementById('adminPromptModalTitle').innerText = 'Nuevo Agente';
    document.getElementById('adminPromptId').value = '';
    document.getElementById('adminPromptName').value = '';
    document.getElementById('adminPromptDesc').value = '';
    document.getElementById('adminPromptContent').value = '';
    document.getElementById('adminPromptDeleteBtn').style.display = 'none';
  }
}

async function saveAdminPrompt() {
  const id = document.getElementById('adminPromptId').value;
  const name = document.getElementById('adminPromptName').value;
  const description = document.getElementById('adminPromptDesc').value;
  const content = document.getElementById('adminPromptContent').value;
  if (!name || !content) return alert('Nombre y Contenido son requeridos');
  
  const method = id ? 'PUT' : 'POST';
  const url = id ? '/api/admin/prompts/' + id : '/api/admin/prompts';
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('planif_token') },
      body: JSON.stringify({ name, description, content })
    });
    if (res.ok) {
      document.getElementById('adminPromptModal').style.display = 'none';
      loadAdminPrompts();
    } else {
      alert('Error al guardar el prompt');
    }
  } catch (err) { console.error(err); }
}

async function deleteAdminPrompt() {
  const id = document.getElementById('adminPromptId').value;
  if (!id) return;
  if (!confirm('¿Seguro que deseas eliminar este agente?')) return;
  try {
    const res = await fetch('/api/admin/prompts/' + id, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + localStorage.getItem('planif_token') }
    });
    if (res.ok) {
      document.getElementById('adminPromptModal').style.display = 'none';
      loadAdminPrompts();
    }
  } catch (err) { console.error(err); }
}

// --- FORMATS LOGIC ---
let adminFormats = [];

async function loadAdminFormats() {
  try {
    const res = await fetch('/api/admin/formats', { headers: { 'Authorization': 'Bearer ' + localStorage.getItem('planif_token') } });
    if (res.ok) {
      adminFormats = await res.json();
      renderAdminFormats();
    }
  } catch (err) { console.error(err); }
}

function renderAdminFormats() {
  const list = document.getElementById('adminFormatList');
  if (!list) return;
  list.innerHTML = '';
  adminFormats.forEach(f => {
    const card = document.createElement('div');
    card.style.padding = '15px';
    card.style.background = 'var(--bg-hover)';
    card.style.border = '1px solid var(--border)';
    card.style.borderRadius = '8px';
    card.style.cursor = 'pointer';
    card.innerHTML = `
      <h4 style="margin:0 0 5px 0;">${f.type}</h4>
      <p style="font-size:12px; color:var(--text-light); margin:0;">${f.fileName || 'Plantilla.docx'}</p>
    `;
    card.onclick = () => openFormatModal(f);
    list.appendChild(card);
  });
}

function openFormatModal(format) {
  document.getElementById('adminFormatModal').style.display = 'flex';
  if (format) {
    document.getElementById('adminFormatModalTitle').innerText = 'Editar Formato';
    document.getElementById('adminFormatId').value = format.id;
    document.getElementById('adminFormatType').value = format.type || '';
    document.getElementById('adminFormatInstructions').value = format.instructions || '';
    document.getElementById('adminFormatFileStatus').innerText = 'Archivo actual: ' + (format.fileName || 'Ninguno');
    document.getElementById('adminFormatDeleteBtn').style.display = 'block';
  } else {
    document.getElementById('adminFormatModalTitle').innerText = 'Nuevo Formato';
    document.getElementById('adminFormatId').value = '';
    document.getElementById('adminFormatType').value = '';
    document.getElementById('adminFormatInstructions').value = '';
    document.getElementById('adminFormatFileStatus').innerText = '';
    document.getElementById('adminFormatDeleteBtn').style.display = 'none';
  }
  document.getElementById('adminFormatFile').value = '';
}

async function saveAdminFormat() {
  const id = document.getElementById('adminFormatId').value;
  const type = document.getElementById('adminFormatType').value;
  const instructions = document.getElementById('adminFormatInstructions').value;
  const fileInput = document.getElementById('adminFormatFile');
  
  if (!type) return alert('El tipo es requerido');
  if (!id && (!fileInput.files || fileInput.files.length === 0)) {
    return alert('Debes subir un archivo .docx para crear un formato.');
  }
  
  const formData = new FormData();
  formData.append('type', type);
  formData.append('instructions', instructions);
  if (fileInput.files.length > 0) {
    formData.append('templateFile', fileInput.files[0]);
  }
  
  const method = id ? 'PUT' : 'POST';
  const url = id ? '/api/admin/formats/' + id : '/api/admin/formats';
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Authorization': 'Bearer ' + localStorage.getItem('planif_token') },
      body: formData
    });
    if (res.ok) {
      document.getElementById('adminFormatModal').style.display = 'none';
      loadAdminFormats();
    } else {
      const data = await res.json();
      alert('Error al guardar el formato: ' + (data.error || 'Desconocido'));
    }
  } catch (err) { console.error(err); }
}

async function deleteAdminFormat() {
  const id = document.getElementById('adminFormatId').value;
  if (!id) return;
  if (!confirm('¿Seguro que deseas eliminar este formato?')) return;
  try {
    const res = await fetch('/api/admin/formats/' + id, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + localStorage.getItem('planif_token') }
    });
    if (res.ok) {
      document.getElementById('adminFormatModal').style.display = 'none';
      loadAdminFormats();
    }
  } catch (err) { console.error(err); }
}


window.deleteAdminUser = async function(id) {
  if (!confirm('¿Seguro que deseas eliminar a este usuario por completo? Se borrarán sus conversaciones también.')) return;
  try {
    const res = await fetch('/api/admin/users/' + id, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + localStorage.getItem('planif_token') }
    });
    if (res.ok) {
      loadAdminUsers();
    } else {
      alert('Error eliminando usuario. Puede que sea admin.');
    }
  } catch(e) { console.error(e); }
}

async function loadAdminUserChat(userId) {
  const view = document.getElementById('adminChatView');
  view.innerHTML = '<div style="text-align:center; margin-top:20px;">Cargando chat...</div>';
  try {
    const res = await fetch('/api/admin/users/' + userId + '/chat', {
      headers: { 'Authorization': 'Bearer ' + localStorage.getItem('planif_token') }
    });
    const data = await res.json();
    view.innerHTML = '';
    
    // Render whatsapp messages
    if (data.messages && data.messages.length > 0) {
      data.messages.forEach(m => {
        const div = document.createElement('div');
        div.style.padding = '10px';
        div.style.borderRadius = '8px';
        div.style.maxWidth = '80%';
        div.style.marginBottom = '5px';
        div.style.fontSize = '13px';
        if (m.direction === 'incoming') {
          div.style.background = 'var(--bg-hover)';
          div.style.alignSelf = 'flex-start';
        } else {
          div.style.background = 'var(--primary)';
          div.style.color = 'white';
          div.style.alignSelf = 'flex-end';
        }
        div.innerText = m.message;
        view.appendChild(div);
      });
    } else if (data.conversations && data.conversations.length > 0) {
      // Fallback to web conversations
      data.conversations[0].messages.forEach(m => {
        if (m.role === 'system') return;
        const div = document.createElement('div');
        div.style.padding = '10px';
        div.style.borderRadius = '8px';
        div.style.maxWidth = '80%';
        div.style.marginBottom = '5px';
        div.style.fontSize = '13px';
        if (m.role === 'user') {
          div.style.background = 'var(--bg-hover)';
          div.style.alignSelf = 'flex-start';
        } else {
          div.style.background = 'var(--primary)';
          div.style.color = 'white';
          div.style.alignSelf = 'flex-end';
        }
        div.innerText = m.content;
        view.appendChild(div);
      });
    } else {
      view.innerHTML = '<div style="text-align:center; color:gray; margin-top:20px;">No hay historial para este usuario.</div>';
    }
  } catch (err) {
    view.innerHTML = '<div style="text-align:center; color:red; margin-top:20px;">Error cargando historial.</div>';
  }
}

async function sendAdminAiMessage() {
  const input = document.getElementById('adminAiInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  
  const chat = document.getElementById('adminAiChat');
  
  // User bubble
  const userDiv = document.createElement('div');
  userDiv.style.background = 'var(--primary)';
  userDiv.style.color = 'white';
  userDiv.style.padding = '10px';
  userDiv.style.borderRadius = '8px';
  userDiv.style.alignSelf = 'flex-end';
  userDiv.style.whiteSpace = 'pre-wrap';
  userDiv.innerText = text;
  chat.appendChild(userDiv);
  
  // Loading
  const loadDiv = document.createElement('div');
  loadDiv.innerText = 'Pensando...';
  loadDiv.style.alignSelf = 'flex-start';
  loadDiv.style.color = 'gray';
  chat.appendChild(loadDiv);
  
  // Context from currently selected user
  let context = null;
  if (adminActiveUserId) {
    const u = adminUsers.find(x => x.id === adminActiveUserId);
    context = { name: u.name, phone: u.phone, plan: u.plan };
  }

  try {
    const res = await fetch('/api/admin/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('planif_token') },
      body: JSON.stringify({ message: text, context })
    });
    const data = await res.json();
    chat.removeChild(loadDiv);
    
    const botDiv = document.createElement('div');
    botDiv.style.background = 'var(--bg-hover)';
    botDiv.style.padding = '10px';
    botDiv.style.borderRadius = '8px';
    botDiv.style.alignSelf = 'flex-start';
    botDiv.style.whiteSpace = 'pre-wrap';
    
    if (data.error) {
      botDiv.innerText = "Error: " + data.error;
      botDiv.style.color = '#dc2626';
    } else {
      botDiv.innerText = data.response || 'Sin respuesta';
    }
    
    chat.appendChild(botDiv);
    
    chat.scrollTop = chat.scrollHeight;
  } catch(err) {
    loadDiv.innerText = 'Error de IA.';
    loadDiv.style.color = 'red';
  }
}

async function loadAdminDashboard() {
  try {
    const res = await fetch('/api/admin/dashboard', {
      headers: { 'Authorization': 'Bearer ' + localStorage.getItem('planif_token') }
    });
    if (res.ok) {
      const data = await res.json();
      document.getElementById('dashTotalUsers').textContent = data.totalUsers || 0;
      document.getElementById('dashActiveUsers').textContent = data.activeUsers || 0;
      document.getElementById('dashMRR').textContent = '$' + (data.mrr || 0);
      document.getElementById('dashConversations').textContent = data.totalConversations || 0;
    }
  } catch (err) {
    console.error('Error cargando dashboard:', err);
  }
}

document.getElementById('sendBroadcastBtn')?.addEventListener('click', async () => {
  const message = document.getElementById('broadcastMessage').value;
  const filter = document.getElementById('broadcastFilter').value;
  if (!message.trim()) {
    alert('Escribe un mensaje para enviar.');
    return;
  }
  if (!confirm('¿Estás seguro de enviar esta difusión masiva a los usuarios seleccionados?')) return;
  
  try {
    const res = await fetch('/api/admin/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('planif_token') },
      body: JSON.stringify({ message, filter })
    });
    const data = await res.json();
    if (res.ok) {
      alert(data.message);
      document.getElementById('broadcastMessage').value = '';
    } else {
      alert(data.error || 'Error al enviar difusión');
    }
  } catch (err) {
    alert('Error de conexión');
  }
});
