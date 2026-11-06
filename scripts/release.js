'use strict';
const { spawnSync } = require('child_process');
if (!process.env.CSC_LINK && !process.env.WIN_CSC_LINK) throw new Error('Public release signing is not configured. Set CSC_LINK (certificate path or base64) and CSC_KEY_PASSWORD in the release environment. A local private-CA certificate is not a publicly trusted publisher identity.');
const env = { ...process.env, ZER0NE_REQUIRE_SIGNED:'1' };
const result = spawnSync(process.execPath, ['scripts/validate.js'], { env, stdio:'inherit', windowsHide:true });
if (result.status !== 0) process.exit(Number.isInteger(result.status) ? result.status : 1);
// The signed installer wraps exactly the folder validation just tested.
const installer = spawnSync(process.execPath, ['scripts/installer.js', '--signed'], { env, stdio:'inherit', windowsHide:true });
process.exit(Number.isInteger(installer.status) ? installer.status : 1);
