// Mock electron module for unit tests (main process code imports 'electron')
export const app = {
  getPath: (name: string) => {
    if (name === 'userData') return process.env.TEST_USER_DATA || '/tmp/splashmeet-test'
    return '/tmp'
  },
}

export const BrowserWindow = {}
export const shell = {}
export const ipcMain = { handle: () => {} }
export const dialog = {}
export const nativeImage = { createFromPath: () => ({}) }
export const Menu = { buildFromTemplate: () => ({}), setApplicationMenu: () => {} }
