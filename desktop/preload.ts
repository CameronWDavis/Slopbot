// Exposes a narrow, typed API to the sandboxed renderer. No Node access leaks through.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { AgentEvent, ApprovalRequest, SlopbotApi } from "./api.js";

const subscribe = <T>(channel: string, cb: (payload: T) => void) => {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => void ipcRenderer.removeListener(channel, listener);
};

const api: SlopbotApi = {
  info: () => ipcRenderer.invoke("info"),
  listBots: () => ipcRenderer.invoke("bots:list"),
  listModels: () => ipcRenderer.invoke("models:list"),
  send: (bot, text, model) => ipcRenderer.invoke("chat:send", bot, text, model),
  reset: (bot) => ipcRenderer.invoke("chat:reset", bot),
  answerApproval: (id, answer) => ipcRenderer.invoke("approval:answer", id, answer),
  listApprovals: () => ipcRenderer.invoke("approvals:list"),
  resolveApproval: (id, approve) => ipcRenderer.invoke("approvals:resolve", id, approve),
  activity: (limit) => ipcRenderer.invoke("activity", limit),
  memory: (bot) => ipcRenderer.invoke("memory", bot),
  openDataDir: () => ipcRenderer.invoke("open:data"),
  mcpList: () => ipcRenderer.invoke("mcp:list"),
  mcpConnect: (name) => ipcRenderer.invoke("mcp:connect", name),
  mcpTest: (name, def) => ipcRenderer.invoke("mcp:test", name, def),
  mcpSave: (name, def, previousName) => ipcRenderer.invoke("mcp:save", name, def, previousName),
  mcpRemove: (name) => ipcRenderer.invoke("mcp:remove", name),
  mcpImport: (json, bots) => ipcRenderer.invoke("mcp:import", json, bots),
  onEvent: (cb) => subscribe<AgentEvent>("agent:event", cb),
  onApprovalRequest: (cb) => subscribe<ApprovalRequest>("approval:request", cb),
};

contextBridge.exposeInMainWorld("slopbot", api);
