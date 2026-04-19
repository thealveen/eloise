export type McpServerConfig = {
  name: string;
  transport: "http" | "stdio";
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
};

export type McpConfig = {
  servers: McpServerConfig[];
};
