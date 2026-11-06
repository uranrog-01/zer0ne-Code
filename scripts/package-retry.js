'use strict';

const normalize = value => String(value).replace(/\\/g, '/').toLowerCase();

function outputLock(output, directory) {
	const root = normalize(directory).replace(/\/$/, '');
	return String(output).split(/\r?\n/).some(line => {
		if (!/\b(?:EBUSY|EPERM|EACCES|ENOTEMPTY)\b/.test(line)) return false;
		const paths = [...line.matchAll(/(?:\b(?:open|rename|unlink|rmdir|copyfile|mkdir|scandir)\s+|->\s*)['"]([^'"]+)['"]/g)];
		return paths.some(([, file]) => {
			const target = normalize(file);
			return target === root || target.startsWith(root + '/') || target === root + '.tmp' || target.startsWith(root + '.tmp/');
		});
	});
}

async function retryPackaging(run, directory, { platform = process.platform, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), beforeRetry = () => {}, report = console.warn } = {}) {
	for (let attempt = 0; ; attempt++) {
		const result = await run();
		if (result.status === 0 || platform !== 'win32' || !outputLock(result.output, directory) || attempt === 3) return result;
		await beforeRetry();
		const delay = 1000 * (attempt + 1);
		report(`Windows temporarily locked the build output. Retrying packaging in ${delay / 1000}s (${attempt + 1}/3).`);
		await wait(delay);
	}
}

module.exports = { outputLock, retryPackaging };
