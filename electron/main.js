const { app, BrowserWindow, ipcMain, shell, screen } = require('electron')
const path = require('path')
const { spawn } = require('child_process')

let mainWindow
let overlayWindow
let backendProcess

function startBackend() {
  console.log('[Electron] Starting backend server...')
  const backendPath = path.join(__dirname, '../backend')

  backendProcess = spawn('node', ['server.js'], {
    cwd: backendPath,
    env: { ...process.env },
    stdio: 'pipe'
  })

  backendProcess.stdout.on('data', (data) => {
    console.log('[Backend]', data.toString().trim())
  })

  backendProcess.stderr.on('data', (data) => {
    console.error('[Backend Error]', data.toString().trim())
  })

  backendProcess.on('exit', (code) => {
    console.log('[Backend] Exited with code:', code)
  })
}

function createOverlay() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize

  const W = 280
  const H = 48
  const MARGIN = 16

  overlayWindow = new BrowserWindow({
    width: W,
    height: H,
    x: width - W - MARGIN,
    y: height - H - MARGIN,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    focusable: false,
    hasShadow: false,
    type: 'panel',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    }
  })

  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  overlayWindow.setIgnoreMouseEvents(true)
  overlayWindow.setVisibleOnAllWorkspaces(true)

  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'))

  overlayWindow.on('closed', () => { overlayWindow = null })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#080a0e',
    titleBarStyle: 'hiddenInset',
    frame: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, 'icon.png')
  })

  const isDev = process.env.NODE_ENV === 'development'
  if (isDev) {
    mainWindow.loadURL('http://localhost:3000')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../frontend/out/index.html'))
  }

  mainWindow.on('closed', () => { mainWindow = null })
}

app.whenReady().then(() => {
  startBackend()
  setTimeout(() => {
    createWindow()
    createOverlay()
  }, 1500)
})

app.on('window-all-closed', () => {
  if (backendProcess) backendProcess.kill()
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

// Window controls via IPC
ipcMain.on('window-minimize', () => mainWindow?.minimize())
ipcMain.on('window-maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.restore()
  else mainWindow?.maximize()
})
ipcMain.on('window-close', () => mainWindow?.close())

// Open external URLs in browser
ipcMain.on('open-external', (_, url) => shell.openExternal(url))