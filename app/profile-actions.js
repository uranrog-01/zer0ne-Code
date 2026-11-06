'use strict';
const path = require('path');
const { app, dialog, safeStorage } = require('electron');
const paths = require('./paths');
const { createBackup, readBackup, restoreBackup } = require('./profile-backup');

async function run(shell, win, restore) {
	if (shell.profileOperation) throw new Error('A profile operation is already in progress.');
	const busy = () => [...shell.windows].some(window => window.retainsWork() || window.pending);
	if (busy()) throw new Error('Finish or stop running agents, terminals, Remote and Local Host before backing up or restoring the profile.');
	shell.profileOperation = true;
	let stopped = false;
	try {
		const choice = restore
			? await dialog.showOpenDialog(win, { title:'Restore zer0ne profile', properties:['openFile'], filters:[{name:'zer0ne profile backup', extensions:['zcbackup']}] })
			: await dialog.showSaveDialog(win, { title:'Back up zer0ne profile', defaultPath:path.join(app.getPath('documents'), 'zer0ne-profile-' + new Date().toISOString().slice(0,10) + '.zcbackup'), filters:[{name:'zer0ne profile backup', extensions:['zcbackup']}] });
		const file = restore ? choice.filePaths?.[0] : choice.filePath;
		if (choice.canceled || !file) return { cancelled:true };
		const options = { safe:safeStorage, appVersion:app.getVersion() };
		const preview = restore ? await readBackup(file, options) : null;
		const confirmation = await dialog.showMessageBox(win, {
			type:'warning', title:restore ? 'Restore profile and restart?' : 'Back up profile and restart?',
			message:restore ? 'Replace this app’s saved chats, settings, memories and checkpoints?' : 'Save this app’s chats, settings, memories and checkpoints?',
			detail:(restore ? `${preview.files.length} files from ${preview.createdAt}. A recovery copy of the current profile is kept under the profile’s backups folder. ${preview.credentials === 'os-account' ? 'Saved sign-ins will be replaced; their OS protection was verified for this account.' : 'Saved sign-in files are excluded; existing credentials on this computer are retained.'}` : 'Project files, local model downloads and caches are excluded. Backups contain private conversations and settings; store them privately. Saved sign-in files are excluded unless you choose to include them. Included sign-ins can only be restored by the operating-system account that protected them.') + '\n\nThe app restarts to finish with a consistent profile.',
			buttons:['Cancel', restore ? 'Restore and restart' : 'Back up and restart'], defaultId:0, cancelId:0,
			...(!restore ? { checkboxLabel:'Include OS-protected saved sign-ins (this OS account only)', checkboxChecked:false } : {})
		});
		if (confirmation.response !== 1) return { cancelled:true };
		if (busy()) throw new Error('Work started while the dialog was open. Finish it before trying again.');
		for (const window of shell.windows) window.rememberSize();
		stopped = true; await Promise.all([...shell.windows].map(window => window.stopAll()));
		if (restore) { await restoreBackup(paths.configDir(), file, options); shell.profileRestored = true; }
		else await createBackup(paths.configDir(), file, { ...options, credentials:confirmation.checkboxChecked === true });
		await dialog.showMessageBox(win, { type:'info', message:restore ? 'Profile restored. Restarting zer0ne Code.' : 'Profile backup saved. Restarting zer0ne Code.', buttons:['Restart'] });
		return { ok:true };
	} catch (error) {
		await dialog.showMessageBox(win, { type:'error', message:restore ? 'Profile restore failed' : 'Profile backup failed', detail:error.message, buttons:['OK'] });
		return { ok:false, error:error.message };
	} finally {
		shell.profileOperation = false;
		if (stopped) { app.relaunch(); app.quit(); }
	}
}

module.exports = { run };
