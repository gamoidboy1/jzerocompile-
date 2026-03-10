const { app, BrowserWindow } = require('electron');
const path = require('path');
// Start the Express server
require('./server.js');

function createWindow() {
    const mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        icon: path.join(__dirname, 'public/assets/logo.png'), // Will fallback to default if not present
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    // Remove the menu bar for a cleaner "app" experience
    mainWindow.setMenuBarVisibility(false);

    // Give the server time to start up and retry if it fails
    const loadApp = () => {
        mainWindow.loadURL('http://localhost:3000').catch(() => {
            console.log("Server not ready, retrying...");
            setTimeout(loadApp, 500);
        });
    };

    setTimeout(loadApp, 1500);

    // Handle closing behavior
    mainWindow.on('closed', function () {
        app.quit();
    });
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
});
