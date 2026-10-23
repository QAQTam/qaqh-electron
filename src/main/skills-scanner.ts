import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { UserSkillsWire, UserSkillRoot, UserSkillFile, UserSkillDiagnostic } from "./types.js";

const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

export async function scanUserSkills(): Promise<UserSkillsWire> {
  const home = homedir();
  const rootsToScan = [
    { path: join(home, ".qaqh", "skills"), label: "~/.qaqh/skills" },
    { path: join(home, ".agents", "skills"), label: "~/.agents/skills" },
  ];

  const roots: UserSkillRoot[] = [];
  const skills: UserSkillFile[] = [];
  const diagnostics: UserSkillDiagnostic[] = [];
  let totalBytes = 0;

  for (const r of rootsToScan) {
    const exists = existsSync(r.path);
    roots.push({
      path: r.path,
      label: r.label,
      exists,
    });

    if (!exists) continue;

    try {
      const entries = readdirSync(r.path, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillDir = join(r.path, entry.name);
        const skillMd = join(skillDir, "SKILL.md");

        if (existsSync(skillMd)) {
          try {
            const st = statSync(skillMd);
            if (st.size > MAX_FILE_BYTES) {
              diagnostics.push({
                path: skillMd,
                message: `File exceeds maximum allowed size of ${MAX_FILE_BYTES} bytes (${st.size} bytes)`,
              });
              continue;
            }

            if (totalBytes + st.size > MAX_TOTAL_BYTES) {
              diagnostics.push({
                path: skillMd,
                message: "Total skills size cap exceeded (8MB)",
              });
              break;
            }

            const content = readFileSync(skillMd, "utf-8").replace(/\r\n/g, "\n");
            skills.push({
              root: r.path,
              path: skillMd,
              content,
              bytes: st.size,
            });
            totalBytes += st.size;
          } catch (err: any) {
            diagnostics.push({
              path: skillMd,
              message: `Error reading file: ${err.message}`,
            });
          }
        }
      }
    } catch (err: any) {
      diagnostics.push({
        path: r.path,
        message: `Error scanning directory: ${err.message}`,
      });
    }
  }

  return {
    roots,
    skills,
    diagnostics,
  };
}
