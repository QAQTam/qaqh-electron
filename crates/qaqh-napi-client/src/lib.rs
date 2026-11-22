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
/// 裸字节回调：PTY 输出**不**过 JSON（base64 一跳就把每帧代价翻倍）。
/// Buffer → JS `Uint8Array`，渲染层原样交给 xterm。
type BytesFn = ThreadsafeFunction<Buffer, Unknown<'static>, Buffer, Status, false>;

/// `ShellStreamStatus` → 稳定 JSON 形状（与 `stream_status_payload` 同款口径：
/// 传输生命周期是一种事实，`closed` 协议帧是另一种，两条不混在一个载荷里）。
fn shell_status_payload(shell_id: &str, status: &qaqh_client::shell_stream::ShellStreamStatus) -> Value {
    use qaqh_client::shell_stream::ShellStreamStatus as S;
    match status {
        S::Connecting => json!({ "shell_id": shell_id, "state": "connecting" }),
        S::Open { delivered } => json!({ "shell_id": shell_id, "state": "open", "delivered": delivered }),
        S::Reconnecting {
            retry_ms,
            delivered,
            reason,
        } => json!({
            "shell_id": shell_id,
            "state": "reconnecting",
            "retry_ms": retry_ms,
            "delivered": delivered,
            "reason": reason,
        }),
        S::Closed { reason } => json!({ "shell_id": shell_id, "state": "closed", "reason": reason }),
    }
}

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
    /// 每条 shell 的 ws 订阅句柄（`ShellStream`）。句柄在这里、不在 `Client` 里：
    /// 与 `watches` 同律——生命周期归调用方（主进程 shell-host），协议语义归 Rust。
    /// `Drop` 即停订阅，而**停订阅不杀 shell**（ADR-0028 §D5）。
    shells: Mutex<HashMap<String, std::sync::Arc<qaqh_client::shell_stream::ShellStream>>>,
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
            shells: Mutex::new(HashMap::new()),
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

    /// 订阅一条用户 shell 的 ws 数据面（ADR-0028 切片 5 · 方案 A：帧编解码在 Rust）。
    ///
    /// 三个回调的分工是刻意的、互不重叠：
    /// - `on_frame(bytes)`：下行**裸字节**，原样交给 xterm——不过 JSON、不 base64；
    ///   `shell_id` 不在载荷里重复携带，由 JS 侧每次订阅的闭包带着（一份事实一个来源）。
    /// - `on_event({shell_id, event})`：下行 text 控制帧，词表里只有 `closed{reason}`。
    /// - `on_status({shell_id, state, …})`：这条连接的传输生命周期
    ///   （connecting / open / reconnecting / closed）。
    ///
    /// `from_offset` 续读、退避重连、base64 帧编码全在 `qaqh-client::shell_stream`，
    /// 这里不写第二份——写第二份就是本次裁定要避免的那件事。
    ///
    /// 重复订阅同一个 `shell_id` = 替换旧句柄。旧句柄被 drop 只**断订阅**，
    /// 不杀 shell（§D5 断联不 kill）。
    #[napi]
    pub async fn shell_subscribe(
        &self,
        shell_id: String,
        on_frame: BytesFn,
        on_event: PushFn,
        on_status: PushFn,
    ) -> Result<()> {
        let handlers = qaqh_client::shell_stream::ShellStreamHandlers {
            on_bytes: std::sync::Arc::new(move |_shell_id, bytes| {
                on_frame.call(Buffer::from(bytes), ThreadsafeFunctionCallMode::Blocking);
            }),
            on_event: {
                let on_event = on_event;
                std::sync::Arc::new(move |shell_id: String, event| {
                    let Ok(value) = serde_json::to_value(&event) else { return };
                    on_event.call(json!({ "shell_id": shell_id, "event": value }), ThreadsafeFunctionCallMode::Blocking);
                })
            },
            on_status: {
                let on_status = on_status;
                std::sync::Arc::new(move |shell_id: String, status| {
                    on_status.call(shell_status_payload(&shell_id, &status), ThreadsafeFunctionCallMode::Blocking);
                })
            },
        };
        let stream = std::sync::Arc::new(
            qaqh_client::shell_stream::ShellStream::start(shell_id.clone(), &self.client, handlers)
                .await
                .map_err(client_error)?,
        );
        // Arc 而不是裸句柄：`stdin`/`resize` 要在**不跨 await 持锁**的前提下用它，
        // 持着 std::sync::MutexGuard 去 await 会让 future 变成 !Send（napi 的
        // async 方法必须能在多线程 runtime 上跑）。
        self.shells
            .lock()
            .expect("shells lock")
            .insert(shell_id, stream);
        Ok(())
    }

    /// 上行 `stdin`：一次粘贴是一帧，一次 keystroke 也是一帧。
    /// 失败条件只有两种——没订阅、或那条流已经终止（重连太久把 64 帧队列挤满会
    /// 当场报错，而不是静默吞掉用户敲的字）。
    #[napi]
    pub async fn shell_stdin(&self, shell_id: String, bytes: Buffer) -> Result<()> {
        let stream = self.shell_handle(&shell_id)?;
        stream.stdin(bytes.as_ref()).await.map_err(client_error)
    }

    /// 上行 `resize`。真值不回执（词表里没有 ack 帧）：要确认就读 `shell.list`。
    #[napi]
    pub async fn shell_resize(&self, shell_id: String, cols: u16, rows: u16) -> Result<()> {
        let stream = self.shell_handle(&shell_id)?;
        stream.resize(cols, rows).await.map_err(client_error)
    }

    /// 关掉这条**订阅**（不是关掉 shell）。要收走子进程走服务面 `shell.close`。
    ///
    /// 命名与 §切片 5 施工前置的四个口一致；把它理解成「杀 shell」是这次迁移里
    /// 最容易造成的误会，所以这里写死口径：本方法只 drop 句柄 ⇒ 读循环停 ⇒ ws 断，
    /// daemon 侧 `receiver_count` 减一，会话继续活。
    ///
    /// **幂等**：这个操作的约定是它想要的终态——「这个 id 上没有订阅」。没有订阅
    /// 时它已经成立，所以不报错（渲染层拆页签时可能正赶上 daemon 重启后客户端重建，
    /// 那不是错误路径，是常规竞态）。与之相反，`shellStdin`/`shellResize` 对着一条
    /// 不存在的订阅发消息是调用方的 bug，那里必须红。
    #[napi]
    pub async fn shell_close(&self, shell_id: String) -> Result<()> {
        self.shells
            .lock()
            .expect("shells lock")
            .remove(&shell_id);
        Ok(())
    }

    /// 取一条 shell 的句柄副本（锁只在这次调用里持有）。
    fn shell_handle(
        &self,
        shell_id: &str,
    ) -> Result<std::sync::Arc<qaqh_client::shell_stream::ShellStream>> {
        self.shells
            .lock()
            .expect("shells lock")
            .get(shell_id)
            .cloned()
            .ok_or_else(|| {
                json_error(
                    "protocol",
                    format!("shell {shell_id} 没有活跃的 ws 订阅（先 shellSubscribe）"),
                )
            })
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
    /// 权威快照。`timeline_tail` 为 Some(n) 时只取最近 n 块 timeline(回合边界
    /// 回退),历史回合由 session.turn 按需取回;None = 全量快照(旧语义)。
    pub async fn bootstrap(&self, seed: String, timeline_tail: Option<u32>) -> Result<Value> {
        let bootstrap = self
            .client
            .bootstrap(seed.as_str(), timeline_tail)
            .await
            .map_err(client_error)?;
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

    /// Team 投影快照（`GET /ringing/v2/sessions/{seed}/team`）。任务板/花名册
    /// 是读侧投影而非事件流——壳层按需拉取，无推送（collector 已退役）。
    #[napi]
    pub async fn team_raw(&self, seed: String) -> Result<Value> {
        let team = self
            .client
            .team_v2(seed.as_str())
            .await
            .map_err(client_error)?;
        serde_json::to_value(team)
            .map_err(|e| json_error("protocol", format!("team encode: {e}")))
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
        // shell 的 ws 订阅也归这里收：清句柄 ⇒ Drop ⇒ 读循环停。断的是**订阅**，
        // 不是用户的 shell 进程（§D5）——那要么由 `shell.close` 服务面收走，
        // 要么由 daemon 侧的 idle 回收/ revoke 收走。
        self.shells.lock().expect("shells lock").clear();
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

/// 客户端放行的服务面方法全集：封闭查询枚举 + 账号面白名单 + 用户 shell 三条。
/// 主进程 IPC 的方法闸门直接消费这份清单，不再本地维护并集。
///
/// `shell.open/close/list` 在这里是有意的：渲染层「开一个终端」就是**一次普通的
/// service_query**（与 `workspace.set`、`exec_session.interrupt` 同一条通用路），
/// ws 订阅另走 `shellSubscribe`。桥里不再包一层 `shell_open`——同一个动作两个入口
/// 就是两份事实源。RPC 与订阅之间被打断留下的无人观看 shell 由 daemon 的 idle 回收
/// 收走（§D5），那正是它存在的理由，不需要在客户端再造一道闸门。
///
/// `shell.write` / `shell.output` 永远不该出现在这张表里：那是候选 A（长轮询）的
/// 形状，与这条 ws 并存就是 §被否选项第 5 条点名的「静并存」。双向闸在 `qaqh-runtime`
/// 的 `client_shell_method_table_mirrors_the_daemon_shell_surface`。
#[napi]
pub fn service_methods() -> Vec<String> {
    QueryRequest::query_service_methods()
        .iter()
        .map(|m| m.to_string())
        .chain(qaqh_client::SERVICE_METHODS.iter().map(|m| m.to_string()))
        .chain(qaqh_client::service::SHELL_METHODS.iter().map(|m| m.to_string()))
        .chain(qaqh_client::service::SANDBOX_METHODS.iter().map(|m| m.to_string()))
        .chain(qaqh_client::service::GITX_METHODS.iter().map(|m| m.to_string()))
        .collect()
}
