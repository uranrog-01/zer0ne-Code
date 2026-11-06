'use strict';
const { spawnSync } = require('child_process');
const env = require('../test/test-env').testEnv();
const result = spawnSync(process.execPath, ['test/app-smoke.js'], { env:{ ...env, ZER0NE_SMOKE_ONLY:'performance' }, stdio:'inherit', windowsHide:true });
process.exit(Number.isInteger(result.status) ? result.status : 1);
