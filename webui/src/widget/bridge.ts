/**
 * widget-directive §3：注入沙箱 srcdoc 的宿主桥源码（window.qqh）。
 *
 * 加固（照抄 Codex）：在任何受信片段之前，用 PropertyDescriptor 预捕获将被
 * 不受信 fragment 可能篡改的宿主原语，之后一律 Reflect.apply 调用。
 * 通道：握手后走 MessagePort；本脚本经 iframe.srcdoc 前缀注入，与 fragment
 * 同处 opaque-origin 沙箱（sandbox 不含 allow-same-origin）。
 */

/**
 * 桥源码。必须是自包含 IIFE 字符串（无模板插值、无外部依赖）。
 * 消息协议（port 上 JSON）：
 *   iframe → host: {t:"state",modelContent,privateContent} / {t:"height",h}
 *                  / {t:"followUp",prompt,title} / {t:"openExternal",href}
 *   host → iframe: {t:"port"}（握手移交，经 contentWindow.postMessage）
 */
export const BRIDGE_SOURCE = String.raw`'use strict';
(function () {
  if (window.qqh) return;
  // ── 原型预捕获（不受信代码执行前的唯一机会）──────────────────────────
  var d = Object.getOwnPropertyDescriptor;
  var apply = Reflect.apply;
  var portProto = MessagePort.prototype;
  var eventProto = MessageEvent.prototype;
  var mpPostMessage = d(portProto, 'postMessage').value;
  // MessagePort 继承 EventTarget：addEventListener 的宿主是 EventTarget.prototype。
  var mpAddEventListener = d(EventTarget.prototype, 'addEventListener').value;
  var mpStart = d(portProto, 'start').value;
  var meData = d(eventProto, 'data').get;
  var mePorts = d(eventProto, 'ports').get;
  // Chromium 把 Window.postMessage 挂成 window 的 own 属性（原型上没有）。
  var wpPostMessage = d(window, 'postMessage').value;
  var jsonParse = JSON.parse;
  var jsonStringify = JSON.stringify;
  var encoder = new TextEncoder();
  var textEncode = d(TextEncoder.prototype, 'encode').value;
  var MAX_STATE_BYTES = 16384; // spec §3：TextEncoder UTF-8 字节闸
  var port = null;
  var earlyQueue = [];
  function readData(event) { return apply(meData, event, []); }
  function readPorts(event) { return apply(mePorts, event, []); }
  function postToParent(target, message, transfer) {
    if (target) apply(wpPostMessage, target, [message, '*', transfer]);
  }
  function post(message) {
    // 握手完成前（fragment 可能同步就调 API）：入队，port 就绪即冲刷。
    if (port) apply(mpPostMessage, port, [message]);
    else earlyQueue.push(message);
  }
  // ── 初始状态：宿主替换的占位 JSON ────────────────────────────────────
  var state = null;
  var el = document.getElementById('qqh-widget-state');
  if (el) {
    try { state = jsonParse(el.textContent); } catch (e) { state = null; }
    el.remove();
  }
  function bytesOf(value) {
    return apply(textEncode, encoder, [jsonStringify(value)]).length;
  }
  // ── window.qqh 公共面 ────────────────────────────────────────────────
  window.qqh = {
    widgetState: state,
    setWidgetState: function (snapshot) {
      if (!snapshot || typeof snapshot !== 'object') {
        throw new TypeError('qqh.setWidgetState requires {modelContent, privateContent}');
      }
      var modelContent = snapshot.modelContent === undefined ? null : snapshot.modelContent;
      var privateContent = snapshot.privateContent === undefined ? null : snapshot.privateContent;
      if (bytesOf({ m: modelContent, p: privateContent }) > MAX_STATE_BYTES) {
        throw new TypeError('qqh.setWidgetState exceeds the 16KiB model+private budget');
      }
      // 乐观更新：本地先换引用，再上报（保存永不触发 turn）。
      state = { modelContent: modelContent, privateContent: privateContent };
      window.qqh.widgetState = state;
      post({ t: 'state', modelContent: modelContent, privateContent: privateContent });
    },
    sendFollowUpMessage: function (request) {
      if (!request || typeof request.prompt !== 'string' || !request.prompt) {
        throw new TypeError('qqh.sendFollowUpMessage requires {prompt, title}');
      }
      var title = typeof request.title === 'string' ? request.title.slice(0, 250) : '';
      post({ t: 'followUp', prompt: request.prompt, title: title });
    },
    openExternal: function (request) {
      var href = request && request.href;
      if (typeof href !== 'string' || !/^https?:/i.test(href)) {
        throw new TypeError('qqh.openExternal requires an absolute http(s) href');
      }
      post({ t: 'openExternal', href: href });
    },
  };
  // ── 高度回报：ResizeObserver → sendHeight ────────────────────────────
  var sendHeight = function () {
    var h = Math.ceil(document.documentElement.getBoundingClientRect().height);
    if (isFinite(h) && h > 0) post({ t: 'height', h: h });
  };
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(sendHeight).observe(document.documentElement);
  }
  window.addEventListener('load', sendHeight);
  document.addEventListener('DOMContentLoaded', sendHeight);
  sendHeight();
  // ── 握手：ready → host 移交 MessagePort ──────────────────────────────
  window.addEventListener('message', function (event) {
    var data = readData(event);
    if (!data || data.t !== 'port-handshake' || port) return;
    var found = readPorts(event);
    if (!found || found.length !== 1) return;
    port = found[0];
    while (earlyQueue.length > 0) apply(mpPostMessage, port, [earlyQueue.shift()]);
    apply(mpAddEventListener, port, ['message', function (message) {
      var inbound = readData(message);
      // v1 host 不向 iframe 推业务消息；保留通道供后续扩展（P2 callTool 等）。
      if (inbound && inbound.t === 'state') window.qqh.widgetState = inbound.state;
    }]);
    apply(mpStart, port, []);
  });
  postToParent(window.parent, { t: 'ready' });
})();
`;
