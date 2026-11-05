export const SETTINGS_NAV = [
  { id: "section-providers", label: "服务商", group: "接入" },
  { id: "section-pairing", label: "设备配对", group: "接入" },
  { id: "section-permission", label: "权限档位", group: "运行" },
  { id: "section-context", label: "上下文", group: "运行" },
  { id: "section-runtime", label: "运行时", group: "运行" },
  { id: "section-host", label: "桌面壳", group: "运行" },
  { id: "section-subagent", label: "子代理", group: "运行" },
  { id: "section-mcp", label: "MCP / LSP", group: "运行" },
  { id: "section-appearance", label: "外观", group: "界面" },
  { id: "section-about", label: "关于", group: "关于" },
] as const;


export const SETTINGS_NAV_GROUPS = ["接入", "运行", "界面", "关于"] as const;
