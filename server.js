const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const args = process.argv.slice(2);
const portArg = args.findIndex(arg => arg === '--port' || arg === '-p');
const PORT = portArg !== -1 && args[portArg + 1] ? parseInt(args[portArg + 1]) : 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Portable Workspace Management
const appDataPath = process.env.APPDATA || (process.platform === 'darwin' ? process.env.HOME + '/Library/Preferences' : process.env.HOME + '/.config');
const configDir = path.join(appDataPath, 'JzeroCompiler');
const configPath = path.join(configDir, 'config.json');

const downloadsPath = path.join(process.env.USERPROFILE || process.env.HOME || 'C:', 'Downloads');
const defaultWorkspace = path.join(downloadsPath, 'C Programs');

let currentWorkspace = defaultWorkspace;

// Ensure config directory exists
if (!fs.existsSync(configDir)) {
    try { fs.mkdirSync(configDir, { recursive: true }); } catch(e) {}
}

// Load persisted workspace if available
if (fs.existsSync(configPath)) {
    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (config.workspace) {
            // Even if it Doesn't exist, we keep it as the "intended" path and handle errors in file listing
            currentWorkspace = config.workspace;
        }
    } catch (e) {
        console.error("Failed to load config:", e);
    }
}

function saveConfig() {
    try {
        if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify({ workspace: currentWorkspace }, null, 2));
    } catch (e) {
        console.error("Failed to save config:", e);
    }
}

// Fallback: Ensure current workspace (at least the default one) exists
if (!fs.existsSync(currentWorkspace)) {
    try { fs.mkdirSync(currentWorkspace, { recursive: true }); } catch(e) {}
}

app.get('/api/workspace', (req, res) => {
    res.json({ success: true, workspace: currentWorkspace });
});

app.post('/api/workspace', (req, res) => {
    let newDir = req.body.path;
    
    // Smartly interpret path: remove quotes if the user pasted it from Windows "Copy as Path"
    if (newDir) {
        newDir = newDir.replace(/"/g, '').trim();
    }

    // Default to Downloads if none provided
    if (!newDir || newDir === "") {
        newDir = defaultWorkspace;
    }

    if (!fs.existsSync(newDir)) {
        try {
            fs.mkdirSync(newDir, { recursive: true });
        } catch(e) {
            return res.json({ success: false, error: 'Could not create directory: ' + e.message });
        }
    }
    
    currentWorkspace = newDir;
    saveConfig(); // Persist the new choice
    res.json({ success: true, workspace: currentWorkspace });
});

app.get('/api/files', (req, res) => {
    function getTree(dir) {
        let results = [];
        try {
            if (!fs.existsSync(dir)) return results;
            const files = fs.readdirSync(dir);
            for (const file of files) {
                const filePath = path.join(dir, file);
                const stat = fs.statSync(filePath);
                if (stat.isDirectory() && file !== '.git' && file !== 'node_modules') {
                    results.push({ name: file, type: 'folder', path: filePath, relPath: path.relative(currentWorkspace, filePath).replace(/\\/g, '/'), children: getTree(filePath) });
                } else if (stat.isFile() && (file.endsWith('.c') || file.endsWith('.h') || file.endsWith('.txt'))) {
                    results.push({ name: file, type: 'file', path: filePath, relPath: path.relative(currentWorkspace, filePath).replace(/\\/g, '/') });
                }
            }
        } catch (e) { }

        // Sort: folders first, then files by priority (C files > headers > text)
        results.sort((a, b) => {
            if (a.type !== b.type) {
                return a.type === 'folder' ? -1 : 1;
            }
            
            // For files, further prioritize based on extension
            if (a.type === 'file') {
                const getPriority = (name) => {
                    const ext = name.toLowerCase().split('.').pop();
                    if (ext === 'c') return 1;
                    if (ext === 'h') return 2;
                    if (ext === 'txt') return 3;
                    return 4;
                };
                const pA = getPriority(a.name);
                const pB = getPriority(b.name);
                if (pA !== pB) return pA - pB;
            }
            
            return a.name.localeCompare(b.name);
        });

        return results;
    }
    res.json({ success: true, files: getTree(currentWorkspace), workspace: currentWorkspace });
});

app.post('/api/search', (req, res) => {
    const query = req.body.query.toLowerCase();
    let results = [];

    function searchDir(dir) {
        try {
            if (!fs.existsSync(dir)) return;
            const files = fs.readdirSync(dir);
            for (const file of files) {
                const filePath = path.join(dir, file);
                const stat = fs.statSync(filePath);
                const relPath = path.relative(currentWorkspace, filePath).replace(/\\/g, '/');

                if (stat.isDirectory() && file !== '.git' && file !== 'node_modules') {
                    if (file.toLowerCase().includes(query)) {
                        results.push({ name: file, relPath, path: filePath, type: 'folder', priority: 1 });
                    }
                    searchDir(filePath);
                } else if (stat.isFile() && (file.endsWith('.c') || file.endsWith('.h') || file.endsWith('.txt'))) {
                    if (file.toLowerCase().includes(query)) {
                        results.push({ name: file, relPath, path: filePath, type: 'file', priority: 2 });
                    } else {
                        try {
                            const content = fs.readFileSync(filePath, 'utf8');
                            if (content.toLowerCase().includes(query)) {
                                results.push({ name: file, relPath, path: filePath, type: 'file', contentMatch: true, priority: 3 });
                            }
                        } catch (e) { }
                    }
                }
            }
        } catch (e) { }
    }
    searchDir(currentWorkspace);

    // Sort: Folders > File Names > Content Matches, then alphabetical
    results.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.name.localeCompare(b.name);
    });

    res.json({ success: true, results });
});



app.post('/api/read', (req, res) => {
    try {
        const filePath = req.body.path;
        res.json({ success: true, content: fs.readFileSync(filePath, 'utf8') });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.post('/api/save', (req, res) => {
    try {
        const filePath = req.body.path;
        const code = req.body.code;
        fs.writeFileSync(filePath, code);
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.post('/api/create', (req, res) => {
    try {
        const type = req.body.type;
        const parentPath = req.body.parentPath;
        const name = req.body.name;
        const targetPath = path.join(parentPath, name);
        if (type === 'folder') {
            fs.mkdirSync(targetPath, { recursive: true });
        } else {
            fs.writeFileSync(targetPath, '');
        }
        res.json({ success: true, path: targetPath });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.post('/api/rename', (req, res) => {
    try {
        const oldPath = req.body.oldPath;
        const newName = req.body.newName;
        const newPath = path.join(path.dirname(oldPath), newName);
        fs.renameSync(oldPath, newPath);
        res.json({ success: true, path: newPath });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.post('/api/delete', (req, res) => {
    try {
        const targetPath = req.body.path;
        const stat = fs.statSync(targetPath);
        if (stat.isDirectory()) {
            fs.rmSync(targetPath, { recursive: true, force: true });
        } else {
            fs.unlinkSync(targetPath);
        }
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

io.on('connection', (socket) => {
    let currentProcess = null;
    let activityTimeout = null;

    function resetActivityTimeout() {
        if (activityTimeout) {
            clearTimeout(activityTimeout);
        }
        if (currentProcess) {
            activityTimeout = setTimeout(() => {
                if (currentProcess) {
                    currentProcess.kill();
                    socket.emit('run_finished', '\r\n\x1b[31m[Process forcefully terminated due to 30 seconds of inactivity]\x1b[0m\r\n');
                    currentProcess = null;
                }
            }, 30000);
        }
    }

    socket.on('compile_and_run', (data) => {
        const code = data.code;
        const clientFilePath = data.filePath; // Path from client (may be null)
        
        let workingDir = __dirname;
        let sourcePath = path.join(__dirname, 'temp.c');
        let exePath = path.join(__dirname, 'temp.exe');

        if (clientFilePath) {
            workingDir = path.dirname(clientFilePath);
            const fileName = path.basename(clientFilePath, '.c');
            sourcePath = path.join(workingDir, `_run_${fileName}.c`); // Temp file for injection
            exePath = path.join(workingDir, `${fileName}.exe`);
        }

        // Remove old executable from the target path
        if (fs.existsSync(exePath)) {
            try { fs.unlinkSync(exePath); } catch (e) {}
        }

        let sourceCode = code;

        // Auto-inject setvbuf inside main() so printf() lines print immediately without needing \n, overriding default Windows C library buffering
        sourceCode = sourceCode.replace(/(?:int|void)\s+main\s*\([^)]*\)\s*\{/, match => {
            return match + '\n    setvbuf(stdout, NULL, _IONBF, 0);\n    setvbuf(stderr, NULL, _IONBF, 0);\n';
        });

        // Write injected code to the temp source path
        fs.writeFileSync(sourcePath, sourceCode);

        socket.emit('output', 'Compiling...\r\n');

        // Compile using GCC
        const compileCmd = `C:\\MinGW\\bin\\gcc.exe "${sourcePath}" -o "${exePath}"`;
        exec(compileCmd, { cwd: workingDir }, (err, stdout, stderr) => {
            // Clean up the temp runner file immediately after compile starts/fails
            if (clientFilePath && fs.existsSync(sourcePath)) {
                try { fs.unlinkSync(sourcePath); } catch (e) {}
            }

            if (err || (stderr && !fs.existsSync(exePath))) {
                socket.emit('compile_error', stderr || (err ? err.message : 'Unknown compilation error'));
                return;
            }

            if (stderr) {
                socket.emit('output', `\x1b[33mWarnings:\n${stderr}\x1b[0m\r\n`);
            }

            socket.emit('run_started');
            socket.emit('output', '\x1b[32mRunning...\x1b[0m\r\n-----------------------\r\n');

            // Spawn the executable in its directory
            currentProcess = spawn(exePath, [], { cwd: workingDir });

            currentProcess.stdout.on('data', (data) => {
                resetActivityTimeout();
                socket.emit('output', data.toString().replace(/\n/g, '\r\n'));
            });

            currentProcess.stderr.on('data', (data) => {
                resetActivityTimeout();
                socket.emit('output', '\x1b[31m' + data.toString().replace(/\n/g, '\r\n') + '\x1b[0m');
            });

            currentProcess.on('close', (code) => {
                if (activityTimeout) clearTimeout(activityTimeout);
                socket.emit('run_finished', `\r\n\x1b[33m[Process exited with code ${code}]\x1b[0m\r\n`);
                currentProcess = null;
            });

            currentProcess.on('error', (err) => {
                socket.emit('output', `\r\n\x1b[31m[Error: ${err.message}]\x1b[0m\r\n`);
            });

            // Start the idle timeout
            resetActivityTimeout();
        });
    });

    socket.on('input', (data) => {
        resetActivityTimeout();
        if (currentProcess && currentProcess.stdin) {
            currentProcess.stdin.write(data);
        }
    });

    socket.on('stop_process', () => {
        if (currentProcess) {
            currentProcess.kill();
            socket.emit('run_finished', '\r\n\x1b[33m[Process forcefully stopped by user]\x1b[0m\r\n');
            currentProcess = null;
        }
    });

    socket.on('disconnect', () => {
        if (currentProcess) {
            currentProcess.kill();
        }
    });
});

server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
        console.log(`Port ${PORT} is already in use. Likely another instance is running.`);
    } else {
        console.error("Server error:", e);
    }
});

server.listen(PORT, () => {
    console.log(`God Tier C Compiler UI with dynamic IO running at http://localhost:${PORT}`);
    
    // Auto-open browser in standalone mode (only if not running in Electron)
    if (!process.versions.electron) {
        const start = (process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open');
        exec(`${start} http://localhost:${PORT}`);
    }
});
