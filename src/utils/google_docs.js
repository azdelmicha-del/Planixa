const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

const CREDENTIALS_PATH = path.join(__dirname, '../../google-credentials.json');
const TOKEN_PATH = path.join(__dirname, '../../oauth-token.json');

async function getAuth() {
    let clientId, clientSecret, tokens;

    // 1. Intentar con archivos locales (desarrollo)
    if (fs.existsSync(TOKEN_PATH) && fs.existsSync(path.join(__dirname, '../../client_secret.json'))) {
        tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
        const creds = JSON.parse(fs.readFileSync(path.join(__dirname, '../../client_secret.json'), 'utf8'));
        const c = creds.installed || creds.web;
        clientId = c.client_id;
        clientSecret = c.client_secret;
    }

    // 2. Intentar con variables de entorno (producción en Render)
    if (!clientId && process.env.GOOGLE_CLIENT_ID) {
        clientId = process.env.GOOGLE_CLIENT_ID;
        clientSecret = process.env.GOOGLE_CLIENT_SECRET;
        tokens = { refresh_token: process.env.GOOGLE_REFRESH_TOKEN };
    }

    if (!clientId) {
        // 3. Fallback: service account
        if (fs.existsSync(CREDENTIALS_PATH)) {
            const auth = new google.auth.GoogleAuth({
                keyFile: CREDENTIALS_PATH,
                scopes: ['https://www.googleapis.com/auth/drive']
            });
            return auth.getClient();
        }
        throw new Error('No hay credenciales de Google Cloud. Crea oauth-token.json, setea GOOGLE_CLIENT_ID o usa google-credentials.json');
    }

    const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret, 'urn:ietf:wg:oauth:2.0:oob');
    oAuth2Client.setCredentials(tokens);

    if (tokens.expiry_date && tokens.expiry_date < Date.now()) {
        try {
            const { credentials } = await oAuth2Client.refreshAccessToken();
            if (fs.existsSync(TOKEN_PATH)) {
                fs.writeFileSync(TOKEN_PATH, JSON.stringify(credentials));
            }
            oAuth2Client.setCredentials(credentials);
        } catch (refreshErr) {
            console.error('Error renovando token OAuth:', refreshErr.message);
        }
    }

    return oAuth2Client;
}

async function createDocxFromHtml(htmlContent, fileName) {
    const auth = await getAuth();
    const drive = google.drive({ version: 'v3', auth });

    const fileMetadata = {
        name: fileName,
        mimeType: 'application/vnd.google-apps.document'
    };
    const media = {
        mimeType: 'text/html',
        body: htmlContent
    };

    const doc = await drive.files.create({
        resource: fileMetadata,
        media: media,
        fields: 'id',
        supportsAllDrives: true
    });

    const docId = doc.data.id;

    const exportResp = await drive.files.export({
        fileId: docId,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    }, { responseType: 'stream' });

    const chunks = [];
    for await (const chunk of exportResp.data) {
        chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    try {
        await drive.files.delete({ fileId: docId, supportsAllDrives: true });
    } catch (e) {
        console.error('Error deleting temp Google Doc:', e);
    }

    return buffer;
}

module.exports = { createDocxFromHtml };
