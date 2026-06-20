window.switchWfTab = function(tabName) {
  ['Core', 'Bg', 'Admin'].forEach(t => {
    const btn = document.getElementById('wfTab' + t);
    const view = document.getElementById('wfView' + t);
    if(btn && view) {
      if(t === tabName) {
        btn.style.color = 'var(--primary)';
        btn.style.fontWeight = 'bold';
        btn.style.borderBottom = '2px solid var(--primary)';
        view.style.display = 'block';
      } else {
        btn.style.color = 'var(--text-light)';
        btn.style.fontWeight = 'normal';
        btn.style.borderBottom = '2px solid transparent';
        view.style.display = 'none';
      }
    }
  });
};

window.loadAdminWorkflows = function() {
  const coreList = document.getElementById('workflowsCoreList');
  const bgList = document.getElementById('workflowsBgList');
  if (!coreList || !bgList) return;

  coreList.innerHTML = `
    <div style="background:rgba(16, 185, 129, 0.1); border:1px solid #10b981; border-radius:8px; padding:15px; position:relative;">
      <h4 style="margin:0 0 5px 0; color:#10b981; font-size:15px;">1. Interacción con el Docente (Planixa)</h4>
      <p style="margin:0; font-size:13px; color:var(--text-light);">El docente escribe su petición. Planixa utiliza sus prompts iniciales para recopilar la información necesaria de acuerdo a las plantillas disponibles. Si todo está correcto, Planixa llama a la función interna <code>consultar_especialista</code>.</p>
      <div style="position:absolute; bottom:-18px; left:50%; width:2px; height:18px; background:var(--border);"></div>
      <div style="position:absolute; bottom:-23px; left:50%; transform:translateX(-50%); color:var(--text-muted);">⬇️</div>
    </div>
    
    <div style="background:rgba(56, 189, 248, 0.1); border:1px solid #38bdf8; border-radius:8px; padding:15px; position:relative; margin-top:20px;">
      <h4 style="margin:0 0 5px 0; color:#38bdf8; font-size:15px;">2. Servidor Back-Office (Especialista)</h4>
      <p style="margin:0; font-size:13px; color:var(--text-light);">El servidor recibe el paquete de información. Despierta al <strong>Especialista Pedagógico</strong> (segunda IA) sin que el usuario lo vea. El Especialista analiza la información enviada por Planixa, estructura el contenido pedagógico completo, y devuelve un <code>.json</code> estructurado con todas las variables requeridas por la plantilla seleccionada.</p>
      <div style="position:absolute; bottom:-18px; left:50%; width:2px; height:18px; background:var(--border);"></div>
      <div style="position:absolute; bottom:-23px; left:50%; transform:translateX(-50%); color:var(--text-muted);">⬇️</div>
    </div>

    <div style="background:rgba(245, 158, 11, 0.1); border:1px solid #f59e0b; border-radius:8px; padding:15px; position:relative; margin-top:20px;">
      <h4 style="margin:0 0 5px 0; color:#f59e0b; font-size:15px;">3. Compilación y Respuesta (Docxtemplater)</h4>
      <p style="margin:0; font-size:13px; color:var(--text-light);">El servidor toma el <code>.json</code> generado por el Especialista, lo inyecta en la plantilla <code>.docx</code> correspondiente usando Docxtemplater, guarda el archivo generado y le envía la ruta final de vuelta a Planixa. Finalmente, Planixa le entrega el documento terminado al Docente.</p>
    </div>
  `;

  bgList.innerHTML = `
    <div style="background:var(--card); border:1px solid var(--border); border-radius:8px; padding:15px;">
      <h4 style="margin:0 0 5px 0; color:var(--primary); font-size:14px;">🛠️ Extraer Variables DOCX</h4>
      <p style="margin:0; font-size:12px; color:var(--text-muted);">Cuando se sube una nueva plantilla desde el panel de Formatos, el servidor la procesa con <code>docxtemplater</code> en modo inspector, extrayendo las etiquetas {{variable}} y guardándolas en la base de datos automáticamente.</p>
    </div>
    <div style="background:var(--card); border:1px solid var(--border); border-radius:8px; padding:15px;">
      <h4 style="margin:0 0 5px 0; color:var(--primary); font-size:14px;">📡 Orquestador de Prompts</h4>
      <p style="margin:0; font-size:12px; color:var(--text-muted);">El sistema alimenta constantemente a Planixa y al Especialista con los prompts definidos en la base de datos (System Instructions), asegurando que siempre tengan su comportamiento actualizado.</p>
    </div>
  `;

  const adminList = document.getElementById('workflowsAdminList');
  if (adminList) {
    adminList.innerHTML = `
      <div style="background:var(--card); border:1px solid var(--border); border-radius:8px; padding:15px; border-top:3px solid #10b981;">
        <h4 style="margin:0 0 5px 0; color:#10b981; font-size:14px;">💳 Flujo de Pagos y Suscripciones</h4>
        <p style="margin:0; font-size:12px; color:var(--text-muted);">Verifica las transferencias y pagos aprobados. Actualiza automáticamente el estado de la cuenta del usuario, eliminando límites y activando su plan Premium/Ilimitado en la base de datos sin requerir intervención manual constante.</p>
      </div>
      <div style="background:var(--card); border:1px solid var(--border); border-radius:8px; padding:15px; border-top:3px solid #3b82f6;">
        <h4 style="margin:0 0 5px 0; color:#3b82f6; font-size:14px;">📢 Difusión Masiva (Broadcast)</h4>
        <p style="margin:0; font-size:12px; color:var(--text-muted);">Un agente encolador que toma los mensajes de anuncio globales y los despacha progresivamente a los WhatsApp de todos los usuarios filtrados, evitando bloqueos por spam o sobrecarga de los servicios de mensajería externa.</p>
      </div>
      <div style="background:var(--card); border:1px solid var(--border); border-radius:8px; padding:15px; border-top:3px solid #f59e0b;">
        <h4 style="margin:0 0 5px 0; color:#f59e0b; font-size:14px;">🧠 Gestión de Memoria y Perfil</h4>
        <p style="margin:0; font-size:12px; color:var(--text-muted);">Un flujo paralelo, asíncrono y silencioso donde Planixa analiza el contexto conversacional, extrayendo datos clave (nombre, materia, curso) para actualizar el perfil del usuario dinámicamente, permitiéndole "recordarlo" en el futuro.</p>
      </div>
    `;
  }
};
