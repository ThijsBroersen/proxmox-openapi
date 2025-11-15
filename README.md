# This project contains an openapi generator for Proxmox

This is an unofficial openapi generator for Proxmox. It is not affiliated with Proxmox or its developers. The generated spec is valid but I only tested a limited number of endpoints.

The api reference is from the Proxmox documentation -> [api-viewer](https://pve.proxmox.com/pve-docs/api-viewer)

## Proxmox API Reference

Based on [apidoc.js](https://pve.proxmox.com/pve-docs/api-viewer/apidoc.js) `generate-openapi.js` renders a valid openapi spec.

## Usage

```bash
npm install
npm run download
npm run generate
```

The generated spec is in `openapi.yaml`.

## License

This project is licensed under the MIT License - see the [LICENSE.md](LICENSE.md) file for details.
