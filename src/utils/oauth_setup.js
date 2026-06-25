const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const TOKEN_PATH = path.join(__dirname, '../../oauth-token.json');

async function setupOAuth() {
    const credentialsPath = path.join(__dirname, '../../client_secret.json');
    if (!fs.existsSync(credentialsPath)) {
        console.log('Coloca el archivo client_secret.json (descargado de GCP) en la raíz del proyecto.');
        console.log('O crea un archivo con este formato:');
        console.log(JSON.stringify({
            web: {
                client_id: 'tu-client-id.apps.googleusercontent.com',
                client_secret: 'tu-client-secret',
                redirect_uris: ['urn:ietf:wg:oauth:2.0:oob', 'http://localhost']
            }
        }, null, 2));
        return;
    }

    const credentials = JSON.parse(fs.readFileSync(credentialsPath));
    const { client_id, client_secret } = credentials.installed || credentials.web;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, 'urn:ietf:wg:oauth:2.0:oob');

    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        prompt: 'consent'
    });

    console.log('\n1. Abre este enlace en tu navegador:');
    console.log(authUrl);
    console.log('\n2. Inicia sesión con planixaasistente@gmail.com');
    console.log('3. Copia el código que te da Google y pégalo aquí:\n');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const code = await new Promise(resolve => rl.question('Código: ', resolve));
    rl.close();

    const { tokens } = await oAuth2Client.getToken(code);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
    console.log('\n✅ Token guardado en oauth-token.json');
    console.log('El refresh token no expira. Ya puedes generar planificaciones.');
}

setupOAuth().catch(console.error);
