import { randomUUID } from "node:crypto";
import type { DaemonDiscovery, RingingCommandAck, TimelineStatusWire } from "./types.js";
import { readDiscovery } from "./daemon.js";

export type EventSender = (eventName: string, payload: any) => void;

export class RingingClient {
  private baseUrl: string;
  private token: string;
  private clientInstanceId: string;
  private clientSessionId: string | null = null;
  private serverEpoch: string | null = null;
  private leaseTimer: NodeJS.Timeout | null = null;
  private activeSeed: string | null = null;
  private sseControllers: AbortController[] = [];
  private eventSender: EventSender;
  private renewFailures = 0;

  constructor(discovery: DaemonDiscovery, eventSender: EventSender) {
    let urlStr = discovery.endpoint;
    if (urlStr.startsWith("ws://")) urlStr = urlStr.replace("ws://", "http://");
    if (urlStr.startsWith("wss://")) urlStr = urlStr.replace("wss://", "https://");
    const u = new URL(urlStr);
    this.baseUrl = `${u.protocol}//${u.host}`;
    this.token = discovery.token;
    this.eventSender = eventSender;
    this.clientInstanceId = `electron-${randomUUID()}`;
  }

  async init(): Promise<void> {
    await this.openClient();
    this.startLeaseRenewal();
  }

  private async openClient(): Promise<void> {
    const url = `${this.baseUrl}/ringing/v2/clients/open`;
    const body = {
      schema: "qaqh.Ringing",
      version: 2,
      client_instance_id: this.clientInstanceId,
    };

    console.log(`[ringing] Opening client at ${url}`);
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Client open failed (HTTP ${resp.status}): ${errText}`);
    }

    const data = (await resp.json()) as any;
    if (!data.accepted || !data.client_session_id) {
      throw new Error(`Client open rejected: ${JSON.stringify(data)}`);
    }

    this.clientSessionId = data.client_session_id;
    this.serverEpoch = data.server_epoch;
    this.renewFailures = 0;

    console.log(
      `[ringing] Client negotiated: session=${this.clientSessionId}, epoch=${this.serverEpoch}`
    );
  }

  private startLeaseRenewal(): void {
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    // 默认 10 秒续约一次（daemon lease ttl 一般为 30 秒）
    this.leaseTimer = setInterval(async () => {
      if (!this.clientSessionId) return;

      try {
        const resp = await fetch(`${this.baseUrl}/ringing/v2/leases/renew`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.token}`,
            "X-QAQH-Client-Session-Id": this.clientSessionId,
          },
          body: JSON.stringify({}),
        });

        if (resp.ok) {
          this.renewFailures = 0;
        } else {
          console.warn(`[ringing] Lease renew warning: HTTP ${resp.status}`);
          this.handleRenewFailure();
        }
      } catch (err) {
        console.warn("[ringing] Lease renew network error:", err);
        this.handleRenewFailure();
      }
    }, 10000);
  }

  private async handleRenewFailure(): Promise<void> {
    this.renewFailures++;
    if (this.renewFailures >= 2) {
      console.warn("[ringing] Consecutive renew failures reached threshold. Re-discovering daemon...");
      const disc = readDiscovery();
      if (disc) {
        let urlStr = disc.endpoint;
        if (urlStr.startsWith("ws://")) urlStr = urlStr.replace("ws://", "http://");
        if (urlStr.startsWith("wss://")) urlStr = urlStr.replace("wss://", "https://");
        const u = new URL(urlStr);
        this.baseUrl = `${u.protocol}//${u.host}`;
        this.token = disc.token;
      }
      try {
        await this.openClient();
        if (this.activeSeed) {
          console.log(`[ringing] Re-attaching active seed ${this.activeSeed} after re-negotiation`);
          await this.attach(this.activeSeed);
        }
      } catch (e) {
        console.error("[ringing] Failed to re-negotiate lease:", e);
      }
    }
  }

  getActiveSeed(): string | null {
    return this.activeSeed;
  }

  async attach(seed: string, limit: number | null = null): Promise<void> {
    if (!this.clientSessionId) {
      throw new Error("Client session not established");
    }

    if (this.activeSeed !== seed) {
      this.detachActive();
      this.activeSeed = seed;
    }

    // 1. 发送 session_resume 命令绑定该 seed 的所有权 (Ownership)
    console.log(`[ringing] Claiming session ownership for seed: ${seed}`);
    await this.command("control", {
      type: "session_resume",
      session_id: seed,
    }, seed).catch((err) => {
      console.warn(`[ringing] session_resume warning:`, err);
    });

    this.eventSender("timeline://status", {
      status: "connecting",
      session_id: seed,
    } as TimelineStatusWire);

    // 2. 取首页 timeline 快照并立刻推给渲染层
    try {
      const page = await this.timelinePage(seed, limit ?? 30);
      if (page) {
        this.eventSender("timeline://snapshot", page);
      }
    } catch (e) {
      console.warn(`[ringing] Initial timeline snapshot failed for ${seed}:`, e);
    }

    // 3. 启动双路 SSE 流（时间线增量流 + 投影单流）
    this.startEventsStream(seed);
    this.startTimelineStream(seed);
  }

  detachActive(): void {
    for (const ctrl of this.sseControllers) {
      ctrl.abort();
    }
    this.sseControllers = [];
    if (this.activeSeed) {
      this.eventSender("timeline://status", {
        status: "closed",
        session_id: this.activeSeed,
      } as TimelineStatusWire);
      this.activeSeed = null;
    }
  }

  async command(channel: "control" | "conversation", cmd: Record<string, any>, targetSeed?: string): Promise<RingingCommandAck> {
    if (!this.clientSessionId) {
      throw new Error("Client session not open");
    }

    const commandId = randomUUID();
    const envelope = {
      schema: "qaqh.Ringing",
      version: 2,
      channel,
      command_id: commandId,
      client_instance_id: this.clientInstanceId,
      client_session_id: this.clientSessionId,
      session_id: targetSeed ?? this.activeSeed ?? null,
      command: {
        channel,
        ...cmd,
      },
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.token}`,
      "X-QAQH-Client-Session-Id": this.clientSessionId,
    };

    const resp = await fetch(`${this.baseUrl}/ringing/v2/commands/${channel}`, {
      method: "POST",
      headers,
      body: JSON.stringify(envelope),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return {
        status: "rejected",
        code: `HTTP_${resp.status}`,
        message: errText || resp.statusText,
      };
    }

    return (await resp.json()) as RingingCommandAck;
  }

  async serviceRpc<T = unknown>(method: string, params: Record<string, any> = {}): Promise<T> {
    if (!this.clientSessionId) {
      throw new Error("Client session not open");
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.token}`,
      "X-QAQH-Client-Session-Id": this.clientSessionId,
    };

    const resp = await fetch(`${this.baseUrl}/ringing/v2/service/${method}`, {
      method: "POST",
      headers,
      body: JSON.stringify(params),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`RPC ${method} failed (${resp.status}): ${text}`);
    }

    return (await resp.json()) as T;
  }

  async timelinePage(seed: string, limit?: number | null, beforeIndex?: number | null): Promise<any> {
    if (!this.clientSessionId) {
      throw new Error("Client session not open");
    }

    const params = new URLSearchParams();
    if (limit != null) params.set("limit", String(limit));
    if (beforeIndex != null) params.set("before_index", String(beforeIndex));

    const q = params.toString();
    const url = `${this.baseUrl}/ringing/v2/sessions/${encodeURIComponent(seed)}/timeline${q ? `?${q}` : ""}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "X-QAQH-Client-Session-Id": this.clientSessionId,
    };

    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      throw new Error(`timelinePage failed with HTTP ${resp.status}`);
    }
    return resp.json();
  }

  async uploadContent(seed: string, filename: string, buffer: Uint8Array, mediaType: string): Promise<any> {
    if (!this.clientSessionId) {
      throw new Error("Client session not open");
    }

    const headers: Record<string, string> = {
      "Content-Type": mediaType || "application/octet-stream",
      Authorization: `Bearer ${this.token}`,
      "X-QAQH-Client-Session-Id": this.clientSessionId,
      "X-Filename": encodeURIComponent(filename),
      "X-Session-Id": seed,
    };

    const resp = await fetch(`${this.baseUrl}/ringing/v2/content`, {
      method: "POST",
      headers,
      body: buffer as any,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Upload content failed: ${text}`);
    }

    return resp.json();
  }

  private async startEventsStream(seed: string): Promise<void> {
    const ctrl = new AbortController();
    this.sseControllers.push(ctrl);

    const url = `${this.baseUrl}/ringing/v2/sessions/${encodeURIComponent(seed)}/events`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "X-QAQH-Client-Session-Id": this.clientSessionId!,
      Accept: "text/event-stream",
    };

    try {
      const resp = await fetch(url, { headers, signal: ctrl.signal });
      if (!resp.ok || !resp.body) {
        console.warn(`[ringing] Events stream failed for ${seed}: HTTP ${resp.status}`);
        return;
      }

      await this.consumeSse(
        resp.body,
        (event, rawData) => {
          try {
            const payload = JSON.parse(rawData);
            if (event === "reset") {
              if (!payload.session_id) payload.session_id = seed;
              this.eventSender("projection://reset", payload);
            } else {
              if (!payload.session_id) payload.session_id = seed;
              this.eventSender("projection://event", payload);
            }
          } catch (e) {
            console.warn("[ringing] Failed to parse event json:", e, rawData);
          }
        },
        ctrl.signal
      );
    } catch (err: any) {
      if (err.name !== "AbortError") {
        console.warn(`[ringing] Events stream error (${seed}):`, err);
      }
    }
  }

  private async startTimelineStream(seed: string): Promise<void> {
    const ctrl = new AbortController();
    this.sseControllers.push(ctrl);

    // 关键修正：Timeline 事件流路径为 /timeline/events
    const url = `${this.baseUrl}/ringing/v2/sessions/${encodeURIComponent(seed)}/timeline/events`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "X-QAQH-Client-Session-Id": this.clientSessionId!,
      Accept: "text/event-stream",
    };

    try {
      const resp = await fetch(url, { headers, signal: ctrl.signal });
      if (!resp.ok || !resp.body) {
        console.warn(`[ringing] Timeline stream failed for ${seed}: HTTP ${resp.status}`);
        this.eventSender("timeline://status", {
          status: "closed",
          session_id: seed,
        });
        return;
      }

      this.eventSender("timeline://status", {
        status: "open",
        session_id: seed,
      });

      await this.consumeSse(
        resp.body,
        (event, rawData) => {
          try {
            const data = JSON.parse(rawData);
            if (event === "snapshot") {
              this.eventSender("timeline://snapshot", data);
            } else if (event === "status") {
              this.eventSender("timeline://status", data);
            } else {
              this.eventSender("timeline://entry", { session_id: seed, entry: data });
            }
          } catch (e) {
            console.warn("[ringing] Failed to parse timeline json:", e, rawData);
          }
        },
        ctrl.signal
      );
    } catch (err: any) {
      if (err.name !== "AbortError") {
        console.warn(`[ringing] Timeline stream error (${seed}):`, err);
        this.eventSender("timeline://status", {
          status: "closed",
          session_id: seed,
        });
      }
    }
  }

  private async consumeSse(
    stream: ReadableStream<Uint8Array>,
    onMessage: (event: string, data: string) => void,
    signal: AbortSignal
  ): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let currentEvent = "message";

    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;

        this.eventSender("conn://liveness", {});
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";

        let dataAccumulator = "";
        for (const line of lines) {
          if (line.startsWith(":")) {
            continue;
          }
          if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            const content = line.slice(5).trim();
            dataAccumulator += (dataAccumulator ? "\n" : "") + content;
            if (dataAccumulator.length > 4 * 1024 * 1024) {
              console.warn("[ringing] SSE data frame exceeded 4MB memory safety cap, dropping");
              dataAccumulator = "";
            }
          } else if (line === "") {
            if (dataAccumulator !== "") {
              onMessage(currentEvent, dataAccumulator);
              dataAccumulator = "";
            }
            currentEvent = "message";
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  destroy(): void {
    if (this.leaseTimer) {
      clearInterval(this.leaseTimer);
      this.leaseTimer = null;
    }
    this.detachActive();
  }
}
