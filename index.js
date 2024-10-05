const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const port = process.env.PORT || 4000;

// Create an HTTP server and pass it to Socket.IO
const server = http.createServer(app);
const io = socketIo(server);

// Serve static files (like the HTML page)
app.use(express.static(path.join(__dirname, 'public')));

// Parse URL-encoded bodies (as sent by HTML forms)
app.use(express.urlencoded({ extended: true }));

// Parse JSON bodies (as sent by API clients)
app.use(express.json());

const sessions = {}; // To store session data

// Generate a random string of 30 characters
function generateSessionId() {
    return crypto.randomBytes(15).toString('hex');
}

// Create a new WhatsApp client session
function createNewClientSession(sessionId) {

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: sessionId }),
        puppeteer: { headless: true }
    });

    let qrCodeData = ''; // To store the QR code data URL
    let clientReady = false; // To check if the client is ready

    client.on('qr', (qr) => {
        console.log(`QR received for session ${sessionId}`);
        qrcode.toDataURL(qr, (err, url) => {
            if (err) {
                console.error('Failed to generate QR code:', err);
            } else {
                qrCodeData = url; // Store the QR code data URL
                console.log(`Generated QR code: ${qrCodeData}`); // Log the QR code URL
                clientReady = false;
                io.emit('qr', { sessionId, qrCodeData });
            }
        });
    });
    

    client.on('ready', () => {
        console.log(`WhatsApp client is ready for session ${sessionId}!`);
        qrCodeData = ''; // Clear QR code data after successful connection
        clientReady = true; // Client is ready
        io.emit('ready', { sessionId }); // Emit client ready event
    });

    client.on('authenticated', () => {
        console.log(`WhatsApp client authenticated for session ${sessionId}.`);
        io.emit('authenticated', { sessionId }); // Emit authenticated event
    });

    client.on('auth_failure', (msg) => {
        console.error(`Authentication failure for session ${sessionId}:`, msg);
        qrCodeData = ''; // Clear QR code data on failure
        io.emit('auth_failure', { sessionId, message: msg }); // Emit authentication failure event
    });

    client.on('disconnected', (reason) => {
        console.log(`WhatsApp client was disconnected for session ${sessionId}:`, reason);
        qrCodeData = ''; // Clear QR code data on disconnection
        clientReady = false; // Client is no longer ready
        io.emit('disconnected', { sessionId, reason }); // Emit disconnected event
    });

    client.initialize();

    // Store session data
    sessions[sessionId] = { client, qrCodeData, clientReady };

    return sessionId;
}

// Serve the QR code or the form based on client status
app.get('/qr/:sessionId', (req, res) => {
    const sessionId = req.params.sessionId;
    const session = sessions[sessionId];

    if (!session) {
        return res.status(404).send('Session not found.');
    }

    const { qrCodeData, clientReady } = session;

    if (clientReady) {
        res.redirect(`/send-message/${sessionId}`); // Redirect ke form pengiriman pesan jika sudah terkoneksi
    } else if (qrCodeData) {
        // Tampilkan QR code jika belum terkoneksi dan QR code tersedia
        res.send(`
            <html>
            <head>
                <meta http-equiv="refresh" content="5">
            </head>
            <body>
                <img src="${qrCodeData}" alt="Scan this QR code with WhatsApp" />
                <p>Silakan scan QR code dengan WhatsApp Anda.</p>
                <script src="/socket.io/socket.io.js"></script>
                <script>
                    const socket = io();

                    socket.on('ready', (data) => {
                        if (data.sessionId === '${sessionId}') {
                            window.location.href = '/send-message/${sessionId}';
                        }
                    });
                </script>
            </body>
            </html>
        `);
    } else {
        res.send('QR code belum tersedia. Silakan coba lagi nanti.');
    }
});


// Serve the message sending form
app.get('/send-message/:sessionId', (req, res) => {
    const sessionId = req.params.sessionId;
    const session = sessions[sessionId];

    if (!session || !session.clientReady) {
        return res.redirect(`/qr/${sessionId}`); // Redirect to the QR code page if the client is not ready
    }

    res.send(`
        <form action="/send-message/${sessionId}" method="POST">
            <label for="number">Phone Number:</label><br>
            <input type="text" id="number" name="number" placeholder="+6281234567890"><br><br>
            <label for="message">Message:</label><br>
            <textarea id="message" name="message" placeholder="Your message here"></textarea><br><br>
            <input type="submit" value="Send Message">
        </form>
        <br>
        <form action="/logout/${sessionId}" method="POST">
            <input type="submit" value="Logout">
        </form>
    `);
});

// Handle the form submission and send a message
app.post('/send-message/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;
    const session = sessions[sessionId];

    if (!session) {
        return res.status(404).send('Session not found.');
    }

    const { client } = session;
    const { number, message } = req.body;

    if (!number || !message) {
        return res.status(400).json({ status: 'error', message: 'Please provide both number and message.' });
    }

    // Ensure the number is in the correct format
    const formattedNumber = number.replace(/\D/g, ''); // Remove any non-numeric characters
    const chatId = formattedNumber + '@c.us';

    try {
        await client.sendMessage(chatId, message);
        console.log(`Message sent successfully in session ${sessionId}!`);

        // Redirect to the QR code page after sending the message
        res.redirect(`/qr/${sessionId}`);
    } catch (error) {
        console.error(`Failed to send message in session ${sessionId}:`, error);
        res.status(500).send('Failed to send message.');
    }
});

// API endpoint to log out and clear the session
app.post('/logout/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;
    const session = sessions[sessionId];

    if (!session) {
        return res.status(404).send('Session not found.');
    }

    try {
        const { client, sessionDir } = session;

        await client.logout(); // Log out from WhatsApp
        await client.destroy(); // Destroy the client instance

        // Clear the session directory
        if (fs.existsSync(sessionDir)) {
            fs.rmdirSync(sessionDir, { recursive: true });
            console.log(`Session directory ${sessionDir} cleared.`);
        }

        // Remove session data
        delete sessions[sessionId];

        res.status(200).json({ status: 'success', message: 'Logged out and session cleared. Scan a new QR code.' });
    } catch (error) {
        console.error(`Error during logout in session ${sessionId}:`, error);
        res.status(500).json({ status: 'error', message: 'Failed to log out.' });
    }
});

// Start the Express server with Socket.IO
server.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});

// Endpoint to start a new session
app.get('/start-session', (req, res) => {
    const sessionId = generateSessionId();
    createNewClientSession(sessionId);
    res.redirect(`/qr/${sessionId}`);
});
