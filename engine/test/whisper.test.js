// Whisper dictation: the transcription request (mock server) and, with
// --record, a real 2-second recording from this machine's microphone.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { WhisperDictation, transcribeFile } = require(path.join(__dirname, '..', 'out', 'whisper.js'));

const received = [];
const server = http.createServer((req, res) => {
	const chunks = [];
	req.on('data', (c) => chunks.push(c));
	req.on('end', () => {
		const body = Buffer.concat(chunks);
		received.push({ url: req.url, auth: req.headers.authorization, type: req.headers['content-type'], size: body.length, text: body.toString('latin1') });
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ text: ' hello from whisper ' }));
	});
});

server.listen(0, async () => {
	const base = `http://127.0.0.1:${server.address().port}/v1`;
	try {
		// 1. Request shape (multipart WAV + model + auth) against a mock endpoint.
		const wav = path.join(os.tmpdir(), 'zer0ne-test.wav');
		fs.writeFileSync(wav, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4000)]));
		const text = await transcribeFile(wav, { baseUrl: base + '/chat/completions', apiKey: 'k', model: 'whisper-large-v3' });
		assert.strictEqual(text, 'hello from whisper');
		const r = received[0];
		assert.strictEqual(r.url, '/v1/audio/transcriptions', 'endpoint derived from any OpenAI base URL');
		assert.strictEqual(r.auth, 'Bearer k');
		assert.match(r.type, /multipart\/form-data/);
		assert.match(r.text, /name="model"\r\n\r\nwhisper-large-v3/);
		assert.match(r.text, /filename="dictation\.wav"/);
		fs.rmSync(wav, { force: true });
		console.log('ok  transcription request (multipart WAV, model, auth)');

		// 2. Real recording (needs a microphone): node test/whisper.test.js --record
		if (process.argv.includes('--record')) {
			const d = new WhisperDictation();
			const events = [];
			const done = new Promise((resolve) => {
				d.start(async () => ({ baseUrl: base, apiKey: 'k', model: 'whisper-1' }), (e) => {
					events.push(e.state + (e.text ? ':' + e.text : '') + (e.error ? ':' + e.error : ''));
					if (e.state === 'listening' && !e.text && !d._stopping) {
						d._stopping = true;
						setTimeout(() => d.stop(), 2000);
					}
					if (e.state === 'stopped' || e.state === 'error') resolve();
				});
			});
			await done;
			console.log('   events:', events.join(' → '));
			if (events.some((e) => e.startsWith('error'))) {
				console.log('   (recording not possible here: ' + events.find((e) => e.startsWith('error')) + ')');
			} else {
				assert.ok(events.includes('transcribing'), 'recorded audio was sent');
				assert.ok(received.at(-1).size > 20000, 'a real WAV was uploaded (' + received.at(-1).size + ' bytes)');
				assert.ok(events.includes('listening:hello from whisper'));
				console.log('ok  recorded ' + received.at(-1).size + ' bytes from the microphone and transcribed');
			}
		}
		console.log('\nWHISPER TESTS PASSED');
	} catch (e) {
		console.error('FAIL', e);
		process.exitCode = 1;
	} finally {
		server.close();
	}
});
