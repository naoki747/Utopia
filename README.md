# Bloxd.io Dedicated Proxy

A dedicated proxy server tailored for Bloxd.io.

## Features
- **Direct Path Mapping**: Accessing `your-domain.com/game` automatically routes to `bloxd.io/game` via Ultraviolet proxy.
- **Worker & Asset Patching**: Automatically patches Bloxd.io Service Workers and WebAssembly resource requests.
- **Clean Interface**: Fast, lightweight loading.

## Setup & Running

```bash
# Install dependencies
npm install

# Start the server
npm start
```

Default server runs on `http://localhost:8080`.
