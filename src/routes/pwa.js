module.exports = function (app) {
    app.get('/manifest.json', (req, res) => {
        res.json({
            name: 'Planixa', short_name: 'Planixa',
            description: 'Asistente de planificación docente MINERD',
            start_url: '/', display: 'standalone', orientation: 'portrait',
            background_color: '#f8fafc', theme_color: '#1a56db',
            icons: [
                { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
                { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }
            ]
        });
    });

    app.get('/sw.js', (req, res) => {
        res.setHeader('Content-Type', 'application/javascript');
        res.setHeader('Cache-Control', 'no-cache');
        res.send(`
const CACHE = 'elprofe2-v1';
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(clients.claim()); });
self.addEventListener('fetch', e => {
    if (e.request.url.startsWith(self.location.origin) && e.request.method === 'GET') {
        e.respondWith(
            caches.open(CACHE).then(c => c.match(e.request).then(r => r || fetch(e.request).then(f => { c.put(e.request, f.clone()); return f; })))
        );
    }
});
`);
    });
};
