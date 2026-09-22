try {
  const e = require('electron');
  console.log(
    'require("electron") =>',
    typeof e,
    JSON.stringify(typeof e === 'object' ? Object.keys(e).slice(0, 6) : String(e).slice(0, 80)),
  );
} catch (err) {
  console.log('require("electron") ERR:', err.message);
}

try {
  const e2 = require('node:electron');
  console.log(
    'require("node:electron") =>',
    typeof e2,
    JSON.stringify(typeof e2 === 'object' ? Object.keys(e2).slice(0, 6) : String(e2).slice(0, 80)),
  );
} catch (err) {
  console.log('require("node:electron") ERR:', err.message);
}

try {
  const e3 = require('electron/common');
  console.log('require("electron/common") =>', typeof e3);
} catch (err) {
  console.log('require("electron/common") ERR:', err.message);
}

require('electron').app?.quit();
