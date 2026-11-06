import type { AcpAgentEntry } from './registry';

/** Validated offline registry from 2026-10-10; Antigravity refreshed 2026-10-17. Live data replaces it. */
export const REGISTRY_SNAPSHOT: AcpAgentEntry[] = [
	{
		"id": "agoragentic-acp",
		"name": "Agoragentic",
		"version": "1.3.0",
		"description": "Agent marketplace with 174+ AI capabilities. Browse, invoke, and pay for agent services settled in USDC on Base L2.",
		"website": "https://agoragentic.com",
		"repository": "https://github.com/rhein1/agoragentic-integrations",
		"authors": [
			"ACRE / Agoragentic"
		],
		"license": "MIT",
		"icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/agoragentic-acp.svg",
		"distribution": {
			"npx": {
				"package": "agoragentic-mcp@1.3.0",
				"args": [
					"--acp"
				],
				"env": {}
			}
		}
	},
	{
		"id": "amp-acp",
		"name": "Amp",
		"version": "0.10.0",
		"description": "ACP wrapper for Amp - the frontier coding agent",
		"repository": "https://github.com/tao12345666333/amp-acp",
		"authors": [
			"tao12345666333"
		],
		"license": "Apache-2.0",
		"icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/amp-acp.svg",
		"distribution": {
			"binary": {
				"darwin-aarch64": {
					"archive": "https://github.com/tao12345666333/amp-acp/releases/download/v0.10.0/amp-acp-darwin-aarch64.tar.gz",
					"cmd": "./amp-acp",
					"args": [],
					"env": {},
					"sha256": "0434cab747e8f655bbf57dba2421dfd4e01f885ded7776d166150547f07385f3"
				},
				"darwin-x86_64": {
					"archive": "https://github.com/tao12345666333/amp-acp/releases/download/v0.10.0/amp-acp-darwin-x86_64.tar.gz",
					"cmd": "./amp-acp",
					"args": [],
					"env": {},
					"sha256": "ceb87500641814bf0f5944f028328c45ff2db8205ab51a37cff622e91d7ea6a4"
				},
				"linux-aarch64": {
					"archive": "https://github.com/tao12345666333/amp-acp/releases/download/v0.10.0/amp-acp-linux-aarch64.tar.gz",
					"cmd": "./amp-acp",
					"args": [],
					"env": {},
					"sha256": "523e03dbf013dd9281aa8aa296691e472d039ed7f47c464ebdc4a6f0a0567ef1"
				},
				"linux-x86_64": {
					"archive": "https://github.com/tao12345666333/amp-acp/releases/download/v0.10.0/amp-acp-linux-x86_64.tar.gz",
					"cmd": "./amp-acp",
					"args": [],
					"env": {},
					"sha256": "320959bb1de650681413a3fc72febd62fded65c734b9ab3399855e007fcdd1ba"
				},
				"windows-x86_64": {
					"archive": "https://github.com/tao12345666333/amp-acp/releases/download/v0.10.0/amp-acp-windows-x86_64.zip",
					"cmd": "amp-acp.exe",
					"args": [],
					"env": {},
					"sha256": "af3fe51c6b555f25446cb18cc81218d0cc334227289215cacb5a53feb12ff33f"
				}
			}
		}
	},
	{
		"id": "antigravity-acp",
		"name": "Google Antigravity",
		"version": "1.4.1",
		"description": "Google’s AI coding agent",
		"website": "https://antigravity.google/docs/ide/extensions",
		"authors": [
			"Google LLC"
		],
		"license": "proprietary",
		"icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/antigravity-acp.svg",
		"distribution": {
			"binary": {
				"darwin-aarch64": {
					"archive": "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.1-darwin-arm64.zip",
					"cmd": "./agy_acp_server.par",
					"args": [],
					"env": {}
				},
				"darwin-x86_64": {
					"archive": "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.1-darwin-x86_64.zip",
					"cmd": "./agy_acp_server.par",
					"args": [],
					"env": {}
				},
				"linux-x86_64": {
					"archive": "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.1-linux-x86_64.zip",
					"cmd": "./agy_acp_server.par",
					"args": [
						"--uid="
					],
					"env": {}
				},
				"linux-aarch64": {
					"archive": "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.1-linux-arm64.zip",
					"cmd": "./agy_acp_server.par",
					"args": [
						"--uid="
					],
					"env": {}
				},
				"windows-x86_64": {
					"archive": "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.1-windows-x86_64.zip",
					"cmd": "./agy_acp_server.exe",
					"args": [],
					"env": {}
				},
				"windows-aarch64": {
					"archive": "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.1-windows-arm64.zip",
					"cmd": "./agy_acp_server.exe",
					"args": [],
					"env": {}
				}
			}
		}
	},
	{
		"id": "auggie",
		"name": "Auggie CLI",
		"version": "0.36.0",
		"description": "Augment Code's powerful software agent, backed by industry-leading context engine",
		"website": "https://www.augmentcode.com/",
		"repository": "https://github.com/augmentcode/auggie",
		"authors": [
			"Augment Code <support@augmentcode.com>"
		],
		"license": "proprietary",
		"icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/auggie.svg",
		"distribution": {
			"npx": {
				"package": "@augmentcode/auggie@0.36.0",
				"args": [
					"--acp"
				],
				"env": {
					"AUGMENT_DISABLE_AUTO_UPDATE": "1"
				}
			}
		}
	},
	{
		"id": "autohand",
		"name": "Autohand Code",
		"version": "0.2.1",
		"description": "Autohand Code - AI coding agent powered by Autohand AI",
		"website": "https://www.autohand.ai/cli/",
		"repository": "https://github.com/autohandai/autohand-acp",
		"authors": [
			"Autohand AI"
		],
		"license": "Apache-2.0",
		"icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/autohand.svg",
		"distribution": {
			"npx": {
				"package": "@autohandai/autohand-acp@0.2.1",
				"args": [],
				"env": {}
			}
		}
	},
	{
		"id": "claude-acp",
		"name": "Claude Agent",
		"version": "0.89.1",
		"description": "ACP wrapper for Anthropic's Claude",
		"repository": "https://github.com/agentclientprotocol/claude-agent-acp",
		"authors": [
			"Anthropic",
			"Zed Industries",
			"JetBrains"
		],
		"license": "proprietary",
		"icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/claude-acp.svg",
		"distribution": {
			"npx": {
				"package": "@agentclientprotocol/claude-agent-acp@0.89.1",
				"args": [],
				"env": {}
			}
		}
	},
	{
		"id": "cline",
		"name": "Cline",
		"version": "3.0.70",
		"description": "Autonomous coding agent CLI - capable of creating/editing files, running commands, using the browser, and more",
		"website": "https://cline.bot/cli",
		"repository": "https://github.com/cline/cline",
		"authors": [
			"Cline Bot Inc."
		],
		"license": "Apache-2.0",
		"icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/cline.svg",
		"distribution": {
			"npx": {
				"package": "cline@3.0.70",
				"args": [
					"--acp"
				],
				"env": {}
			}
		}
	},
	{
		"id": "codebuddy-code",
		"name": "Codebuddy Code",
		"version": "2.164.0",
		"description": "Tencent Cloud's official intelligent coding tool",
		"website": "https://www.codebuddy.cn/cli/",
		"authors": [
			"Tencent Cloud"
		],
		"license": "Proprietary",
		"icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/codebuddy-code.svg",
		"distribution": {
			"npx": {
				"package": "@tencent-ai/codebuddy-code@2.164.0",
				"args": [
					"--acp"
				],
				"env": {}
			}
		}
	},
	{
		"id": "codex-acp",
		"name": "Codex",
		"version": "2.2.2",
		"description": "ACP adapter for OpenAI's coding assistant",
		"repository": "https://github.com/agentclientprotocol/codex-acp",
		"authors": [
			"OpenAI",
			"JetBrains s.r.o",
			"Zed Industries"
		],
		"license": "Apache-2.0",
		"icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/codex-acp.svg",
		"distribution": {
			"npx": {
				"package": "@agentclientprotocol/codex-acp@2.2.2",
				"args": [],
				"env": {}
			}
		}
	},
	{
		"id": "cortex-code",
		"name": "Cortex Code",
		"version": "1.0.73",
		"description": "Snowflake's Cortex Code coding agent",
		"repository": "https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code",
		"authors": [
			"Snowflake"
		],
		"license": "proprietary",
		"icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/cortex-code.svg",
		"distribution": {
			"binary": {
				"darwin-aarch64": {
					"archive": "https://sfc-repo.snowflakecomputing.com/cortex-code-cli/a4643c4278/1.0.73%2B180523.e6179a031de9/coco-1.0.73%2B180523.e6179a031de9-darwin-arm64.tar.gz",
					"cmd": "./coco-1.0.73+180523.e6179a031de9-darwin-arm64/cortex",
					"args": [
						"acp",
						"serve"
					],
					"env": {}
				},
				"darwin-x86_64": {
					"archive": "https://sfc-repo.snowflakecomputing.com/cortex-code-cli/a4643c4278/1.0.73%2B180523.e6179a031de9/coco-1.0.73%2B180523.e6179a031de9-darwin-amd64.tar.gz",
					"cmd": "./coco-1.0.73+180523.e6179a031de9-darwin-amd64/cortex",
					"args": [
						"acp",
						"serve"
					],
					"env": {}
				},
				"linux-x86_64": {
					"archive": "https://sfc-repo.snowflakecomputing.com/cortex-code-cli/a4643c4278/1.0.73%2B180523.e6179a031de9/coco-1.0.73%2B180523.e6179a031de9-linux-amd64.tar.gz",
					"cmd": "./coco-1.0.73+180523.e6179a031de9-linux-amd64/cortex",
					"args": [
						"acp",
						"serve"
					],
					"env": {}
				},
				"linux-aarch64": {
					"archive": "https://sfc-repo.snowflakecomputing.com/cortex-code-cli/a4643c4278/1.0.73%2B180523.e6179a031de9/coco-1.0.73%2B180523.e6179a031de9-linux-arm64.tar.gz",
					"cmd": "./coco-1.0.73+180523.e6179a031de9-linux-arm64/cortex",
					"args": [
						"acp",
						"serve"
					],
					"env": {}
				},
				"windows-x86_64": {
					"archive": "https://sfc-repo.snowflakecomputing.com/cortex-code-cli/a4643c4278/1.0.73%2B180523.e6179a031de9/coco-1.0.73%2B180523.e6179a031de9-windows-amd64.tar.gz",
					"cmd": "./coco-1.0.73+180523.e6179a031de9-windows-amd64/cortex.exe",
					"args": [
						"acp",
						"serve"
					],
					"env": {}
				},
				"windows-aarch64": {
					"archive": "https://sfc-repo.snowflakecomputing.com/cortex-code-cli/a4643c4278/1.0.73%2B180523.e6179a031de9/coco-1.0.73%2B180523.e6179a031de9-windows-arm64.tar.gz",
					"cmd": "./coco-1.0.73+180523.e6179a031de9-windows-arm64/cortex.exe",
					"args": [
						"acp",
						"serve"
					],
					"env": {}
				}
			}
		}
	},
	{
		"id": "corust-agent",
		"name": "Corust Agent",
		"version": "0.6.0",
		"description": "Co-building with a seasoned Rust partner.",
		"website": "https://corust.ai/",
		"repository": "https://github.com/Corust-ai/corust-agent-release",
		"authors": [
			"Corust AI <support@corust.ai>"
		],
		"license": "GPL-3.0-or-later",
		"icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/corust-agent.svg",
		"distribution": {
			"binary": {
				"darwin-aarch64": {
					"archive": "https://github.com/Corust-ai/corust-agent-release/releases/download/v0.6.0/agent-darwin-arm64.tar.gz",
					"cmd": "./corust-agent-acp",
					"args": [],
					"env": {}
				},
				"darwin-x86_64": {
					"archive": "https://github.com/Corust-ai/corust-agent-release/releases/download/v0.6.0/agent-darwin-x64.tar.gz",
					"cmd": "./corust-agent-acp",
					"args": [],
					"env": {}
				},
				"linux-x86_64": {
					"archive": "https://github.com/Corust-ai/corust-agent-release/releases/download/v0.6.0/agent-linux-x64.tar.gz",
					"cmd": "./corust-agent-acp",
					"args": [],
					"env": {}
				},
				"windows-x86_64": {
					"archive": "https://github.com/Corust-ai/corust-agent-release/releases/download/v0.6.0/agent-windows-x64.zip",
					"cmd": "./corust-agent-acp.exe",
					"args": [],
					"env": {}
				}
			}
		}
	},
	{
		"id": "crow-cli",
		"name": "crow-cli",
		"version": "0.1.24",
		"description": "Minimal ACP Native Coding Agent",
		"website": "https://crow-ai.dev",
		"repository": "https://github.com/crow-cli/crow-cli",
		"authors": [
			"Thomas Wood"
		],
		"license": "Apache-2.0",
		"icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/crow-cli.svg",
		"distribution": {
			"binary": {
				"darwin-aarch64": {
					"archive": "https://github.com/crow-cli/crow-cli/releases/download/v0.1.24/crow-cli-darwin-aarch64.tar.gz",
					"cmd": "./crow-cli",
					"args": [
						"acp"
					],
					"env": {}
				},
				"darwin-x86_64": {
					"archive": "https://github.com/crow-cli/crow-cli/releases/download/v0.1.24/crow-cli-darwin-x86_64.tar.gz",
					"cmd": "./crow-cli",
					"args": [
						"acp"
					],
					"env": {}
				},
				"linux-aarch64": {
					"archive": "https://github.com/crow-cli/crow-cli/releases/download/v0.1.24/crow-cli-linux-aarch64.tar.gz",
					"cmd": "./crow-cli",
					"args": [
						"acp"
					],
					"env": {}
				},
				"linux-x86_64": {
					"archive": "https://github.com/crow-cli/crow-cli/releases/download/v0.1.24/crow-cli-linux-x86_64.tar.gz",
					"cmd": "./crow-cli",
					"args": [
						"acp"
					],
					"env": {}
				},
				"windows-x86_64": {
					"archive": "https://github.com/crow-cli/crow-cli/releases/download/v0.1.24/crow-cli-windows-x86_64.zip",
					"cmd": "./crow-cli.exe",
					"args": [
						"acp"
					],
					"env": {}
				}
			}
		}
	},
	{
		"id": "cursor",
		"name": "Cursor",
		"version": "2026.10.01",
		"description": "Cursor's coding agent",
		"website": "https://cursor.com/docs/cli/acp",
		"authors": [
			"Cursor"
		],
		"license": "proprietary",
		"icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/cursor.svg",
		"distribution": {
			"binary": {
				"darwin-aarch64": {
					"archive": "https://downloads.cursor.com/lab/2026.10.01-14929f9/darwin/arm64/agent-cli-package.tar.gz",
					"cmd": "./dist-package/cursor-agent",
					"args": [
						"acp"
					],
					"env": {}
				},
				"darwin-x86_64": {
					"archive": "https://downloads.cursor.com/lab/2026.10.01-14929f9/darwin/x64/agent-cli-package.tar.gz",
					"cmd": "./dist-package/cursor-agent",
					"args": [
						"acp"
					],
					"env": {}
				},
				"linux-aarch64": {
					"archive": "https://downloads.cursor.com/lab/2026.10.01-14929f9/linux/arm64/agent-cli-package.tar.gz",
					"cmd": "./dist-package/cursor-agent",
					"args": [
						"acp"
					],
					"env": {}
				},
				"linux-x86_64": {
					"archive": "https://downloads.cursor.com/lab/2026.10.01-14929f9/linux/x64/agent-cli-package.tar.gz",
					"cmd": "./dist-package/cursor-agent",
					"args": [
						"acp"
					],
					"env": {}
				},
				"windows-aarch64": {
					"archive": "https://downloads.cursor.com/lab/2026.10.01-14929f9/windows/arm64/agent-cli-package.zip",
					"cmd": "./dist-package/cursor-agent.cmd",
					"args": [
						"acp"
					],
					"env": {}
				},
				"windows-x86_64": {
					"archive": "https://downloads.cursor.com/lab/2026.10.01-14929f9/windows/x64/agent-cli-package.zip",
					"cmd": "./dist-package/cursor-agent.cmd",
					"args": [
						"acp"
					],
					"env": {}
				}
			}
		}
	},
	{
		"id": "deepagents",
		"name": "DeepAgents",
		"version": "0.1.7",
		"description": "Batteries-included AI coding and general purpose agent powered by LangChain.",
		"website": "https://docs.langchain.com/oss/javascript/deepagents/overview",
		"repository": "https://github.com/langchain-ai/deepagentsjs",
		"authors": [
			"LangChain"
		],
		"license": "MIT",
		"icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/deepagents.svg",
		"distribution": {
			"npx": {
				"package": "deepagents-acp@0.1.7",
				"args": [],
				"env": {}
			}
		}
	},
	{
		"id": "devin",
		"name": "Devin",
		"version": "3000.11.3",
		"description": "Devin CLI coding agent by Cognition",
		"website": "https://docs.devin.ai/cli",
		"repository": "https://github.com/CognitionAI/devin-cli",
		"authors": [
			"Cognition"
		],
		"license": "proprietary",
		"icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/devin.svg",
		"distribution": {
			"binary": {
				"darwin-aarch64": {
					"archive": "https://static.devin.ai/cli/3000.11.3/devin-3000.11.3-aarch64-apple-darwin.tar.gz",
					"cmd": "./bin/devin",
					"args": [
						"acp"
					],
					"env": {}
				},
				"darwin-x86_64": {
					"archive": "https://static.devin.ai/cli/3000.11.3/devin-3000.11.3-x86_64-apple-darwin.tar.gz",
					"cmd": "./bin/devin",
					"args": [
						"acp"
					],
					"env": {}
				},
				"linux-aarch64": {
					"archive": "https://static.devin.ai/cli/3000.11.3/devin-3000.11.3-aarch64-unknown-linux.tar.gz",
					"cmd": "./bin/devin",
					"args": [
						"acp"
					],
					"env": {}
				},
				"linux-x86_64": {
					"archive": "https://static.devin.ai/cli/3000.11.3/devin-3000.11.3-x86_64-unknown-linux.tar.gz",
					"cmd": "./bin/devin",
					"args": [
						"acp"
					],
					"env": {}
				},
				"windows-aarch64": {
					"archive": "https://static.devin.ai/cli/3000.11.3/devin-3000.11.3-aarch64-pc-windows.zip",
					"cmd": "./bin/devin.exe",
					"args": [
						"acp"
					],
					"env": {}
				},
				"windows-x86_64": {
					"archive": "https://static.devin.ai/cli/3000.11.3/devin-3000.11.3-x86_64-pc-windows.zip",
					"cmd": "./bin/devin.exe",
					"args": [
						"acp"
					],
					"env": {}
				}
			}
		}
	},
	{
		"id": "dimcode",
		"name": "DimCode",
		"version": "0.5.16",
		"description": "A coding agent that puts leading models at your command.",
		"website": "https://dimcode.dev/docs/acp.html",
		"authors": [
			"ArcShips"
		],
		"license": "proprietary",
		"icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/dimcode.svg",
		"distribution": {
			"npx": {
				"package": "dimcode@0.5.16",
				"args": [
					"acp"
				],
				"env": {}
			}
		}
	},
	{
		"id": "dirac",
		"name": "Dirac",
		"version": "0.5.19",
		"description": "Reduces API costs by more than 50%, produces better and faster work. Uses Hash anchored parallel edits, AST manipulation and a whole lot of neat optimizations. Fully Open Source.",
		"website": "https://dirac.run",
		"repository": "https://github.com/dirac-run/dirac",
		"authors": [
			"Dirac Delta Labs"
		],
		"license": "Apache-2.0",
		"icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/dirac.svg",
		"distribution": {
			"npx": {
				"package": "dirac-cli@0.5.19",
				"args": [
					"--acp"
				],
				"env": {}
			}
		}
	},
	{
		"id": "factory-droid",
		"name": "Factory Droid",
		"version": "0.238.0",
		"description": "Factory Droid - AI coding agent powered by Factory AI",
		"website": "https://factory.ai/product/cli",
		"authors": [
			"Factory AI"
		],
		"license": "proprietary",
		"icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/factory-droid.svg",
		"distribution": {
			"npx": {
				"package": "droid@0.238.0",
				"args": [
					"exec",
					"--output-format",
					"acp-daemon"
				],
				"env": {
					"DROID_DISABLE_AUTO_UPDATE": "true",
					"FACTORY_DROID_AUTO_UPDATE_ENABLED": "false"
				}
			}
		}
	},
	{
		"id": "fast-agent",
		"name": "fast-agent",
		"version": "0.10.1",
		"description": "Code and build agents with comprehensive multi-provider support",
		"website": "https://fast-agent.ai",
		"repository": "https://github.com/evalstate/fast-agent",
		"authors": [
			"enquiries@fast-agent.ai"
		],
		"license": "Apache 2.0",
		"icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/fast-agent.svg",
		"distribution": {
			"uvx": {
				"package": "fast-agent-acp==0.10.1",
				"args": [
					"-x"
				],
				"env": {
					"FAST_AGENT_MODEL": "codexplan"
				}
			}
		}
	},
	{
		"id": "gemini",
		"name": "Gemini CLI",
		"version": "0.63.0",
		"description": "Google's official CLI for Gemini",
		"website": "https://geminicli.com",
		"repository": "https://github.com/google-gemini/gemini-cli",
		"authors": [
			"Google"
		],
		"license": "Apache-2.0",
		"icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/gemini.svg",
		"distribution": {
			"npx": {
				"package": "@google/gemini-cli@0.63.0",
				"args": [
					"--acp"
				],
				"env": {}
			}
		}
	},
	{
		"id": "github-copilot-cli",
		"name": "GitHub Copilot",
		"version": "1.0.95",
		"description": "GitHub's AI pair programmer",
		"website": "https://github.com/features/copilot/cli/",
		"repository": "https://github.com/github/copilot-cli",
		"authors": [
			"GitHub"
		],
		"license": "proprietary",
		"icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/github-copilot-cli.svg",
		"distribution": {
			"npx": {
				"package": "@github/copilot@1.0.95",
				"args": [
					"--acp"
				],
				"env": {}
			}
		}
	},
	{
		"id": "glm-acp-agent",
		"name": "GLM Agent",
		"version": "1.14.0",
		"description": "ACP agent powered by Zhipu AI's GLM Coding Plan models (glm-5.1, glm-5-turbo, glm-4.7, glm-4.5-air). Supports streaming, tool calls, mid-session model switching, image input via Z.AI Coding Plan Vision MCP, and session load/fork/resume with",
		"repository": "https://github.com/stefandevo/glm-acp-agent",
		"authors": [
			"Stefan de Vogelaere"
		],
		"license": "Apache-2.0",
		"icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/glm-acp-agent.svg",
		"distribution": {
			"npx": {
				"package": "glm-acp-agent@1.14.0",
				"args": [],
				"env": {}
			}
		}
	},
	{
		"id": "goose",
		"name": "goose",
		"version": "1.54.0",
		"description": "A local, extensible, open source AI agent that automates engineering tasks",
		"website": "https://block.github.io/goose/",
		"repository": "https://github.com/block/goose",
		"authors": [
			"Block"
		],
		"license": "Apache-2.0",
		"icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/goose.svg",
		"distribution": {
			"binary": {
				"darwin-aarch64": {
					"archive": "https://github.com/block/goose/releases/download/v1.54.0/goose-aarch64-apple-darwin.tar.bz2",
					"cmd": "./goose",
					"args": [
						"acp"
					],
					"env": {},
					"sha256": "63738f0eed2fe9d8585a4ba988c3ffb23d600db0b43858a6cd868fa6b035a7af"
				},
				"darwin-x86_64": {
					"archive": "https://github.com/block/goose/releases/download/v1.54.0/goose-x86_64-apple-darwin.tar.bz2",
					"cmd": "./goose",
					"args": [
						"acp"
					],
					"env": {},
					"sha256": "81fd55f4003950bb72719402e2defb1375eef4b9a739d901a365fb737b73aeee"
				},
				"linux-aarch64": {
					"archive": "https://github.com/block/goose/releases/download/v1.54.0/goose-aarch64-unknown-linux-gnu.tar.bz2",
					"cmd": "./goose",
					"args": [
						"acp"
					],
					"env": {},
					"sha256": "8c7ad233bdaf05f10a52ef36f3ce50f839cb1d2d1df5b31b172af7150c1c288e"
				},
				"linux-x86_64": {
					"archive": "https://github.com/block/goose/releases/download/v1.54.0/goose-x86_64-unknown-linux-gnu.tar.bz2",
					"cmd": "./goose",
					"args": [
						"acp"
					],
					"env": {},
					"sha256": "bf01cb6359f7a2b1acb54ca4827e1d059b18aabb3d2b75202e21066cfd3a3396"
				},
				"windows-x86_64": {
					"archive": "https://github.com/block/goose/releases/download/v1.54.0/goose-x86_64-pc-windows-msvc.zip",
					"cmd": "./goose-package/goose.exe",
					"args": [
						"acp"
					],
					"env": {},
					"sha256": "5c39bc91c3eadc231847e21a8a469e778431084437b233a63a950fee22db6239"
				}
			}
		}
	},
	{
		"id": "grok-build",
		"name": "Grok Build",
		"version": "1.0.51",
		"description": "xAI's coding agent and CLI",
		"website": "https://x.ai/cli",
		"authors": [
			"xAI"
		],
		"license": "proprietary",
		"icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/grok-build.svg",
		"distribution": {
			"npx": {
				"package": "@xai-official/grok@1.0.51",
				"args": [
					"agent",
					"stdio"
				],
				"env": {}
			}
		}
	},
	{
		"id": "harn",
		"name": "Harn",
		"version": "0.10.162",
		"description": "Harn runs .harn agent pipelines as a native ACP coding agent over stdio.",
		"website": "https://harnlang.com",
		"repository": "https://github.com/burin-labs/harn",
		"authors": [
			"Burin Labs"
		],
		"license": "Apache-2.0",
		"icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/harn.svg",
		"distribution": {
			"binary": {
				"darwin-aarch64": {
					"archive": "https://github.com/burin-labs/harn/releases/download/v0.10.162/harn-aarch64-apple-darwin.tar.gz",
					"cmd": "./harn",
					"args": [
						"serve",
						"acp"
					],
					"env": {},
					"sha256": "fdd26f9a58d1cc2b3c205f5abde7f4486d8e5296862763e845d1404555d81f67"
				},
				"darwin-x86_64": {
					"archive": "https://github.com/burin-labs/harn/releases/download/v0.10.162/harn-x86_64-apple-darwin.tar.gz",
					"cmd": "./harn",
					"args": [
						"serve",
						"acp"
					],
					"env": {},
					"sha256": "912b02c7d294d639f90ba7c7e449dfa4782e021ffc7aacc459983157e9f5c60a"
				},
				"linux-aarch64": {
					"archive": "https://github.com/burin-labs/harn/releases/download/v0.10.162/harn-aarch64-unknown-linux-gnu.tar.gz",
					"cmd": "./harn",
					"args": [
						"serve",
						"acp"
					],
					"env": {},
					"sha256": "24fa6d656f3ee4faafc35765d0567922f294da2bc9f5eb240114d60f09ee1594"
				},
				"linux-x86_64": {
					"archive": "https://github.com/burin-labs/harn/releases/download/v0.10.162/harn-x86_64-unknown-linux-gnu.tar.gz",
					"cmd": "./harn",
					"args": [
						"serve",
						"acp"
					],
					"env": {},
					"sha256": "8cfc71e9bd800e3e42d5f517c5f03a8f8ec29428bbebd56b396f35a288e4e246"
				},
				"windows-x86_64": {
					"archive": "https://github.com/burin-labs/harn/releases/download/v0.10.162/harn-x86_64-pc-windows-msvc.zip",
					"cmd": "harn.exe",
					"args": [
						"serve",
						"acp"
					],
					"env": {},
					"sha256": "befcc99ef4a0758b9e19c052d060982a2608d5ebfdeccfcf86f2c6f9be33cdb6"
				}
			}
		}
	},
	{
		"id": "junie",
		"name": "Junie",
		"version": "3579.5.0",
		"description": "AI Coding Agent by JetBrains",
		"website": "https://junie.jetbrains.com",
		"repository": "https://github.com/JetBrains/junie-acp-release",
		"authors": [
			"JetBrains"
		],
		"license": "proprietary",
		"icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/junie.svg",
		"distribution": {
			"binary": {
				"darwin-aarch64": {
					"archive": "https://github.com/JetBrains/junie-acp-release/releases/download/3579.5/junie-release-3579.5-macos-aarch64.zip",
					"cmd": "./Applications/junie.app/Contents/MacOS/junie",
					"args": [
						"--acp=true"
					],
					"env": {}
				},
				"darwin-x86_64": {
					"archive": "https://github.com/JetBrains/junie-acp-release/releases/download/3579.5/junie-release-3579.5-macos-amd64.zip",
					"cmd": "./Applications/junie.app/Contents/MacOS/junie",
					"args": [
						"--acp=true"
					],
					"env": {}
				},
				"linux-aarch64": {
					"archive": "https://github.com/JetBrains/junie-acp-release/releases/download/3579.5/junie-release-3579.5-linux-aarch64.zip",
					"cmd": "./junie-app/bin/junie",
					"args": [
						"--acp=true"
					],
					"env": {}
				},
				"linux-x86_64": {
					"archive": "https://github.com/JetBrains/junie-acp-release/releases/download/3579.5/junie-release-3579.5-linux-amd64.zip",
					"cmd": "./junie-app/bin/junie",
					"args": [
						"--acp=true"
					],
					"env": {}
				},
				"windows-x86_64": {
					"archive": "https://github.com/JetBrains/junie-acp-release/releases/download/3579.5/junie-release-3579.5-windows-amd64.zip",
					"cmd": "./junie/junie.exe",
					"args": [
						"--acp=true"
					],
					"env": {}
				},
				"windows-aarch64": {
					"archive": "https://github.com/JetBrains/junie-acp-release/releases/download/3579.5/junie-release-3579.5-windows-aarch64.zip",
					"cmd": "./junie/junie.exe",
					"args": [
						"--acp=true"
					],
					"env": {}
				}
			}
		}
	},
	{
		"id": "kilo",
		"name": "Kilo",
		"version": "7.8.8",
		"description": "The open source coding agent",
		"website": "https://kilo.ai/",
		"repository": "https://github.com/Kilo-Org/kilocode",
		"authors": [
			"Kilo Code"
		],
		"license": "MIT",
		"icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/kilo.svg",
		"distribution": {
			"npx": {
				"package": "@kilocode/cli@7.8.8",
				"args": [
					"acp"
				],
				"env": {}
			},
			"binary": {
				"darwin-aarch64": {
					"archive": "https://github.com/Kilo-Org/kilocode/releases/download/v7.8.8/kilo-darwin-arm64.zip",
					"cmd": "./kilo",
					"args": [
						"acp"
					],
					"env": {},
					"sha256": "67703d15d38be9e0b4b025491aa08017e7019e15ba47491b2c563e39136700fc"
				},
				"darwin-x86_64": {
					"archive": "https://github.com/Kilo-Org/kilocode/releases/download/v7.8.8/kilo-darwin-x64.zip",
					"cmd": "./kilo",
					"args": [
						"acp"
					],
					"env": {},
					"sha256": "32c2391e4dd8d009df83f9c8c85467d8cf3afc6fa398c2cf6fbc3e7cdcefd3e1"
				},
				"linux-aarch64": {
					"archive": "https://github.com/Kilo-Org/kilocode/releases/download/v7.8.8/kilo-linux-arm64.tar.gz",
					"cmd": "./kilo",
					"args": [
						"acp"
					],
					"env": {},
					"sha256": "abb057ef7bdd65987274a15731272350a61149d0bd343931c809c097a4265273"
				},
				"linux-x86_64": {
					"archive": "https://github.com/Kilo-Org/kilocode/releases/download/v7.8.8/kilo-linux-x64.tar.gz",
					"cmd": "./kilo",
					"args": [
						"acp"
					],
					"env": {},
					"sha256": "1072997aa8d54f001cacf76527465353b7a7abd76b7e08828309bd3576c6429b"
				},
				"windows-x86_64": {
					"archive": "https://github.com/Kilo-Org/kilocode/releases/download/v7.8.8/kilo-windows-x64.zip",
					"cmd": "./kilo.exe",
					"args": [
						"acp"
					],
					"env": {},
					"sha256": "ed943f108c9017b7f38a64d6e0f987218994364cc3ad721e870c33ffec04144a"
				}
			}
		}
	},
	{
		"id": "kimchi",
		"name": "Kimchi",
		"version": "1.9.1",
		"description": "Coding agent powered by multi-model orchestration",
		"website": "https://kimchi.dev",
		"repository": "https://github.com/getkimchi/kimchi",
		"authors": [
			"Kimchi"
		],
		"license": "Apache-2.0",
		"icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/kimchi.svg",
		"distribution": {
			"binary": {
				"darwin-aarch64": {
					"archive": "https://github.com/getkimchi/kimchi/releases/download/v1.9.1/kimchi_darwin_arm64.tar.gz",
					"cmd": "./bin/kimchi",
					"args": [
						"--mode",
						"acp"
					],
					"env": {},
					"sha256": "989f30c77701a2a8497d6ac0a71335a6d035a9b1345ff7ec63e5796ada04dbd8"
				},
				"darwin-x86_64": {
					"archive": "https://github.com/getkimchi/kimchi/releases/download/v1.9.1/kimchi_darwin_amd64.tar.gz",
					"cmd": "./bin/kimchi",
					"args": [
						"--mode",
						"acp"
					],
					"env": {},
					"sha256": "f459a29a237c690f4444913c72643cc5c3092788fef86077335f7bafcf027eef"
				},
				"linux-aarch64": {
					"archive": "https://github.com/getkimchi/kimchi/releases/download/v1.9.1/kimchi_linux_arm64.tar.gz",
					"cmd": "./bin/kimchi",
					"args": [
						"--mode",
						"acp"
					],
					"env": {},
					"sha256": "32e190f5de1b27b0377f39ba35ed3290b43b6dae0688d39a983702b06163b01d"
				},
				"linux-x86_64": {
					"archive": "https://github.com/getkimchi/kimchi/releases/download/v1.9.1/kimchi_linux_amd64.tar.gz",
					"cmd": "./bin/kimchi",
					"args": [
						"--mode",
						"acp"
					],
					"env": {},
					"sha256": "75698947892c1cb03d91dd0362eff739d9a4135eb11b2fbd6a71193cce7d16a6"
				},
				"windows-x86_64": {
					"archive": "https://github.com/getkimchi/kimchi/releases/download/v1.9.1/kimchi_windows_amd64.zip",
					"cmd": "./bin/kimchi.exe",
					"args": [
						"--mode",
						"acp"
					],
					"env": {},
					"sha256": "619141eec481700654651b5157f547fb57092f0079d6aef4841e142bb28703c2"
				}
			}
		}
	},
	{
		"id": "kimi",
		"name": "Kimi CLI",
		"version": "1.52.0",
		"description": "Moonshot AI's coding assistant",
		"website": "https://moonshotai.github.io/kimi-cli/",
		"repository": "https://github.com/MoonshotAI/kimi-cli",
		"authors": [
			"Moonshot AI"
		],
		"license": "MIT",
		"icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/kimi.svg",
		"distribution": {
			"binary": {
				"darwin-aarch64": {
					"archive": "https://github.com/MoonshotAI/kimi-cli/releases/download/1.52.0/kimi-1.52.0-aarch64-apple-darwin.tar.gz",
					"cmd": "./kimi",
					"args": [
						"acp"
					],
					"env": {},
					"sha256": "43fe091f70bbf8860974200f9021a05689a020857cc9926d56f1505f0d0d5cb8"
				},
				"linux-aarch64": {
					"archive": "https://github.com/MoonshotAI/kimi-cli/releases/download/1.52.0/kimi-1.52.0-aarch64-unknown-linux-gnu.tar.gz",
					"cmd": "./kimi",
					"args": [
						"acp"
					],
					"env": {},
					"sha256": "9e06eea96273600aed485b1f0bedda95b7084db4f22cf28614fe20138933507a"
				},
				"linux-x86_64": {
					"archive": "https://github.com/MoonshotAI/kimi-cli/releases/download/1.52.0/kimi-1.52.0-x86_64-unknown-linux-gnu.tar.gz",
					"cmd": "./kimi",
					"args": [
						"acp"
					],
					"env": {},
					"sha256": "a676204f7804ed5dae87652a9d66f578e0718d5026c9cb1bfa32b9a5eace4208"
				},
				"windows-aarch64": {
					"archive": "https://github.com/MoonshotAI/kimi-cli/releases/download/1.52.0/kimi-1.52.0-aarch64-pc-windows-msvc.zip",
					"cmd": "./kimi.exe",
					"args": [
						"acp"
					],
					"env": {},
					"sha256": "7c77cd413e7a3a59416c171a45ee4ff50534869b331469138aad84b9e3acb6c0"
				},
				"windows-x86_64": {
					"archive": "https://github.com/MoonshotAI/kimi-cli/releases/download/1.52.0/kimi-1.52.0-x86_64-pc-windows-msvc.zip",
					"cmd": "./kimi.exe",
					"args": [
						"acp"
					],
					"env": {},
					"sha256": "2c269e15e152b9f28ac1556795280f90a2c9860ff44c60c628c3fce4dd4c58a7"
				}
			}
		}
	},
	{
		"id": "minimax-code",
		"name": "MiniMax Code",
		"version": "0.2.7",
		"description": "MiniMax Code is an AI coding agent with Agent Client Protocol support.",
		"website": "https://agent.minimax.io",
		"authors": [
			"MiniMax"
		],
		"license": "MIT",
		"icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/minimax-code.svg",
		"distribution": {
			"npx": {
				"package": "@minimax-ai/code@0.2.7",
				"args": [
					"acp"
				],
				"env": {}
			}
		}
	},
	{
		"id": "minion-code",
		"name": "Minion Code",
		"version": "0.1.44",
		"description": "An enhanced AI code assistant built on the Minion framework with rich development tools",
		"repository": "https://github.com/femto/minion-code",
		"authors": [
			"femto"
		],
		"license": "AGPL-3.0",
		"icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/minion-code.svg",
		"distribution": {
			"uvx": {
				"package": "minion-code@0.1.44",
				"args": [
					"acp"
				],
				"env": {}
			}
		}
	},
	{
		"id": "mistral-vibe",
		"name": "Mistral Vibe",
		"version": "2.26.1",
		"description": "Mistral's open-source coding assistant",
		"website": "https://mistral.ai/products/vibe",
		"repository": "https://github.com/mistralai/mistral-vibe",
		"authors": [
			"Mistral AI"
		],
		"license": "Apache-2.0",
		"icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/mistral-vibe.svg",
		"distribution": {
			"binary": {
				"darwin-aarch64": {
					"archive": "https://github.com/mistralai/mistral-vibe/releases/download/v2.26.1/vibe-acp-darwin-aarch64-2.26.1.tar.gz",
					"cmd": "./vibe-acp",
					"args": [],
					"env": {},
					"sha256": "4035a97f3bf99d91589ae4b5399438fb417f6b72511a995c7c363ec4b468f10a"
				},
				"darwin-x86_64": {
					"archive": "https://github.com/mistralai/mistral-vibe/releases/download/v2.26.1/vibe-acp-darwin-x86_64-2.26.1.tar.gz",
					"cmd": "./vibe-acp",
					"args": [],
					"env": {},
					"sha256": "3acfc454ffc248826a05333e1cb2467c465308639bbba6725b47384dc9e8f757"
				},
				"linux-aarch64": {
					"archive": "https://github.com/mistralai/mistral-vibe/releases/download/v2.26.1/vibe-acp-linux-aarch64-2.26.1.tar.gz",
					"cmd": "./vibe-acp",
					"args": [],
					"env": {},
					"sha256": "147ce53d0d185148ac269e23ff285eb087167077ba00d7c9ff41492c647ad2c6"
				},
				"linux-x86_64": {
					"archive": "https://github.com/mistralai/mistral-vibe/releases/download/v2.26.1/vibe-acp-linux-x86_64-2.26.1.tar.gz",
					"cmd": "./vibe-acp",
					"args": [],
					"env": {},
					"sha256": "c8a018ca7d02eed5cebf291f6bcce1744e44323ff774b1c3fceac13794a95634"
				},
				"windows-x86_64": {
					"archive": "https://github.com/mistralai/mistral-vibe/releases/download/v2.26.1/vibe-acp-windows-x86_64-2.26.1.zip",
					"cmd": "./vibe-acp.exe",
					"args": [],
					"env": {},
					"sha256": "fd192698e396470f478adda5ce57cd8fd58927a2cd5e35ec1055c7c55089d370"
				}
			}
		}
	},
	{
		"id": "nova",
		"name": "Nova",
		"version": "1.1.51",
		"description": "Nova by Compass AI - a fully-fledged software engineer at your command",
		"website": "https://www.compassap.ai/portfolio/nova.html",
		"repository": "https://github.com/Compass-Agentic-Platform/nova",
		"authors": [
			"Compass AI"
		],
		"license": "proprietary",
		"icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/nova.svg",
		"distribution": {
			"npx": {
				"package": "@compass-ai/nova@1.1.51",
				"args": [
					"acp"
				],
				"env": {}
			}
		}
	},
	{
		"id": "opencode",
		"name": "OpenCode",
		"version": "1.18.35",
		"description": "The open source coding agent",
		"website": "https://opencode.ai",
		"repository": "https://github.com/anomalyco/opencode",
		"authors": [
			"Anomaly"
		],
		"license": "MIT",
		"icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/opencode.svg",
		"distribution": {
			"binary": {
				"darwin-aarch64": {
					"archive": "https://github.com/anomalyco/opencode/releases/download/v1.18.35/opencode-darwin-arm64.zip",
					"cmd": "./opencode",
					"args": [
						"acp"
					],
					"env": {},
					"sha256": "80b05124357a77cd57945bfde36082a028e829c198d222d5e146617f49a2c4b7"
				},
				"darwin-x86_64": {
					"archive": "https://github.com/anomalyco/opencode/releases/download/v1.18.35/opencode-darwin-x64.zip",
					"cmd": "./opencode",
					"args": [
						"acp"
					],
					"env": {},
					"sha256": "8127d69e8e94d7adc496e910435f2f73856d87d456e988d3a947f250c95c1be2"
				},
				"linux-aarch64": {
					"archive": "https://github.com/anomalyco/opencode/releases/download/v1.18.35/opencode-linux-arm64.tar.gz",
					"cmd": "./opencode",
					"args": [
						"acp"
					],
					"env": {},
					"sha256": "f7f2ba59ee8aa94d388f9696575a32d20e71c2ee48def9f80fc693a60fec6c72"
				},
				"linux-x86_64": {
					"archive": "https://github.com/anomalyco/opencode/releases/download/v1.18.35/opencode-linux-x64.tar.gz",
					"cmd": "./opencode",
					"args": [
						"acp"
					],
					"env": {},
					"sha256": "c8f888b451f5494a18f858fffb0e0b68f4e4baa9c241761c5f206884f0fa640d"
				},
				"windows-aarch64": {
					"archive": "https://github.com/anomalyco/opencode/releases/download/v1.18.35/opencode-windows-arm64.zip",
					"cmd": "./opencode",
					"args": [
						"acp"
					],
					"env": {},
					"sha256": "3c144f54fea5d56afb00174fd3134709803a7bb6ce990963044831b671bd9882"
				},
				"windows-x86_64": {
					"archive": "https://github.com/anomalyco/opencode/releases/download/v1.18.35/opencode-windows-x64.zip",
					"cmd": "./opencode.exe",
					"args": [
						"acp"
					],
					"env": {},
					"sha256": "c90d248cca75e42fd15422a29b5f83a1b30c441af83565635d6b2682adc58dd1"
				}
			}
		}
	},
	{
		"id": "pi-acp",
		"name": "pi ACP",
		"version": "0.0.34",
		"description": "ACP adapter for pi coding agent",
		"repository": "https://github.com/svkozak/pi-acp",
		"authors": [
			"Sergii Kozak <svkozak@gmail.com>"
		],
		"license": "MIT",
		"icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/pi-acp.svg",
		"distribution": {
			"npx": {
				"package": "pi-acp@0.0.34",
				"args": [],
				"env": {}
			}
		}
	},
	{
		"id": "poolside",
		"name": "Poolside",
		"version": "1.0.16",
		"description": "Poolside's coding agent",
		"website": "https://poolside.ai",
		"repository": "https://github.com/poolsideai/pool",
		"authors": [
			"Poolside <feedback@poolside.ai>"
		],
		"license": "proprietary",
		"icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/poolside.svg",
		"distribution": {
			"binary": {
				"darwin-aarch64": {
					"archive": "https://downloads.poolside.ai/pool/v1.0.16/pool-darwin-arm64.tar.gz",
					"cmd": "./pool-darwin-arm64",
					"args": [
						"acp"
					],
					"env": {},
					"sha256": "0932af3eb2b57a863acacb664ec8b2b1d3a76c2570a788b086001608cc585f74"
				},
				"darwin-x86_64": {
					"archive": "https://downloads.poolside.ai/pool/v1.0.16/pool-darwin-amd64.tar.gz",
					"cmd": "./pool-darwin-amd64",
					"args": [
						"acp"
					],
					"env": {},
					"sha256": "6d75fae2d7de6c35b6b467b5f682935e3ecde8ff611cb620c56b7bd607e0afde"
				},
				"linux-aarch64": {
					"archive": "https://downloads.poolside.ai/pool/v1.0.16/pool-linux-arm64.tar.gz",
					"cmd": "./pool-linux-arm64",
					"args": [
						"acp"
					],
					"env": {},
					"sha256": "466343b66b03ee4e66476fcc69be1eb5bf8e9155a4ab73e0e72a232d1f8d2a12"
				},
				"linux-x86_64": {
					"archive": "https://downloads.poolside.ai/pool/v1.0.16/pool-linux-amd64.tar.gz",
					"cmd": "./pool-linux-amd64",
					"args": [
						"acp"
					],
					"env": {},
					"sha256": "e86aa8c9feef003540673ab494e91bfadc273218d531c43d662cafb69e464146"
				},
				"windows-aarch64": {
					"archive": "https://downloads.poolside.ai/pool/v1.0.16/pool-windows-arm64.tar.gz",
					"cmd": "./pool-windows-arm64.exe",
					"args": [
						"acp"
					],
					"env": {},
					"sha256": "8dc7d014ced3e9d3ced240bbc7dabaf696bf59f118bd271d9f4e8561e415d75b"
				},
				"windows-x86_64": {
					"archive": "https://downloads.poolside.ai/pool/v1.0.16/pool-windows-amd64.tar.gz",
					"cmd": "./pool-windows-amd64.exe",
					"args": [
						"acp"
					],
					"env": {},
					"sha256": "3e324f1a4b5855ba5363232c06461ec9d6d2ae1a341c827221e79779f8f2bc6f"
				}
			}
		}
	},
	{
		"id": "qoder",
		"name": "Qoder CLI",
		"version": "0.2.14",
		"description": "AI coding assistant with agentic capabilities",
		"website": "https://qoder.com",
		"authors": [
			"Qoder AI"
		],
		"license": "proprietary",
		"icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/qoder.svg",
		"distribution": {
			"npx": {
				"package": "@qoder-ai/qodercli@0.2.14",
				"args": [
					"--acp"
				],
				"env": {}
			}
		}
	},
	{
		"id": "qwen-code",
		"name": "Qwen Code",
		"version": "0.25.0",
		"description": "Alibaba's Qwen coding assistant",
		"website": "https://qwenlm.github.io/qwen-code-docs/en/users/overview",
		"repository": "https://github.com/QwenLM/qwen-code",
		"authors": [
			"Alibaba Qwen Team"
		],
		"license": "Apache-2.0",
		"icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/qwen-code.svg",
		"distribution": {
			"npx": {
				"package": "@qwen-code/qwen-code@0.25.0",
				"args": [
					"--acp",
					"--experimental-skills"
				],
				"env": {}
			}
		}
	},
	{
		"id": "sigit",
		"name": "siGit Code",
		"version": "1.6.6",
		"description": "Local-first coding agent. Runs entirely on your machine with optional on-device LLM inference via Onde.",
		"website": "https://github.com/getsigit/sigit",
		"repository": "https://github.com/getsigit/sigit",
		"authors": [
			"smbCloud"
		],
		"license": "Apache-2.0",
		"icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/sigit.svg",
		"distribution": {
			"npx": {
				"package": "@smbcloud/sigit@1.6.6",
				"args": [],
				"env": {}
			},
			"binary": {
				"darwin-aarch64": {
					"archive": "https://github.com/getsigit/sigit/releases/download/v1.6.6/sigit-macos-arm64.tar.gz",
					"cmd": "./sigit",
					"args": [],
					"env": {},
					"sha256": "98661333d902953b4df41c2893e711d39da6f0243bad711bb96e830e08857c42"
				},
				"darwin-x86_64": {
					"archive": "https://github.com/getsigit/sigit/releases/download/v1.6.6/sigit-macos-amd64.tar.gz",
					"cmd": "./sigit",
					"args": [],
					"env": {},
					"sha256": "5707db94dabcff022d5dc4624abc1b331167ecc091c7580a11b886f47efda45f"
				},
				"linux-aarch64": {
					"archive": "https://github.com/getsigit/sigit/releases/download/v1.6.6/sigit-linux-arm64",
					"cmd": "./sigit-linux-arm64",
					"args": [],
					"env": {},
					"sha256": "27564ef77f6f5a8875e3224c2eb34c2abef4ae0e76226ee6552761bad7a29943"
				},
				"linux-x86_64": {
					"archive": "https://github.com/getsigit/sigit/releases/download/v1.6.6/sigit-linux-amd64",
					"cmd": "./sigit-linux-amd64",
					"args": [],
					"env": {},
					"sha256": "0e8b75c8c328120469733464d9fe132934a62d5c2493572fa7a612e5671dda83"
				},
				"windows-aarch64": {
					"archive": "https://github.com/getsigit/sigit/releases/download/v1.6.6/sigit-win-arm64.exe",
					"cmd": "./sigit-win-arm64.exe",
					"args": [],
					"env": {},
					"sha256": "6306bddd2beaf786af9cdda1a7da0daf61d1727624dbe0487e5d879949adc5fe"
				},
				"windows-x86_64": {
					"archive": "https://github.com/getsigit/sigit/releases/download/v1.6.6/sigit-win-amd64.exe",
					"cmd": "./sigit-win-amd64.exe",
					"args": [],
					"env": {},
					"sha256": "b580eb8e8644b3730071df8f7b095440afe1432ac65eaf4223465bd54a60c809"
				}
			}
		}
	},
	{
		"id": "stakpak",
		"name": "Stakpak",
		"version": "0.3.88",
		"description": "Open-source DevOps agent in Rust with enterprise-grade security",
		"website": "https://stakpak.dev",
		"repository": "https://github.com/stakpak/agent",
		"authors": [
			"Stakpak Team <contact@stakpak.dev>"
		],
		"license": "Apache-2.0",
		"icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/stakpak.svg",
		"distribution": {
			"binary": {
				"darwin-aarch64": {
					"archive": "https://github.com/stakpak/agent/releases/download/v0.3.88/stakpak-darwin-aarch64.tar.gz",
					"cmd": "./stakpak",
					"args": [
						"acp"
					],
					"env": {}
				},
				"darwin-x86_64": {
					"archive": "https://github.com/stakpak/agent/releases/download/v0.3.88/stakpak-darwin-x86_64.tar.gz",
					"cmd": "./stakpak",
					"args": [
						"acp"
					],
					"env": {}
				},
				"linux-aarch64": {
					"archive": "https://github.com/stakpak/agent/releases/download/v0.3.88/stakpak-linux-aarch64.tar.gz",
					"cmd": "./stakpak",
					"args": [
						"acp"
					],
					"env": {}
				},
				"linux-x86_64": {
					"archive": "https://github.com/stakpak/agent/releases/download/v0.3.88/stakpak-linux-x86_64.tar.gz",
					"cmd": "./stakpak",
					"args": [
						"acp"
					],
					"env": {}
				},
				"windows-x86_64": {
					"archive": "https://github.com/stakpak/agent/releases/download/v0.3.88/stakpak-windows-x86_64.zip",
					"cmd": "./stakpak.exe",
					"args": [
						"acp"
					],
					"env": {}
				}
			}
		}
	},
	{
		"id": "vtcode",
		"name": "VT Code",
		"version": "0.96.14",
		"description": "An open-source coding agent with LLM-native code understanding and robust shell safety. Supports multiple LLM providers with automatic failover and efficient context management.",
		"website": "https://github.com/vinhnx/VTCode/blob/main/docs/guides/zed-acp.md",
		"repository": "https://github.com/vinhnx/VTCode",
		"authors": [
			"vinhnx"
		],
		"license": "MIT",
		"icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/vtcode.svg",
		"distribution": {
			"binary": {
				"darwin-aarch64": {
					"archive": "https://github.com/vinhnx/VTCode/releases/download/0.96.14/vtcode-0.96.14-aarch64-apple-darwin.tar.gz",
					"cmd": "./vtcode",
					"args": [
						"acp"
					],
					"env": {
						"VT_ACP_ENABLED": "1",
						"VT_ACP_ZED_ENABLED": "1"
					}
				},
				"darwin-x86_64": {
					"archive": "https://github.com/vinhnx/VTCode/releases/download/0.96.14/vtcode-0.96.14-x86_64-apple-darwin.tar.gz",
					"cmd": "./vtcode",
					"args": [
						"acp"
					],
					"env": {
						"VT_ACP_ENABLED": "1",
						"VT_ACP_ZED_ENABLED": "1"
					}
				},
				"linux-x86_64": {
					"archive": "https://github.com/vinhnx/VTCode/releases/download/0.96.14/vtcode-0.96.14-x86_64-unknown-linux-gnu.tar.gz",
					"cmd": "./vtcode",
					"args": [
						"acp"
					],
					"env": {
						"VT_ACP_ENABLED": "1",
						"VT_ACP_ZED_ENABLED": "1"
					}
				},
				"windows-x86_64": {
					"archive": "https://github.com/vinhnx/VTCode/releases/download/0.96.14/vtcode-0.96.14-x86_64-pc-windows-msvc.zip",
					"cmd": "vtcode.exe",
					"args": [
						"acp"
					],
					"env": {
						"VT_ACP_ENABLED": "1",
						"VT_ACP_ZED_ENABLED": "1"
					}
				}
			}
		}
	}
];
