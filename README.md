# Computer MCP

[Leia em português](README.pt-BR.md)

Computer MCP, or pc-mcp, is a small server that gives AI agents controlled access to your computer through the Model Context Protocol. With it running, an agent can browse and edit files, search, organize folders, create and extract zip files, run terminal commands, start and control background processes and move files between your PC and the sandbox it works in.

When it starts, the server creates an access token and opens a public address through a Cloudflare tunnel, downloading cloudflared the first time if it is not installed. It then shows the address and the token to paste into any MCP client and opens a status page in the browser. If you prefer, the tunnel can be turned off to use only the local network, or pointed to your own address from ngrok or a named Cloudflare tunnel.

Since this hands a lot of power to an agent, there are a few ways to limit it. By default it can see the whole computer, but you can restrict access to specific folders, start in read only mode, which blocks writing, moving, deleting, the terminal and imports, or keep the files open and only turn off the terminal. Download and upload links expire after two hours by default.

## How to use

You need Node.js 18.17 or newer. On Windows, double click Iniciar pc-mcp.bat, or the read only version next to it. On Mac or Linux run iniciar.sh, which also builds the project the first time. After that, copy the address and the token into your MCP client.

If you prefer to do it by hand, run npm install, npm run build and npm start. Running it with the --help option lists everything you can change, like the port, the tunnel mode, the allowed folders and the default shell. Options can be saved for the next runs and can also come from environment variables such as PC_MCP_TOKEN and PC_MCP_PORT.

## Development time

Computer MCP was built in one hour.

## License

GNU General Public License version 3. The full text is in the LICENSE file.
