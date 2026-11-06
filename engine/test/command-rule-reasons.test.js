'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const OUT = process.env.ZER0NE_TEST_ENGINE_OUT || path.resolve(__dirname, '../out');
const { parseCommandRules, commandRuleReason, commandVerdict } = require(path.join(OUT, 'tools/commandRules'));

test('a rule reason follows the rule into the verdict', () => {
	const rules = parseCommandRules(
		['deny: rm -rf * # protects build output', 'ask: git push* # review before pushing', 'allow: npm test # runs the suite'].join('\n')
	);
	assert.equal(commandVerdict(rules, 'rm -rf build'), 'deny');
	assert.equal(commandRuleReason(rules, 'rm -rf build', 'deny'), 'protects build output');
	assert.equal(commandRuleReason(rules, 'git push origin main', 'ask'), 'review before pushing');
	assert.equal(commandRuleReason(rules, 'npm test', 'allow'), 'runs the suite');
	// A chained command still matches the rule part, with its reason.
	assert.equal(commandRuleReason(rules, 'echo ok && rm -rf build', 'deny'), 'protects build output');
});

test('a rule without a reason has none, and # inside a pattern is not a reason', () => {
	const plain = parseCommandRules('allow: npm test');
	assert.equal(commandVerdict(plain, 'npm test'), 'allow');
	assert.equal(commandRuleReason(plain, 'npm test', 'allow'), undefined);
	const url = parseCommandRules('allow: curl http://example.test/#frag');
	assert.equal(commandVerdict(url, 'curl http://example.test/#frag'), 'allow');
	assert.equal(commandRuleReason(url, 'curl http://example.test/#frag', 'allow'), undefined);
});
