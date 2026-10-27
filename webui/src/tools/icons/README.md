# Tool brand icons

These are a deliberately small, vendored set of local SVGs so the UI works offline.

## Brand/tool marks

Git, pnpm, npm, Yarn, Bun, Rust, Python, Docker, GitHub, and Vite are unmodified files from [Simple Icons](https://github.com/simple-icons/simple-icons) version `16.29.0` (`icons/` directory).

## Shell marks

Bash and PowerShell are unmodified files from [Devicon](https://github.com/devicons/devicon) version `2.17.0` (`icons/bash/bash-original.svg` and `icons/powershell/powershell-original.svg`). Devicon's repository code is MIT-licensed; product names and logos remain the property of their respective owners and must follow their brand policies.

`powershell-glyph.svg` is **derived** from that same Devicon file: the two background plates
(the light and the dark rounded slab) are removed, leaving only the chevron and the underscore.
The original stacks a white chevron on top of a filled plate, so a silhouette-only rendering
(the UI draws these marks as CSS masks, see `.tool-command-icon` in `src/styles/components/tools.css`)
collapsed into a blank slab. The unmodified `powershell.svg` is kept alongside for reference.

Simple Icons artwork is distributed under CC0-1.0. Product names and logos may still be trademarks of their respective owners; these marks are used only to identify the command shown in the tool summary. See the [Simple Icons disclaimer](https://github.com/simple-icons/simple-icons/blob/develop/DISCLAIMER.md) and each brand's usage guidance where applicable.

To add an icon, add its SVG here, document its source/version, and map command aliases in `../command-icons.ts`. Keep the generic terminal glyph as the fallback for unknown commands.
