import { BrowserWindow } from "electron";
import { join } from "node:path";
import type { RingingClient } from "./ringing-client.js";

const pickerWebContents = new Set<number>();

export function isModelPickerWindow(webContentsId: number): boolean {
  return pickerWebContents.has(webContentsId);
}

export const MODEL_PICKER_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>选择会话模型</title><style>
*{box-sizing:border-box}body{margin:0;background:#18181b;color:#f4f4f5;font:14px system-ui,sans-serif}main{padding:24px;max-width:560px;margin:auto}h1{font-size:20px;margin:0 0 8px}p{color:#a1a1aa;margin:0 0 20px}.field{display:grid;gap:7px;margin:16px 0}label{color:#d4d4d8;font-weight:600}select{width:100%;border:1px solid #3f3f46;border-radius:9px;background:#27272a;color:#fafafa;padding:11px;font:inherit}.row{display:grid;grid-template-columns:1fr 1fr;gap:14px}.notice{min-height:20px;color:#fbbf24;font-size:12px}.actions{display:flex;align-items:center;justify-content:space-between;margin-top:24px;gap:12px}.check{display:flex;align-items:center;gap:8px;color:#d4d4d8}button{border:0;border-radius:9px;background:#5b78aa;color:white;padding:10px 18px;font:inherit;font-weight:650;cursor:pointer}button:disabled{opacity:.55;cursor:wait}.secondary{background:#3f3f46}.error{color:#fca5a5;white-space:pre-wrap;margin-top:12px}
</style></head><body><main>
<h1 id="title">选择 Provider 与模型</h1><p id="subtitle">此选择仅对当前会话生效，不会改写全局连接配置。</p>
<div class="field"><label for="provider">Provider / 配置</label><select id="provider"></select></div>
<div class="row"><div class="field"><label for="model">模型</label><select id="model"></select></div><div class="field"><label for="effort">推理强度</label><select id="effort"><option value="">跟随配置</option><option>low</option><option>medium</option><option>high</option><option>xhigh</option><option>max</option><option>ultra</option></select></div></div>
<div id="notice" class="notice"></div>
<div class="actions"><label class="check"><input id="also-default" type="checkbox"> 同时作为新会话默认</label><div><button id="follow-global" class="secondary">跟随全局</button> <button id="cancel" class="secondary">取消</button> <button id="save">应用</button></div></div>
<div id="error" class="error"></div></main>
<script>
const $=id=>document.getElementById(id);let data=null;let currentSelection=null;let targetSeed=null;
function option(select,value,label){const node=document.createElement('option');node.value=value;node.textContent=label;select.append(node)}
function fillModels(providerId,selected){const select=$('model');select.replaceChildren();const profile=data.profiles.find(p=>p.id===providerId);const models=data.modelsByProvider[providerId]||[];for(const model of models)option(select,model.id,model.display_name+'  ·  '+model.id);if(!models.length&&profile?.model)option(select,profile.model,profile.model);if(selected&&![...select.options].some(o=>o.value===selected))option(select,selected,selected+'  ·  当前会话模型（目录外）');if(selected)select.value=selected;const problem=data.modelErrors[providerId];$('notice').textContent=problem?'模型目录读取失败，已回退到可用配置：'+problem:''}
function setSelection(selection){if(!selection)return;const provider=data.profiles.find(p=>p.id===selection.provider_id);if(provider){$('provider').value=provider.id;fillModels(provider.id,selection.model_id);$('effort').value=selection.reasoning_effort||provider.reasoning_effort||''}}
async function init(){try{targetSeed=new URLSearchParams(location.search).get('session')||null;data=await window.qaqhHost.modelPicker.load({sessionId:targetSeed});currentSelection=data.selection;if(targetSeed){$('title').textContent='选择当前会话模型';$('subtitle').textContent='仅更改此会话。其他会话和全局默认不会变化。';$('also-default').checked=false;$('also-default').closest('label').style.display='none'}else{$('title').textContent='新会话默认模型';$('subtitle').textContent='新会话将使用此 Provider / 模型，不改写全局连接配置。'}
for(const profile of data.profiles)option($('provider'),profile.id,profile.id+'  ·  '+profile.credential.replaceAll('_',' ')+(profile.has_api_key?'  ·  已保存凭据':''));if(data.selection)setSelection(data.selection);else if(data.profiles.length){$('provider').value=data.activeProfile||data.profiles[0].id;fillModels($('provider').value,data.profiles.find(p=>p.id===$('provider').value)?.model)}
 $('provider').addEventListener('change',()=>{const p=data.profiles.find(p=>p.id===$('provider').value);fillModels($('provider').value,p?.model);$('effort').value=p?.reasoning_effort||''});$('cancel').onclick=()=>window.close();$('follow-global').textContent=targetSeed?'跟随全局':'清除默认';$('follow-global').onclick=async()=>{ $('follow-global').disabled=true;$('error').textContent='';try{await window.qaqhHost.modelPicker.save({sessionId:targetSeed,selection:null,alsoDefault:!targetSeed});window.close()}catch(error){$('error').textContent=String(error);$('follow-global').disabled=false}};$('save').onclick=async()=>{const providerId=$('provider').value,modelId=$('model').value;if(!providerId||!modelId){$('error').textContent='请选择有效的配置和模型。';return}const selection={provider_id:providerId,model_id:modelId,...($('effort').value?{reasoning_effort:$('effort').value}:{})};$('save').disabled=true;$('error').textContent='';try{await window.qaqhHost.modelPicker.save({sessionId:targetSeed,selection,alsoDefault:$('also-default').checked});window.close()}catch(error){$('error').textContent=String(error);$('save').disabled=false}};
}catch(error){$('error').textContent='读取模型配置失败：'+String(error);$('save').disabled=true}}
void init();
</script></body></html>`;

export function openModelPicker(client: RingingClient, targetSeed: string | null): BrowserWindow {
  const win = new BrowserWindow({
    width: 580,
    height: 570,
    minWidth: 480,
    minHeight: 520,
    title: "选择会话模型",
    parent: BrowserWindow.getFocusedWindow() ?? undefined,
    modal: BrowserWindow.getFocusedWindow() != null,
    show: false,
    backgroundColor: "#18181b",
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  pickerWebContents.add(win.webContents.id);
  win.on("closed", () => pickerWebContents.delete(win.webContents.id));
  win.once("ready-to-show", () => win.show());
  const query = targetSeed ? `?session=${encodeURIComponent(targetSeed)}` : "";
  void win.loadURL(`app://localhost/model-picker${query}`).catch((error) => console.error("[model-picker] failed to open:", error));
  return win;
}
