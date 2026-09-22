import { app, ipcMain } from 'electron';

console.log('STEP1 electron app loaded:', typeof app, !!ipcMain);
console.log('STEP2 name:', app.getName());
app.quit();
