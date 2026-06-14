let adminUsers = [];
let adminActiveUserId = null;

// Initialize Admin Panel bindings
window.initAdminPanel = function() {
  const adminNavTab = document.getElementById('adminNavTab');
  if (adminNavTab) {
    adminNavTab.addEventListener('click', () => {
      loadAdminUsers();
    });
  }

  function switchAdminTab(activeTabId, activeViewId, callback) {
    const tabs = ['adminTabDash', 'adminTabUsers', 'adminTabManage', 'adminTabBroadcast', 'adminTabConfig'];
    const views = ['adminDashView', 'adminChatView', 'adminManageView', 'adminBroadcastView', 'adminPromptView'];
    
    tabs.forEach(tab => {
      const el = document.getElementById(tab);
      if(el) {
        if(tab === activeTabId) {
          el.style.background = 'var(--primary)';
          el.style.color = 'white';
        } else {
          el.style.background = 'var(--bg-hover)';
          el.style.color = 'var(--text)';
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
    
    if(callback) callback();
  }

  document.getElementById('adminTabDash')?.addEventListener('click', () => switchAdminTab('adminTabDash', 'adminDashView', loadAdminDashboard));
  document.getElementById('adminTabUsers')?.addEventListener('click', () => switchAdminTab('adminTabUsers', 'adminChatView'));
  document.getElementById('adminTabManage')?.addEventListener('click', () => switchAdminTab('adminTabManage', 'adminManageView', renderAdminManageTable));
  document.getElementById('adminTabBroadcast')?.addEventListener('click', () => switchAdminTab('adminTabBroadcast', 'adminBroadcastView'));
  document.getElementById('adminTabConfig')?.addEventListener('click', () => switchAdminTab('adminTabConfig', 'adminPromptView', loadAdminConfig));


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

  document.getElementById('adminSavePromptBtn')?.addEventListener('click', async () => {
    const prompt = document.getElementById('adminPromptTextarea').value;
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('planif_token') },
        body: JSON.stringify({ system_prompt: prompt })
      });
      if (res.ok) alert('Prompt guardado exitosamente.');
      else alert('Error al guardar config');
    } catch (err) {
      alert('Error: ' + err.message);
    }
  });

  // Admin AI Chat
  document.getElementById('adminAiSendBtn')?.addEventListener('click', sendAdminAiMessage);
  document.getElementById('adminAiInput')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendAdminAiMessage();
  });
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

async function loadAdminConfig() {
  try {
    const res = await fetch('/api/admin/settings', {
      headers: { 'Authorization': 'Bearer ' + localStorage.getItem('planif_token') }
    });
    if (res.ok) {
      const data = await res.json();
      document.getElementById('adminPromptTextarea').value = data.system_prompt;
    }
  } catch (err) {
    console.error('Error cargando settings', err);
  }
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
