const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Portable Workspace Management
const defaultWorkspace = path.join(process.env.USERPROFILE || process.env.HOME || 'C:', 'Documents', 'JzeroCompile');
let currentWorkspace = 'D:\\VS\\C Files'; // Preferred user path

// If the preferred path doesn't exist or we can't write to it, fallback to default
if (!fs.existsSync(currentWorkspace)) {
    currentWorkspace = defaultWorkspace;
}

// Ensure the directory exists
try {
    if (!fs.existsSync(currentWorkspace) || !fs.lstatSync(currentWorkspace).isDirectory()) {
        fs.mkdirSync(currentWorkspace, { recursive: true });
    }
} catch (e) {
    currentWorkspace = path.join(process.env.TEMP, 'JzeroCompile');
    if (!fs.existsSync(currentWorkspace)) fs.mkdirSync(currentWorkspace, { recursive: true });
}



app.get('/api/workspace', (req, res) => {
    res.json({ success: true, workspace: currentWorkspace });
});

app.post('/api/workspace', (req, res) => {
    const newDir = req.body.path;
    if (fs.existsSync(newDir)) {
        currentWorkspace = newDir;
        res.json({ success: true, workspace: currentWorkspace });
    } else {
        res.json({ success: false, error: 'Directory does not exist' });
    }
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

        // Sort: files first, then folders, both alphabetically
        results.sort((a, b) => {
            if (a.type !== b.type) {
                return a.type === 'file' ? -1 : 1;
            }
            return a.name.localeCompare(b.name);
        });

        return results;
    }
    res.json({ success: true, files: getTree(currentWorkspace), workspace: currentWorkspace });
});

app.post('/api/search', (req, res) => {
    const query = req.body.query.toLowerCase();
    let fileMatches = [];
    let folderMatches = [];
    let contentMatches = [];

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
                        folderMatches.push({ name: file, relPath, path: filePath, type: 'folder' });
                    }
                    searchDir(filePath);
                } else if (stat.isFile() && (file.endsWith('.c') || file.endsWith('.h') || file.endsWith('.txt'))) {
                    let matchedName = false;
                    if (file.toLowerCase().includes(query)) {
                        fileMatches.push({ name: file, relPath, path: filePath, type: 'file' });
                        matchedName = true;
                    }

                    if (!matchedName) {
                        try {
                            const content = fs.readFileSync(filePath, 'utf8');
                            if (content.toLowerCase().includes(query)) {
                                contentMatches.push({ name: file, relPath, path: filePath, type: 'file', contentMatch: true });
                            }
                        } catch (e) { }
                    }
                }
            }
        } catch (e) { }
    }
    searchDir(currentWorkspace);

    // Combine matches in requested order: file names > folder names > file contents
    const results = [...fileMatches, ...folderMatches, ...contentMatches];
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
        const filePath = path.join(__dirname, 'temp.c');
        const exePath = path.join(__dirname, 'temp.exe');

        // Remove old executable
        if (fs.existsSync(exePath)) {
            fs.unlinkSync(exePath);
        }

        let sourceCode = code;

        // Auto-inject setvbuf inside main() so printf() lines print immediately without needing \n, overriding default Windows C library buffering
        sourceCode = sourceCode.replace(/(?:int|void)\s+main\s*\([^)]*\)\s*\{/, match => {
            return match + '\n    setvbuf(stdout, NULL, _IONBF, 0);\n    setvbuf(stderr, NULL, _IONBF, 0);\n';
        });

        // Write code to temp.c
        fs.writeFileSync(filePath, sourceCode);

        socket.emit('output', 'Compiling...\r\n');

        // Compile using GCC
        const compileCmd = `C:\\MinGW\\bin\\gcc.exe "${filePath}" -o "${exePath}"`;
        exec(compileCmd, (err, stdout, stderr) => {
            if (err || (stderr && !fs.existsSync(exePath))) {
                socket.emit('compile_error', stderr || (err ? err.message : 'Unknown compilation error'));
                return;
            }

            if (stderr) {
                socket.emit('output', `\x1b[33mWarnings:\n${stderr}\x1b[0m\r\n`);
            }

            socket.emit('run_started');
            socket.emit('output', '\x1b[32mRunning...\x1b[0m\r\n-----------------------\r\n');

            // Spawn the executable
            currentProcess = spawn(exePath);

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

server.listen(PORT, () => {
    console.log(`God Tier C Compiler UI with dynamic IO running at http://localhost:${PORT}`);
});
