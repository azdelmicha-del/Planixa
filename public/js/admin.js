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
    const tabs = ['adminTabDash', 'adminTabUsers', 'adminTabManage', 'adminTabBroadcast', 'adminTabConfig', 'adminTabFormats', 'adminTabKnowledge'];
    const views = ['adminDashView', 'adminChatView', 'adminManageView', 'adminBroadcastView', 'adminPromptView', 'adminFormatView', 'adminKnowledgeView'];
    
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

  document.getElementById('adminTabDash')?.addEventListener('click', () => switchAdminTab('adminTabDash', 'adminDashView', updateAdminDashboard));
  document.getElementById('adminTabUsers')?.addEventListener('click', () => switchAdminTab('adminTabUsers', 'adminChatView'));
  document.getElementById('adminTabManage')?.addEventListener('click', () => switchAdminTab('adminTabManage', 'adminManageView', renderAdminManageTable));
  document.getElementById('adminTabBroadcast')?.addEventListener('click', () => switchAdminTab('adminTabBroadcast', 'adminBroadcastView'));
  document.getElementById('adminTabConfig')?.addEventListener('click', () => switchAdminTab('adminTabConfig', 'adminPromptView', loadAdminPrompts));
  document.getElementById('adminTabFormats')?.addEventListener('click', () => switchAdminTab('adminTabFormats', 'adminFormatView', loadAdminFormats));
  document.getElementById('adminTabKnowledge')?.addEventListener('click', () => switchAdminTab('adminTabKnowledge', 'adminKnowledgeView', window.loadKnowledgeItems));
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
        await PremiumModal.alert('Error guardando membresía');
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
    updateAdminDashboard();
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

window.filterPrompts = function() {
  const query = (document.getElementById('searchPromptInput').value || '').toLowerCase();
  const filtered = adminPrompts.filter(p => 
    (p.name || '').toLowerCase().includes(query) || 
    (p.description || '').toLowerCase().includes(query)
  );
  renderAdminPrompts(filtered);
};

function renderAdminPrompts(items = adminPrompts) {
  const list = document.getElementById('adminPromptList');
  if (!list) return;
  list.innerHTML = '';
  items.forEach(p => {
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
    document.getElementById('countPrompt').innerText = (prompt.content || '').length + ' / 6000';
  } else {
    document.getElementById('adminPromptModalTitle').innerText = 'Nuevo Agente';
    document.getElementById('adminPromptId').value = '';
    document.getElementById('adminPromptName').value = '';
    document.getElementById('adminPromptDesc').value = '';
    document.getElementById('adminPromptContent').value = '';
    document.getElementById('adminPromptDeleteBtn').style.display = 'none';
    document.getElementById('countPrompt').innerText = '0 / 6000';
  }
}

async function saveAdminPrompt() {
  const id = document.getElementById('adminPromptId').value;
  const name = document.getElementById('adminPromptName').value;
  const description = document.getElementById('adminPromptDesc').value;
  const content = document.getElementById('adminPromptContent').value;
  if (!name || !content) return await PremiumModal.alert('Nombre y Contenido son requeridos');
  
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
      await PremiumModal.alert('Error al guardar el prompt');
    }
  } catch (err) { console.error(err); }
}

async function deleteAdminPrompt() {
  const id = document.getElementById('adminPromptId').value;
  if (!id) return;
  if (!(await PremiumModal.confirm)('¿Seguro que deseas eliminar este agente?')) return;
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

window.filterFormats = function() {
  const query = (document.getElementById('searchFormatInput').value || '').toLowerCase();
  const filtered = adminFormats.filter(f => 
    (f.type || '').toLowerCase().includes(query) || 
    (f.instructions || '').toLowerCase().includes(query)
  );
  renderAdminFormats(filtered);
};

function renderAdminFormats(items = adminFormats) {
  const list = document.getElementById('adminFormatList');
  if (!list) return;
  list.innerHTML = '';
  items.forEach(f => {
    const card = document.createElement('div');
    card.style.padding = '15px';
    card.style.background = 'var(--bg-hover)';
    card.style.border = '1px solid var(--border)';
    card.style.borderRadius = '8px';
    card.style.cursor = 'pointer';
    card.innerHTML = `
      <div style="flex:1;">
        <h4 style="margin:0 0 5px 0;">${f.type}</h4>
        <p style="font-size:12px; color:var(--text-light); margin:0;">${f.fileName || 'Plantilla.docx'}</p>
      </div>
      <div style="display:flex; gap:8px; margin-top:10px;">
        <button onclick="event.stopPropagation(); openFormatModal(${JSON.stringify(f).replace(/"/g, '&quot;')})" style="background:rgba(255,255,255,0.1); color:var(--text); border:none; padding:6px 12px; border-radius:6px; cursor:pointer; font-size:12px; flex:1;">Editar</button>
        <button onclick="event.stopPropagation(); window.deleteAdminFormatById('${f.id}')" style="background:rgba(239, 68, 68, 0.2); color:#fca5a5; border:none; padding:6px 12px; border-radius:6px; cursor:pointer; font-size:12px; flex:1;">Eliminar</button>
      </div>
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
    document.getElementById('countFormat').innerText = (format.instructions || '').length + ' / 3000';
  } else {
    document.getElementById('adminFormatModalTitle').innerText = 'Nuevo Formato';
    document.getElementById('adminFormatId').value = '';
    document.getElementById('adminFormatType').value = '';
    document.getElementById('adminFormatType').value = '';
    document.getElementById('adminFormatInstructions').value = '';
    document.getElementById('adminFormatFileStatus').innerText = '';
    document.getElementById('adminFormatDeleteBtn').style.display = 'none';
    document.getElementById('countFormat').innerText = '0 / 3000';
  }
  document.getElementById('adminFormatFile').value = '';
}

async function saveAdminFormat() {
  const id = document.getElementById('adminFormatId').value;
  const type = document.getElementById('adminFormatType').value;
  const instructions = document.getElementById('adminFormatInstructions').value;
  const fileInput = document.getElementById('adminFormatFile');
  
  if (!type) return await PremiumModal.alert('El tipo es requerido');
  if (!id && (!fileInput.files || fileInput.files.length === 0)) {
    return await PremiumModal.alert('Debes subir un archivo .docx para crear un formato.');
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
      await PremiumModal.alert('Error al guardar el formato: ' + (data.error || 'Desconocido'));
    }
  } catch (err) { console.error(err); }
}

async function deleteAdminFormat() {
  const id = document.getElementById('adminFormatId').value;
  if (!id) return;
  if (!(await PremiumModal.confirm)('¿Seguro que deseas eliminar este formato?')) return;
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

window.deleteAdminFormatById = async function(id) {
  if (!id) return;
  if (typeof PremiumModal !== 'undefined') {
    if (!(await PremiumModal.confirm('¿Seguro que deseas eliminar este formato?'))) return;
  } else {
    if (!confirm('¿Seguro que deseas eliminar este formato?')) return;
  }
  try {
    const res = await fetch('/api/admin/formats/' + id, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + localStorage.getItem('planif_token') }
    });
    if (res.ok) {
      loadAdminFormats();
    }
  } catch (err) { console.error(err); }
};

window.deleteAdminUser = async function(id) {
  if (!(await PremiumModal.confirm)('¿Seguro que deseas eliminar a este usuario por completo? Se borrarán sus conversaciones también.')) return;
  try {
    const res = await fetch('/api/admin/users/' + id, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + localStorage.getItem('planif_token') }
    });
    if (res.ok) {
      loadAdminUsers();
      updateAdminDashboard();
    } else {
      await PremiumModal.alert('Error eliminando usuario. Puede que sea admin.');
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
    
    if (data.messages && data.messages.length > 0) {
      data.messages.forEach(m => {
        const div = document.createElement('div');
        div.style.padding = '10px';
        div.style.borderRadius = '8px';
        div.style.maxWidth = '80%';
        div.style.marginBottom = '5px';
        div.style.fontSize = '13px';
        div.style.wordBreak = 'break-word';
        if (m.role === 'user' || m.direction === 'incoming') {
          div.style.background = 'var(--primary)';
          div.style.color = '#fff';
          div.style.alignSelf = 'flex-end';
          div.style.marginLeft = 'auto';
        } else {
          div.style.background = 'var(--card)';
          div.style.color = 'var(--text)';
          div.style.border = '1px solid var(--border)';
        }
        div.innerText = m.content || m.message || '';
        view.appendChild(div);
      });
    } else {
      view.innerHTML = '<div style="text-align:center; margin-top:20px; color:var(--text-light);">No hay mensajes con este cliente.</div>';
    }
  } catch (err) {
    view.innerHTML = '<div style="text-align:center; margin-top:20px; color:red;">Error cargando el chat.</div>';
  }
}

function updateAdminDashboard() {
  const total = adminUsers.length;
  let activePro = 0, free = 0, exempt = 0, totalPlans = 0, monthlyRev = 0;
  
  const chartLabels = [];
  const chartData = [];
  const daysMap = {};

  adminUsers.forEach(u => {
    totalPlans += (u.plans_count || 0);
    if (u.plan === 'admin' || u.plan === 'exempt') exempt++;
    else if (u.plan === 'trial') free++;
    else activePro++;
    
    // Revenue calc approx
    if (u.plan === '1 Mes') monthlyRev += 395;
    if (u.plan === '3 Meses') monthlyRev += 1066 / 3;
    if (u.plan === '6 Meses') monthlyRev += 2014 / 6;
    if (u.plan === '1 Año') monthlyRev += 3792 / 12;

    const d = new Date(u.created_at || Date.now()).toLocaleDateString();
    daysMap[d] = (daysMap[d] || 0) + 1;
  });

  document.getElementById('dashTotalUsers').innerText = total;
  document.getElementById('dashActiveUsers').innerText = activePro;
  document.getElementById('dashFreeUsers').innerText = free;
  document.getElementById('dashExemptUsers').innerText = exempt;
  document.getElementById('dashConversations').innerText = totalPlans;
  document.getElementById('dashMRR').innerText = 'RD$ ' + Math.round(monthlyRev).toLocaleString();

  // Draw chart
  const last7Days = Array.from({length: 7}, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (6 - i));
    return d.toLocaleDateString();
  });

  last7Days.forEach(day => {
    chartLabels.push(day);
    chartData.push(daysMap[day] || 0);
  });

  const ctx = document.getElementById('adminUsersChart');
  if (ctx && window.Chart) {
    if (window.adminChart) window.adminChart.destroy();
    window.adminChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: chartLabels,
        datasets: [{
          label: 'Nuevos Usuarios',
          data: chartData,
          borderColor: '#38bdf8',
          backgroundColor: 'rgba(56, 189, 248, 0.2)',
          fill: true,
          tension: 0.4
        }]
      },
      options: { responsive: true, maintainAspectRatio: false }
    });
  }
}

async function selectAdminUser(userId) {
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
      
      const elFree = document.getElementById('dashFreeUsers');
      if(elFree) elFree.textContent = data.freeUsersCount || 0;
      
      const elExempt = document.getElementById('dashExemptUsers');
      if(elExempt) elExempt.textContent = data.exemptUsersCount || 0;
      
      const elAdmin = document.getElementById('dashAdminUsers');
      if(elAdmin) elAdmin.textContent = data.adminUsersCount || 0;

      document.getElementById('dashMRR').textContent = 'RD$ ' + (data.mrr || 0);
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
    await PremiumModal.alert('Escribe un mensaje para enviar.');
    return;
  }
  if (!(await PremiumModal.confirm)('¿Estás seguro de enviar esta difusión masiva a los usuarios seleccionados?')) return;
  
  try {
    const res = await fetch('/api/admin/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('planif_token') },
      body: JSON.stringify({ message, filter })
    });
    const data = await res.json();
    if (res.ok) {
      await PremiumModal.alert(data.message);
      document.getElementById('broadcastMessage').value = '';
    } else {
      await PremiumModal.alert(data.error || 'Error al enviar difusión');
    }
  } catch (err) {
    await PremiumModal.alert('Error de conexión');
  }
});

// --- FINANZAS LOGIC ---
window.initFinancePanel = function() {
  async function loadFinanceData() {
    try {
      const res = await fetch('/api/admin/finance', {
        headers: { 'Authorization': 'Bearer ' + localStorage.getItem('planif_token') }
      });
      if (!res.ok) return;
      const data = await res.json();
      
      const balanceEl = document.getElementById('financeBalance');
      if (balanceEl) balanceEl.textContent = '$' + (data.balance || 0).toFixed(4);
      
      const tbody = document.getElementById('financeLogsTableBody');
      if (!tbody) return;
      tbody.innerHTML = '';
      
      if (!data.logs || data.logs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="padding:15px; text-align:center; color:var(--text-muted);">No hay transacciones registradas aún.</td></tr>';
        return;
      }

      data.logs.forEach(log => {
        const isDeposit = log.deposit > 0;
        const tr = document.createElement('tr');
        const d = new Date(log.date);
        const dateStr = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'});
        
        const editBtn = isDeposit ? ` <span style="cursor:pointer; font-size:12px;" onclick="window.editFinanceDeposit('${log._id}', ${log.deposit})" title="Editar Recarga">✏️</span>` : '';
        const costStr = isDeposit ? '<span style="color:#10b981;">+$' + log.deposit.toFixed(2) + '</span>' + editBtn : '<span style="color:#ef4444;">-$' + (log.cost || 0).toFixed(6) + '</span>';
        
        tr.innerHTML = `
          <td style="padding:10px 15px; border-bottom:1px solid var(--border); white-space:nowrap;">${dateStr}</td>
          <td style="padding:10px 15px; border-bottom:1px solid var(--border);">${log.identifier || '-'}</td>
          <td style="padding:10px 15px; border-bottom:1px solid var(--border);">${log.action || '-'}</td>
          <td style="padding:10px 15px; border-bottom:1px solid var(--border);"><span style="background:var(--bg-hover); padding:2px 6px; border-radius:4px; font-size:11px;">${log.model || '-'}</span></td>
          <td style="padding:10px 15px; border-bottom:1px solid var(--border); text-align:right;">${(log.total_tokens || 0).toLocaleString()}</td>
          <td style="padding:10px 15px; border-bottom:1px solid var(--border); text-align:right; font-family:monospace; font-weight:bold;">${costStr}</td>
        `;
        tbody.appendChild(tr);
      });
    } catch (e) {
      console.error('Error fetching finance:', e);
    }
  }

  const refreshBtn = document.getElementById('financeRefreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', loadFinanceData);

  const depositBtn = document.getElementById('financeDepositBtn');
  if (depositBtn) {
    depositBtn.addEventListener('click', async () => {
      const input = document.getElementById('financeDepositInput');
      if (!input) return;
      const amount = parseFloat(input.value);
      if (isNaN(amount) || amount <= 0) {
        await PremiumModal.alert('Ingresa un monto válido para recargar.');
        return;
      }
      if (!(await PremiumModal.confirm)('¿Confirmas que has depositado $' + amount.toFixed(2) + ' en tu cuenta de OpenAI y deseas añadirlo al balance interno?')) return;

      try {
        const res = await fetch('/api/admin/finance/deposit', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + localStorage.getItem('planif_token')
          },
          body: JSON.stringify({ amount })
        });
        const data = await res.json();
        if (data.success) {
          input.value = '';
          loadFinanceData();
        } else {
          await PremiumModal.alert(data.error || 'Error al recargar');
        }
      } catch (err) {
        await PremiumModal.alert('Error de conexión');
      }
    });
  }

  window.editFinanceDeposit = async function(id, oldAmount) {
    const newVal = await PremiumModal.prompt('Ingresa el nuevo monto exacto de la recarga:', oldAmount);
    if (!newVal) return;
    const amount = parseFloat(newVal);
    if (isNaN(amount) || amount <= 0) return await PremiumModal.alert('Monto inválido.');
    
    try {
      const res = await fetch('/api/admin/finance/deposit/' + id, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + localStorage.getItem('planif_token')
        },
        body: JSON.stringify({ amount })
      });
      const data = await res.json();
      if (data.success) {
        loadFinanceData();
      } else {
        await PremiumModal.alert(data.error || 'Error al editar');
      }
    } catch (err) {
      await PremiumModal.alert('Error de conexión');
    }
  };

  loadFinanceData();
};

/* =========================================================================
   KNOWLEDGE PANEL
   ========================================================================= */
let allKnowledge = [];

window.initKnowledgePanel = async function() {
  await window.loadKnowledgeItems();
};

window.loadKnowledgeItems = async function() {
  const list = document.getElementById('knowledgeList');
  if (!list) return;
  try {
    const res = await api('GET', '/api/admin/knowledge');
    allKnowledge = res.items || [];
    
    window.renderKnowledgeItems(allKnowledge);
  } catch (e) {
    console.error(e);
    list.innerHTML = '<div style="color:red; padding:20px; text-align:center;">Error al cargar: ' + (e.message || e) + '</div>';
  }
};

window.renderKnowledgeItems = function(items) {
  const list = document.getElementById('knowledgeList');
  if (!list) return;
  if (items.length === 0) {
    list.innerHTML = '<div style="text-align:center; padding:40px; background:var(--card); border-radius:12px; border:1px dashed var(--border); color:var(--text-muted);">No hay conocimientos que coincidan.</div>';
    return;
  }
  
  list.innerHTML = items.map(k => `
    <div style="background:var(--card); border:1px solid var(--border); border-radius:12px; padding:15px; display:flex; justify-content:space-between; align-items:flex-start;">
      <div style="flex:1; overflow:hidden;">
        <div style="display:flex; align-items:center; gap:10px; margin-bottom:5px;">
          <h4 style="font-size:15px; margin:0; color:var(--text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${k.title}</h4>
        </div>
        <p style="font-size:12px; color:var(--text-muted); margin:0; margin-top:8px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;">
          ${k.content.replace(/</g, '&lt;')}
        </p>
      </div>
      <div style="display:flex; gap:8px; margin-left:15px;">
        <button onclick="window.editKnowledge('${k.id}')" style="background:rgba(255,255,255,0.1); color:var(--text); border:none; padding:6px 12px; border-radius:6px; cursor:pointer; font-size:12px;">Editar</button>
        <button onclick="window.deleteKnowledge('${k.id}')" style="background:rgba(239, 68, 68, 0.2); color:#fca5a5; border:none; padding:6px 12px; border-radius:6px; cursor:pointer; font-size:12px;">Eliminar</button>
      </div>
    </div>
  `).join('');
};

window.filterKnowledge = function() {
  const query = (document.getElementById('searchKnowledgeInput').value || '').toLowerCase();
  const filtered = allKnowledge.filter(k => 
    (k.title || '').toLowerCase().includes(query) || 
    (k.content || '').toLowerCase().includes(query)
  );
  window.renderKnowledgeItems(filtered);
};

window.openKnowledgeModal = function() {
  document.getElementById('kId').value = '';
  document.getElementById('kTitle').value = '';
  document.getElementById('kContent').value = '';
  const fileInput = document.getElementById('kFileInput');
  if (fileInput) fileInput.value = '';
  const fileStatus = document.getElementById('kFileStatus');
  if (fileStatus) fileStatus.style.display = 'none';
  document.getElementById('knowledgeModalTitle').textContent = 'Nuevo Conocimiento';
  document.getElementById('knowledgeModal').style.display = 'flex';
  document.getElementById('countKnowledge').innerText = '0 / 40000';
};

window.closeKnowledgeModal = function() {
  document.getElementById('knowledgeModal').style.display = 'none';
};

window.handleKnowledgeFileUpload = async function(event) {
  const file = event.target.files[0];
  if (!file) return;

  const statusEl = document.getElementById('kFileStatus');
  statusEl.style.display = 'block';
  statusEl.innerText = 'Extrayendo texto, por favor espera...';
  statusEl.style.color = 'var(--primary)';

  const formData = new FormData();
  formData.append('knowledgeFile', file);

  try {
    const res = await fetch('/api/admin/knowledge/extract', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + localStorage.getItem('planif_token') },
      body: formData
    });
    
    const data = await res.json();
    
    if (res.ok) {
      statusEl.innerText = 'Texto extraído correctamente.';
      statusEl.style.color = '#10b981';
      
      const contentEl = document.getElementById('kContent');
      contentEl.value = (contentEl.value + '\\n\\n' + data.text).trim();
      document.getElementById('countKnowledge').innerText = contentEl.value.length + ' / 40000';
      
      const titleEl = document.getElementById('kTitle');
      if (!titleEl.value) {
        titleEl.value = file.name.replace(/\\.[^/.]+$/, ""); // Quitar extensión
      }
    } else {
      statusEl.innerText = 'Error al extraer: ' + (data.error || 'Desconocido');
      statusEl.style.color = '#dc2626';
    }
  } catch (err) {
    console.error(err);
    statusEl.innerText = 'Error de conexión.';
    statusEl.style.color = '#dc2626';
  }
};

window.editKnowledge = function(id) {
  const k = allKnowledge.find(x => x.id === id);
  if (!k) return;
  document.getElementById('kId').value = k.id;
  document.getElementById('kTitle').value = k.title || '';
  document.getElementById('kContent').value = k.content || '';
  document.getElementById('knowledgeModalTitle').textContent = 'Editar Conocimiento';
  document.getElementById('knowledgeModal').style.display = 'flex';
  document.getElementById('countKnowledge').innerText = (k.content || '').length + ' / 4000';
};

window.saveKnowledge = async function() {
  const id = document.getElementById('kId').value;
  const title = document.getElementById('kTitle').value.trim();
  const content = document.getElementById('kContent').value.trim();
  
  if (!title || !content) {
    if (typeof PremiumModal !== 'undefined') await PremiumModal.alert('Título y Contenido son obligatorios');
    else alert('Título y Contenido son obligatorios');
    return;
  }
  
  try {
    if (id) {
      await api('PUT', '/api/admin/knowledge/' + id, { title, content });
    } else {
      await api('POST', '/api/admin/knowledge', { title, content });
    }
    window.closeKnowledgeModal();
    window.loadKnowledgeItems();
  } catch (e) {
    if (typeof PremiumModal !== 'undefined') await PremiumModal.alert('Error al guardar');
    else alert('Error al guardar');
  }
};

window.deleteKnowledge = async function(id) {
  let confirmDelete = false;
  if (typeof PremiumModal !== 'undefined') {
      confirmDelete = await PremiumModal.confirm('¿Seguro que deseas eliminar este conocimiento? La IA dejará de usarlo.');
  } else {
      confirmDelete = confirm('¿Seguro que deseas eliminar este conocimiento? La IA dejará de usarlo.');
  }
  
  if (!confirmDelete) return;
  
  try {
    await api('DELETE', '/api/admin/knowledge/' + id);
    window.loadKnowledgeItems();
  } catch (e) {
    if (typeof PremiumModal !== 'undefined') await PremiumModal.alert('Error al eliminar');
    else alert('Error al eliminar');
  }
};

/* =========================================================================
   SUPERVISOR PANEL
   ========================================================================= */

window.initSupervisorPanel = async function() {
  await window.loadSupervisorLogs();
  
  const toggle = document.getElementById('supervisorToggle');
  if (toggle && !toggle.hasAttribute('data-bound')) {
    toggle.setAttribute('data-bound', 'true');
    toggle.addEventListener('change', async (e) => {
      const enabled = e.target.checked;
      try {
        await api('POST', '/api/admin/settings/supervisor', { enabled });
        if (typeof PremiumModal !== 'undefined') await PremiumModal.alert(`Supervisor IA ${enabled ? 'Activado' : 'Desactivado'}`);
        else alert(`Supervisor IA ${enabled ? 'Activado' : 'Desactivado'}`);
      } catch (err) {
        if (typeof PremiumModal !== 'undefined') await PremiumModal.alert('Error guardando configuración');
        else alert('Error guardando configuración');
        e.target.checked = !enabled;
      }
    });
  }

  const saveBtn = document.getElementById('saveSupervisorRulesBtn');
  if (saveBtn && !saveBtn.hasAttribute('data-bound')) {
    saveBtn.setAttribute('data-bound', 'true');
    saveBtn.addEventListener('click', async () => {
      const rules = document.getElementById('supervisorRulesInput').value;
      try {
        await api('POST', '/api/admin/settings/supervisor', { rules });
        if (typeof PremiumModal !== 'undefined') await PremiumModal.alert('Reglas guardadas exitosamente.');
        else alert('Reglas guardadas exitosamente.');
      } catch (err) {
        if (typeof PremiumModal !== 'undefined') await PremiumModal.alert('Error guardando reglas');
        else alert('Error guardando reglas');
      }
    });
  }
};

window.loadSupervisorLogs = async function() {
  try {
    const res = await api('GET', '/api/admin/supervisor_logs');
    const toggle = document.getElementById('supervisorToggle');
    if (toggle) toggle.checked = res.enabled;
    const rulesInput = document.getElementById('supervisorRulesInput');
    if (rulesInput) {
      rulesInput.value = res.rules || `ERES EL SUPERVISOR DE CALIDAD Y SEGURIDAD DE PLANIXA.
Tu único objetivo es evaluar la respuesta del Asistente y corregirla SI Y SOLO SI incumple estas reglas críticas:

1. SEGURIDAD: El Asistente jamás debe responder preguntas de índole política, religiosa, o ajenas a la educación. Si lo hace, borra su respuesta y cámbiala por: "Lo siento, soy un asistente educativo y no estoy autorizado para conversar sobre ese tema."
2. TONO Y LENGUAJE: El lenguaje debe ser estrictamente formal, profesional, empático y pedagógico. Si detectas agresividad o lenguaje coloquial, reescribe la respuesta.
3. CURRÍCULO MINERD: Si el Asistente menciona leyes, áreas o grados que no pertenecen a República Dominicana, debes corregir la información.
4. FORMATO: Asegúrate de que las listas y títulos estén bien formateados en Markdown.

Si la respuesta original CUMPLE con todo, retorna el texto original intacto. Si incumple, retorna SÓLO la versión corregida.`;
      const countEl = document.getElementById('countSupervisor');
      if (countEl) countEl.innerText = rulesInput.value.length + ' / 4000';
    }
    const tbody = document.getElementById('supervisorLogsBody');
    if (!tbody) return;
    if (!res.logs || res.logs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:20px; color:var(--text-muted);">No hay correcciones registradas aún. El Asistente lo ha hecho todo perfecto o el supervisor está apagado.</td></tr>';
      return;
    }
    
    tbody.innerHTML = res.logs.map(log => `
      <tr style="border-bottom:1px solid var(--border);">
        <td style="padding:10px;">${new Date(log.date).toLocaleString()}</td>
        <td style="padding:10px;">${log.userId || 'Desconocido'}</td>
        <td style="padding:10px;" class="log-cell" title="${log.userRequest.replace(/"/g, '&quot;')}">${log.userRequest}</td>
        <td style="padding:10px; color:#ef4444;" class="log-cell" title="${log.draftResponse.replace(/"/g, '&quot;')}">${log.draftResponse}</td>
        <td style="padding:10px; color:#10b981;" class="log-cell" title="${log.correctedResponse.replace(/"/g, '&quot;')}">${log.correctedResponse}</td>
      </tr>
    `).join('');
    
  } catch (err) {
    console.error("Error cargando supervisor", err);
    const tbody = document.getElementById('supervisorLogsBody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:20px; color:red;">Error cargando registros.</td></tr>';
  }
};
