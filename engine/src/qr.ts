/**
 * Minimal QR Code generator (byte mode, error-correction level M,
 * versions 1–10 → up to 213 bytes), after Project Nayuki's reference
 * implementation. Used to pair a phone with Mobile Remote by scanning.
 */

// Level M tables, index = version (0 unused).
const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const NUM_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const ECL_FORMAT_BITS = 0; // M

function rawDataModules(ver: number): number {
	let result = (16 * ver + 128) * ver + 64;
	if (ver >= 2) {
		const numAlign = Math.floor(ver / 7) + 2;
		result -= (25 * numAlign - 10) * numAlign - 55;
		if (ver >= 7) {
			result -= 36;
		}
	}
	return result;
}

function dataCodewords(ver: number): number {
	return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ver] * NUM_BLOCKS[ver];
}

function gfMul(x: number, y: number): number {
	let z = 0;
	for (let i = 7; i >= 0; i--) {
		z = (z << 1) ^ ((z >>> 7) * 0x11d);
		z ^= ((y >>> i) & 1) * x;
	}
	return z & 0xff;
}

function rsDivisor(degree: number): number[] {
	const result = new Array<number>(degree).fill(0);
	result[degree - 1] = 1;
	let root = 1;
	for (let i = 0; i < degree; i++) {
		for (let j = 0; j < result.length; j++) {
			result[j] = gfMul(result[j], root);
			if (j + 1 < result.length) {
				result[j] ^= result[j + 1];
			}
		}
		root = gfMul(root, 0x02);
	}
	return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
	const result = new Array<number>(divisor.length).fill(0);
	for (const b of data) {
		const factor = b ^ (result.shift() as number);
		result.push(0);
		divisor.forEach((coef, i) => (result[i] ^= gfMul(coef, factor)));
	}
	return result;
}

const bit = (x: number, i: number) => ((x >>> i) & 1) !== 0;

export function qrMatrix(text: string): boolean[][] {
	const bytes = Array.from(new TextEncoder().encode(text));
	let ver = 1;
	for (; ver <= 10; ver++) {
		const countBits = ver <= 9 ? 8 : 16;
		if (4 + countBits + bytes.length * 8 <= dataCodewords(ver) * 8) {
			break;
		}
	}
	if (ver > 10) {
		throw new Error('Text too long for this QR generator.');
	}
	// --- data bits
	const bits: number[] = [];
	const push = (val: number, len: number) => {
		for (let i = len - 1; i >= 0; i--) {
			bits.push((val >>> i) & 1);
		}
	};
	push(0b0100, 4);
	push(bytes.length, ver <= 9 ? 8 : 16);
	bytes.forEach((b) => push(b, 8));
	const capacity = dataCodewords(ver) * 8;
	push(0, Math.min(4, capacity - bits.length));
	push(0, (8 - (bits.length % 8)) % 8);
	for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) {
		push(pad, 8);
	}
	const data: number[] = [];
	for (let i = 0; i < bits.length; i += 8) {
		data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
	}
	// --- error correction + interleave
	const numBlocks = NUM_BLOCKS[ver];
	const eccLen = ECC_PER_BLOCK[ver];
	const rawCodewords = Math.floor(rawDataModules(ver) / 8);
	const numShort = numBlocks - (rawCodewords % numBlocks);
	const shortLen = Math.floor(rawCodewords / numBlocks);
	const divisor = rsDivisor(eccLen);
	const blocks: number[][] = [];
	for (let i = 0, k = 0; i < numBlocks; i++) {
		const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
		k += dat.length;
		const ecc = rsRemainder(dat, divisor);
		if (i < numShort) {
			dat.push(0);
		}
		blocks.push(dat.concat(ecc));
	}
	const codewords: number[] = [];
	for (let i = 0; i < blocks[0].length; i++) {
		blocks.forEach((block, j) => {
			if (i !== shortLen - eccLen || j >= numShort) {
				codewords.push(block[i]);
			}
		});
	}
	// --- modules
	const size = ver * 4 + 17;
	const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
	const isFn = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
	const setFn = (x: number, y: number, dark: boolean) => {
		modules[y][x] = dark;
		isFn[y][x] = true;
	};
	for (let i = 0; i < size; i++) {
		setFn(6, i, i % 2 === 0);
		setFn(i, 6, i % 2 === 0);
	}
	const finder = (x: number, y: number) => {
		for (let dy = -4; dy <= 4; dy++) {
			for (let dx = -4; dx <= 4; dx++) {
				const d = Math.max(Math.abs(dx), Math.abs(dy));
				const xx = x + dx;
				const yy = y + dy;
				if (xx >= 0 && xx < size && yy >= 0 && yy < size) {
					setFn(xx, yy, d !== 2 && d !== 4);
				}
			}
		}
	};
	finder(3, 3);
	finder(size - 4, 3);
	finder(3, size - 4);
	if (ver > 1) {
		const numAlign = Math.floor(ver / 7) + 2;
		const step = Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
		const pos = [6];
		for (let p = size - 7; pos.length < numAlign; p -= step) {
			pos.splice(1, 0, p);
		}
		for (let i = 0; i < numAlign; i++) {
			for (let j = 0; j < numAlign; j++) {
				if ((i === 0 && j === 0) || (i === 0 && j === numAlign - 1) || (i === numAlign - 1 && j === 0)) {
					continue;
				}
				for (let dy = -2; dy <= 2; dy++) {
					for (let dx = -2; dx <= 2; dx++) {
						setFn(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
					}
				}
			}
		}
	}
	const drawFormat = (mask: number) => {
		const d = (ECL_FORMAT_BITS << 3) | mask;
		let rem = d;
		for (let i = 0; i < 10; i++) {
			rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
		}
		const b = ((d << 10) | rem) ^ 0x5412;
		for (let i = 0; i <= 5; i++) {
			setFn(8, i, bit(b, i));
		}
		setFn(8, 7, bit(b, 6));
		setFn(8, 8, bit(b, 7));
		setFn(7, 8, bit(b, 8));
		for (let i = 9; i < 15; i++) {
			setFn(14 - i, 8, bit(b, i));
		}
		for (let i = 0; i < 8; i++) {
			setFn(size - 1 - i, 8, bit(b, i));
		}
		for (let i = 8; i < 15; i++) {
			setFn(8, size - 15 + i, bit(b, i));
		}
		setFn(8, size - 8, true);
	};
	drawFormat(0);
	if (ver >= 7) {
		let rem = ver;
		for (let i = 0; i < 12; i++) {
			rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
		}
		const b = (ver << 12) | rem;
		for (let i = 0; i < 18; i++) {
			const a = size - 11 + (i % 3);
			const c = Math.floor(i / 3);
			setFn(a, c, bit(b, i));
			setFn(c, a, bit(b, i));
		}
	}
	// codewords in the zig-zag
	let idx = 0;
	for (let right = size - 1; right >= 1; right -= 2) {
		if (right === 6) {
			right = 5;
		}
		for (let vert = 0; vert < size; vert++) {
			for (let j = 0; j < 2; j++) {
				const x = right - j;
				const upward = ((right + 1) & 2) === 0;
				const y = upward ? size - 1 - vert : vert;
				if (!isFn[y][x] && idx < codewords.length * 8) {
					modules[y][x] = bit(codewords[idx >>> 3], 7 - (idx & 7));
					idx++;
				}
			}
		}
	}
	// mask 2 (x % 3 == 0) — any mask is valid for decoders
	const mask = 2;
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			if (!isFn[y][x] && x % 3 === 0) {
				modules[y][x] = !modules[y][x];
			}
		}
	}
	drawFormat(mask);
	return modules;
}

export function qrSvg(text: string, px = 6): string {
	const m = qrMatrix(text);
	const quiet = 4;
	const n = m.length + quiet * 2;
	let path = '';
	m.forEach((row, y) =>
		row.forEach((dark, x) => {
			if (dark) {
				path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
			}
		})
	);
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n * px}" height="${n * px}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
