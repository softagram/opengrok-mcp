# OpenGrok MCP Server

I created this project to provide an MCP (Model Context Protocol) server for integrating OpenGrok code search with the MCP ecosystem. It enables you to perform code searches (full text, definitions, symbols, file paths, and file types) in your OpenGrok instance via chat-style commands or programmatic requests—directly from your IDE.

## Features
- Full-text search in code repositories
- Search for definitions, symbols, file paths, and file types
- Chat-style command support (e.g., `search_full_text, project=pro, full_text=python`)
- Seamless integration with MCP clients and tools

## Prerequisites
- Node.js (v18+ recommended)
- Access to an OpenGrok instance with user and password credentials

## Installation
Clone this repository and install dependencies:

```sh
npm install
```

Build the project:

```sh
npm run build
```

## Configuration
Set the following environment variables:

- `OPENGROK_URL`: Base URL of your OpenGrok instance (without `/source`, e.g., `https://opengrok.example.com`)
- `OPENGROK_USERNAME`: Your OpenGrok username
- `OPENGROK_PASSWORD`: Your OpenGrok password

You can set these in your environment or configure them in your VS Code `settings.json`:

```json
"mcp": {
  "inputs": [
    { "id": "opengrok_base_url", "type": "promptString", "description": "Enter OpenGrok Base URL" },
    { "id": "opengrok_username", "type": "promptString", "description": "Your OpenGrok Username" },
    { "id": "opengrok_password", "type": "promptString", "description": "Your OpenGrok Password", "password": true }
  ],
  "servers": {
    "mcp-opengrok": {
      "command": "node",
      "args": ["<full_path>/dist/index.js"],
      "env": {
        "OPENGROK_URL": "${input:opengrok_base_url}",
        "OPENGROK_USERNAME": "${input:opengrok_username}",
        "OPENGROK_PASSWORD": "${input:opengrok_password}"
      }
    }
  }
}
```

## Usage
Start the server:

```sh
node dist/index.js
```

Or, if using VS Code MCP integration, the server will be started automatically with the correct environment.

### Example Chat Commands
- Search full text:
  `search_full_text, project=jess_main, full_text=python`
- Search by type:
  `search_by_type, project=pro, type=python`
- Search for a symbol:
  `search_symbol, project=pro, symbol=MyFunction`

## Development
- Source code is in the `src` directory.
- TypeScript is used; build output is in `dist`.
- Dockerfile is provided for containerized builds.

