//! Node-API bindings over `qaqh-client` for the QAQ-Harness Electron shell.
//!
//! 与 `qaqh-ffi`（Android/UniFFI）、`qaqh-harmony-napi`（OpenHarmony）同构：
//! 协议语义全部留在 `qaqh-client`，本层只做类型搬运（serde JSON ↔ JS 值）与
//! 生命周期桥接（tokio 任务 ↔ JS 回调）。electron 的 main 进程是唯一消费者；
//! renderer 仍然只走宿主 IPC。
//!
//! 错误模型：`qaqh_client::ClientError` 映射为 napi `Error`，`message` 是一段
//! JSON（`{"kind","status","code","commandId","retryAfterMs","ack"}`），TS 侧
//! [`NativeClientError`] 解包成结构化错误——保持旧 `@qaqh/sdk` 的
//! `SdkError.kind` 语义（尤其 `command_rejected` 携带原始 rejected ack）。
#![cfg_attr(not(debug_assertions), deny(unsafe_code))]

use std::collections::HashMap;
use std::sync::Mutex;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{Error, Result, Status};
use napi_derive::napi;
use qaqh_client::{
    Client, ClientHandlers, ClientOptions, CommandOptions, CommandTarget, PairScope,
    QueryRequest, RemoteEndpoint, RingingCommand, RingingV2ClientKind, StopStatus,
};
use serde_json::{Value, json};

/// 绑定层结构化错误：message 承载 JSON，TS 侧解包。
fn structured_error(kind: &str, payload: Value) -> Error {
    let mut body = payload;
    body["kind"] = json!(kind);
    Error::new(
        Status::GenericFailure,
        serde_json::to_string(&body).unwrap_or_else(|_| format!(r#"{{"kind":"{kind}"}}"#)),
    )
}

fn json_error(kind: &str, message: String) -> Error {
    structured_error(kind, json!({ "message": message }))
}

/// `qaqh_client::ClientError` → 结构化 napi 错误。
fn client_error(err: qaqh_client::ClientError) -> Error {
    use qaqh_client::ClientError as E;
    let (kind, status, code, message) = match &err {
        E::Discovery(m) => ("transport", None, None, format!("discovery error: {m}")),
        E::Negotiation(m) => ("transport", None, None, format!("negotiation error: {m}")),
        E::Transport(m) => ("transport", None, None, format!("transport error: {m}")),
        E::StreamTerminated { code, .. } => (
            "transport",
            None,
            Some(code.clone()),
            "server terminated stream".to_string(),
        ),
        E::Protocol(m) => ("protocol", None, None, format!("protocol violation: {m}")),
        E::Http { status, path } => (
            "http",
            Some(*status),
            None,
            format!("HTTP {status}: {path}"),
        ),
        E::Api {
            status, code, message, ..
        } => {
            let kind = match *status {
                401 => "authentication",
                403 => "authorization",
                _ => "http",
            };
            (kind, Some(*status), Some(code.clone()), message.clone())
        }
        E::ServiceMethodNotAllowed { method } => (
            "authorization",
            None,
            None,
            format!("service method not allowed: {method}"),
        ),
        E::Io(e) => ("transport", None, None, format!("io error: {e}")),
        E::Reqwest(e) => {
            if e.is_timeout() {
                ("timeout", None, None, format!("timeout: {e}"))
            } else {
                ("transport", None, None, format!("transport error: {e}"))
            }
        }
        E::Json(e) => ("protocol", None, None, format!("json error: {e}")),
    };
    structured_error(
        kind,
        json!({
            "message": message,
            "status": status,
            "code": code,
        }),
    )
}

fn deserialize_arg<T: serde::de::DeserializeOwned>(value: Value, what: &str) -> Result<T> {
    serde_json::from_value(value)
        .map_err(|e| json_error("protocol", format!("invalid {what}: {e}")))
}

// napi 3 对象字段默认只把 missing/undefined 当 None，显式 null 会拒绝转换
// （`Failed to convert ... into rust type String`）。use_nullable 才把 null
// 收成 None；调用方（native-client facade / e2e）总是显式携带该键，不受
// "键必须存在" 语义影响。
#[napi(object, use_nullable = true)]
pub struct ConnectOptions {
    /// daemon endpoint（`http://127.0.0.1:<port>` 或 LAN `https://...`，无尾斜杠）。
    #[napi(js_name = "base_url")]
    pub base_url: String,
    pub token: String,
    /// 自签 LAN 证书指纹（`sha256:<hex>` 或裸 hex）；本机回环 HTTP 传 null。
    #[napi(js_name = "tls_fp")]
    pub tls_fp: Option<String>,
}

/// 回调签名说明：`CalleeHandled = false`——推送型回调不带 error-first 参数，
/// JS 侧 `(payload) => ...`；失败发生在 Rust 侧、推送前就已成形，没有可回传
/// 的后续失败。napi 3 的 TSFN 不能作为 `#[napi(object)]` 字段，只能作函数
/// 参数，因此回调在 `connect()` 上直接接收。
type PushFn = ThreadsafeFunction<Value, Unknown<'static>, Value, Status, false>;
type VoidFn = ThreadsafeFunction<(), Unknown<'static>, (), Status, false>;

/// `V2StreamStatus` → 稳定 JSON 形状（TS 侧据此映射 WatchStatus wire）。
fn stream_status_payload(seed: &str, status: &qaqh_client::V2StreamStatus) -> Value {
    use qaqh_client::V2StreamStatus as S;
    match status {
        S::Connecting => json!({ "session_id": seed, "state": "connecting" }),
        S::Open {
            server_epoch,
            cursor,
        } => json!({
            "session_id": seed,
            "state": "open",
            "server_epoch": server_epoch,
            "cursor": cursor,
        }),
        S::Reconnecting {
            retry_ms,
            reason,
            last_cursor,
        } => json!({
            "session_id": seed,
            "state": "reconnecting",
            "retry_ms": retry_ms,
            "reason": reason.clone().map(|r| serde_json::to_value(r).unwrap_or(Value::Null)),
            "last_cursor": last_cursor,
        }),
        S::Closed { reason } => json!({ "session_id": seed, "state": "closed", "reason": reason }),
    }
}

#[napi]
pub struct NativeClient {
    client: Client,
    /// watch 任务的停止开关（`activate_stream` 的句柄由 Client 内部持有）。
    watches: Mutex<HashMap<String, WatchState>>,
}

struct WatchState {
    stop: tokio::sync::watch::Sender<bool>,
}

#[napi(object)]
pub struct SubmitOptions {
    /// 调用方生成并在未知结果时保留的同一个命令 ID（幂等对账）。
    #[napi(js_name = "command_id")]
    pub command_id: Option<String>,
    pub preconditions: Option<Vec<Value>>,
}

#[napi(object)]
pub struct SubmitResult {
    #[napi(js_name = "command_id")]
    pub command_id: String,
    /// `RingingV2CommandAck`（accepted）。
    pub ack: Value,
}

#[napi(object)]
pub struct UploadedContent {
    #[napi(js_name = "content_id")]
    pub content_id: String,
    #[napi(js_name = "content_ref")]
    pub content_ref: String,
    #[napi(js_name = "media_type")]
    pub media_type: String,
    pub sha256: String,
    /// JS number 域内安全（i64）；附件大小远小于 2^53。
    pub size: i64,
    pub truncated: bool,
}

#[napi_derive::module_init]
fn init() {
    // 独立多线程 runtime：lease 续租、SSE 读循环、命令提交都跑在这里，
    // 不占用 libuv 线程。worker 数收敛到 2——桌面壳的协议面没有吞吐诉求。
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build();
    match runtime {
        Ok(runtime) => {
            create_custom_tokio_runtime(runtime);
        }
        Err(err) => eprintln!("[qaqh-napi-client] failed to create tokio runtime: {err}"),
    }
}

#[napi]
impl NativeClient {
    /// 建立客户端：换新 lease、启动续租任务。不 spawn daemon（Electron 主进程
    /// 自己管理 daemon 生命周期）；凭据由调用方从 discovery 文档读出后传入。
    ///
    /// 回调参数依次是：`on_event(payload)`（`{session_id, event}`，per-seed
    /// canonical v2 事件）、`on_reset(payload)`（`{session_id, reset}`，
    /// `ringing.resync_required`）、`on_status(payload)`（`{session_id, state,
    /// ...}` 单流状态迁移）、`on_liveness()`（socket 字节级存活，keepalive 也算）。
    #[napi(factory)]
    pub fn connect(
        options: ConnectOptions,
        on_event: PushFn,
        on_reset: PushFn,
        on_status: PushFn,
        on_liveness: VoidFn,
    ) -> Result<NativeClient> {
        let base_url = options.base_url.trim_end_matches('/').to_string();
        let handlers = ClientHandlers {
            on_v2_event: {
                let on_event = on_event;
                std::sync::Arc::new(move |seed: String, frame: qaqh_client::SessionEventFrame| {
                    let Ok(value) = serde_json::to_value(&frame) else { return };
                    on_event.call(json!({ "session_id": seed, "event": value }), ThreadsafeFunctionCallMode::Blocking);
                })
            },
            on_v2_reset: {
                let on_reset = on_reset;
                std::sync::Arc::new(move |seed: String, reset: qaqh_client::RingingV2ResyncRequired| {
                    let Ok(value) = serde_json::to_value(&reset) else { return };
                    on_reset.call(json!({ "session_id": seed, "reset": value }), ThreadsafeFunctionCallMode::Blocking);
                })
            },
            on_v2_status: {
                let on_status = on_status;
                std::sync::Arc::new(move |seed: String, status: qaqh_client::V2StreamStatus| {
                    on_status.call(stream_status_payload(&seed, &status), ThreadsafeFunctionCallMode::Blocking);
                })
            },
            on_liveness: {
                let on_liveness = on_liveness;
                std::sync::Arc::new(move || {
                    on_liveness.call((), ThreadsafeFunctionCallMode::Blocking);
                })
            },
        };
        let client_options = ClientOptions {
            client_instance_id: uuid::Uuid::new_v4().to_string(),
            // presence/诊断自报：本绑定只服务 Electron 桌面壳（与 ACP 桥自报
            // Acp 同款模式），不参与任何信任判定。
            client_kind: Some(RingingV2ClientKind::Desktop),
            handlers,
            // daemon 由 Electron DaemonManager 负责启动/复用。
            launch_daemon_if_missing: false,
            daemon_path: None,
            start_timeout: std::time::Duration::from_secs(8),
            // 远端直连模式：凭据已由 shell 从 discovery 读出，这里直接注入，
            // 跳过本机 daemon.json 发现（候选逻辑与宽松回退留在 TS 侧）。
            remote: Some(RemoteEndpoint {
                base_url,
                token: options.token,
                tls_fp: options.tls_fp,
            }),
        };
        let client = Client::connect(client_options).map_err(client_error)?;
        Ok(NativeClient {
            client,
            watches: Mutex::new(HashMap::new()),
        })
    }

    /// 启动（或替换）一条 seed 的 canonical v2 单流。
    ///
    /// **快照不进流**：bootstrap 由 TS 适配层在收到 `status.state === "open"`
    /// 后自行拉取并先行投递（与 TUI 的 `V2StreamOpen → app 重新 bootstrap`
    /// 规范顺序一致），事件回调在适配层缓冲到 bootstrap 送达之后。
    #[napi]
    pub async fn watch_session(&self, seed: String) -> Result<()> {
        let (stop_tx, _) = tokio::sync::watch::channel(false);
        if let Some(prev) = self
            .watches
            .lock()
            .expect("watches lock")
            .insert(seed.clone(), WatchState { stop: stop_tx })
        {
            let _ = prev.stop.send(true);
        }
        self.client.activate_stream(&seed).await;
        Ok(())
    }

    /// 停一条 seed 的单流（其它 seed 不受影响）。
    #[napi]
    pub async fn deactivate_stream(&self, seed: String) -> Result<()> {
        if let Some(state) = self.watches.lock().expect("watches lock").remove(&seed) {
            let _ = state.stop.send(true);
        }
        self.client.deactivate_stream(&seed).await;
        Ok(())
    }

    /// 提交一个 Ringing v2 命令（唯一命令入口）。daemon 明确拒绝
    /// （`ack.status === "rejected"`）时抛 `command_rejected`，原始 ack 挂在
    /// 错误 JSON 里——TS 适配层把它转回 rejected ack，保持旧契约。
    #[napi]
    pub async fn submit(
        &self,
        target: Value,
        command: Value,
        options: Option<SubmitOptions>,
    ) -> Result<SubmitResult> {
        let target: CommandTarget = deserialize_arg(target, "CommandTarget")?;
        let command: RingingCommand = deserialize_arg(command, "RingingCommand")?;
        let (command_id, preconditions) = match options {
            Some(options) => {
                let preconditions = match options.preconditions {
                    Some(list) => list
                        .into_iter()
                        .map(|p| deserialize_arg::<qaqh_client::CommandPrecondition>(p, "CommandPrecondition"))
                        .collect::<Result<Vec<_>>>()?,
                    None => Vec::new(),
                };
                (options.command_id, preconditions)
            }
            None => (None, Vec::new()),
        };
        let options = CommandOptions {
            command_id,
            preconditions,
        };
        let ack = self
            .client
            .send_command_v2_typed(target, command, options)
            .await
            .map_err(client_error)?;
        let command_id = ack.command_id.clone();
        let ack_value = serde_json::to_value(&ack)
            .map_err(|e| json_error("protocol", format!("ack encode: {e}")))?;
        if ack.status == qaqh_client::RingingCommandAckStatus::Rejected {
            return Err(structured_error(
                "command_rejected",
                json!({
                    "message": ack.message.clone().unwrap_or_else(|| "Command rejected".to_string()),
                    "code": ack.code.clone(),
                    "commandId": command_id,
                    "retryAfterMs": ack.retry_after_ms,
                    "existing": ack.existing.clone(),
                    "ack": ack_value,
                }),
            ));
        }
        Ok(SubmitResult {
            command_id,
            ack: ack_value,
        })
    }

    /// 查询命令 receipt（未知结果对账用）。
    #[napi]
    pub async fn command_status(&self, command_id: String) -> Result<Value> {
        let status = self
            .client
            .command_status(&command_id)
            .await
            .map_err(client_error)?;
        serde_json::to_value(status)
            .map_err(|e| json_error("protocol", format!("status encode: {e}")))
    }

    /// 服务面调用：先命中封闭查询枚举，未命中走账号面白名单。
    #[napi]
    pub async fn service_call(&self, method: String, params: Value) -> Result<Value> {
        if let Some(request) = QueryRequest::try_from_service(&method, &params) {
            let result = self.client.query(request).await.map_err(client_error)?;
            return Ok(result);
        }
        self.client
            .service_call(&method, params)
            .await
            .map_err(client_error)
    }

    /// 会话快照（`SessionBootstrap`，含校验过的契约 revision）。
    #[napi]
    pub async fn bootstrap(&self, seed: String) -> Result<Value> {
        let bootstrap = self.client.bootstrap(seed.as_str()).await.map_err(client_error)?;
        serde_json::to_value(bootstrap)
            .map_err(|e| json_error("protocol", format!("bootstrap encode: {e}")))
    }

    /// 审批视图原始 JSON（admin canonical 与 device opaque 两档由 TS 分辨）。
    #[napi]
    pub async fn approvals_raw(&self, seed: String) -> Result<Value> {
        self.client
            .pending_approvals_raw(&seed)
            .await
            .map_err(client_error)
    }

    /// 下载内容并按规范引用校验摘要；`bytes` 原样交给 TS 解码。
    #[napi]
    pub async fn download_content(&self, reference: String) -> Result<Buffer> {
        // ContentRef 是 tuple struct（serde 从裸字符串反序列化），引用形状
        // （`sha256:<hex>`）由它自己校验。
        let content_ref =
            deserialize_arg::<qaqh_client::ContentRef>(json!(reference), "ContentRef")?;
        let bytes = self
            .client
            .download_content(&content_ref)
            .await
            .map_err(client_error)?;
        Ok(bytes.into())
    }

    /// 上传附件，返回 daemon 原始响应 + 规范 `content_ref`。
    #[napi]
    pub async fn upload_content_raw(
        &self,
        seed: String,
        media_type: String,
        data: Buffer,
    ) -> Result<UploadedContent> {
        let uploaded = self
            .client
            .upload_content_raw(&seed, &media_type, data.to_vec())
            .await
            .map_err(client_error)?;
        Ok(UploadedContent {
            content_id: uploaded.content_id.clone(),
            content_ref: format!("sha256:{}", uploaded.content_id),
            media_type: uploaded.media_type,
            sha256: uploaded.sha256,
            size: uploaded.size as i64,
            truncated: uploaded.truncated,
        })
    }

    /// 优雅停止 daemon：`idle_only` 走 `stop-if-idle`（活跃任务保护）。
    #[napi]
    pub async fn stop_daemon(&self, idle_only: bool) -> Result<String> {
        let status = self.client.stop_daemon(idle_only).await.map_err(client_error)?;
        Ok(match status {
            StopStatus::Stopping => "stopping",
            StopStatus::Busy => "busy",
            StopStatus::Unsupported => "unsupported",
        }
        .to_string())
    }

    /// 申请一次性配对令牌（Admin）。二维码由 shell 拼。
    #[napi]
    pub async fn issue_pairing_token(
        &self,
        scope_grant: String,
        device_name: String,
        platform: String,
    ) -> Result<Value> {
        let scope = PairScope::parse(&scope_grant)
            .ok_or_else(|| json_error("protocol", format!("invalid pairing scope: {scope_grant}")))?;
        let ticket = self
            .client
            .issue_pairing_token(scope, &device_name, &platform)
            .await
            .map_err(client_error)?;
        serde_json::to_value(ticket)
            .map_err(|e| json_error("protocol", format!("ticket encode: {e}")))
    }

    #[napi]
    pub async fn list_devices(&self) -> Result<Vec<Value>> {
        let devices = self.client.list_devices().await.map_err(client_error)?;
        devices
            .into_iter()
            .map(|d| serde_json::to_value(d).map_err(|e| json_error("protocol", format!("device encode: {e}"))))
            .collect()
    }

    #[napi]
    pub async fn revoke_device(&self, device_id: String) -> Result<()> {
        self.client
            .revoke_device(&device_id)
            .await
            .map_err(client_error)
    }

    /// 停止全部后台任务（单流 + 续租）。客户端对象随后不再可用。
    #[napi]
    pub fn close(&self) {
        self.client.close();
        for (_, state) in self.watches.lock().expect("watches lock").drain() {
            let _ = state.stop.send(true);
        }
    }
}

/// Ringing wire 版本（discovery 文档校验用，真源 `qaqh_ringing`）。
#[napi]
pub fn ringing_v2_version() -> u32 {
    qaqh_client::RINGING_V2_VERSION
}

/// 命令契约代际（握手代际校验/诊断用）。
#[napi]
pub fn command_contract_revision() -> String {
    qaqh_client::COMMAND_CONTRACT_REVISION.to_string()
}

/// 客户端放行的服务面方法全集：封闭查询枚举 + 账号面白名单。
/// 主进程 IPC 的方法闸门直接消费这份清单，不再本地维护并集。
#[napi]
pub fn service_methods() -> Vec<String> {
    QueryRequest::query_service_methods()
        .iter()
        .map(|m| m.to_string())
        .chain(qaqh_client::SERVICE_METHODS.iter().map(|m| m.to_string()))
        .collect()
}
