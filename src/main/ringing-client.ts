import type { DaemonDiscovery, RingingCommandAck, TimelineStatusWire } from "./types.js";

export type EventSender = (eventName: string, payload: any) => void;

export class RingingClient {
  private baseUrl: string;
  private token: string;
  private leaseId: string | null = null;
  private leaseTimer: NodeJS.Timeout | null = null;
  private activeSeed: string | null = null;
  private sseControllers: AbortController[] = [];
  private eventSender: EventSender;

  constructor(discovery: DaemonDiscovery, eventSender: EventSender) {
    let urlStr = discovery.endpoint;
    if (urlStr.startsWith("ws://")) urlStr = urlStr.replace("ws://", "http://");
    if (urlStr.startsWith("wss://")) urlStr = urlStr.replace("wss://", "https://");
    const u = new URL(urlStr);
    this.baseUrl = `${u.protocol}//${u.host}`;
    this.token = discovery.token;
    this.eventSender = eventSender;
  }

  async init(): Promise<void> {
    await this.openClient();
    this.startLeaseRenewal();
  }

  private async openClient(): Promise<void> {
    try {
      const resp = await fetch(`${this.baseUrl}/ringing/v2/clients/open`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({
          client_id: `electron-${Date.now()}`,
          capabilities: {},
        }),
      });

      if (!resp.ok) {
        throw new Error(`Client open failed with HTTP ${resp.status}`);
      }

      const data = (await resp.json()) as any;
      this.leaseId = data.lease_id || null;
      console.log(`[ringing] Client lease obtained: ${this.leaseId}`);
    } catch (err) {
      console.error("[ringing] Failed to open client lease:", err);
      throw err;
    }
  }

  private startLeaseRenewal(): void {
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.leaseTimer = setInterval(async () => {
      if (!this.leaseId) return;
      try {
        const resp = await fetch(`${this.baseUrl}/ringing/v2/leases/renew`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.token}`,
            "X-Ringing-Lease": this.leaseId,
          },
          body: JSON.stringify({
            lease_id: this.leaseId,
          }),
        });
        if (!resp.ok) {
          console.warn(`[ringing] Lease renew warning: HTTP ${resp.status}`);
        }
      } catch (err) {
        console.warn("[ringing] Lease renew network error:", err);
      }
    }, 15000);
  }

  getActiveSeed(): string | null {
    return this.activeSeed;
  }

  async attach(seed: string, limit: number | null = null): Promise<void> {
    if (this.activeSeed === seed) return;
    this.detachActive();
    this.activeSeed = seed;

    this.eventSender("timeline://status", {
      status: "connecting",
      session_id: seed,
    } as TimelineStatusWire);

    // 启动 timeline 流与 events 流
    this.startEventsStream(seed);
    this.startTimelineStream(seed, limit);
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

  async command(channel: string, cmd: Record<string, any>): Promise<RingingCommandAck> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.token}`,
    };
    if (this.leaseId) {
      headers["X-Ringing-Lease"] = this.leaseId;
    }

    const resp = await fetch(`${this.baseUrl}/ringing/v2/commands/${channel}`, {
      method: "POST",
      headers,
      body: JSON.stringify(cmd),
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
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.token}`,
    };
    if (this.leaseId) {
      headers["X-Ringing-Lease"] = this.leaseId;
    }

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
    const params = new URLSearchParams();
    if (limit != null) params.set("limit", String(limit));
    if (beforeIndex != null) params.set("before_index", String(beforeIndex));

    const q = params.toString();
    const url = `${this.baseUrl}/ringing/v2/sessions/${encodeURIComponent(seed)}/timeline${q ? `?${q}` : ""}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
    };
    if (this.leaseId) headers["X-Ringing-Lease"] = this.leaseId;

    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      throw new Error(`timelinePage failed with HTTP ${resp.status}`);
    }
    return resp.json();
  }

  async uploadContent(seed: string, filename: string, buffer: Uint8Array, mediaType: string): Promise<any> {
    const headers: Record<string, string> = {
      "Content-Type": mediaType || "application/octet-stream",
      Authorization: `Bearer ${this.token}`,
      "X-Filename": encodeURIComponent(filename),
      "X-Session-Id": seed,
    };
    if (this.leaseId) headers["X-Ringing-Lease"] = this.leaseId;

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
      Accept: "text/event-stream",
    };
    if (this.leaseId) headers["X-Ringing-Lease"] = this.leaseId;

    try {
      const resp = await fetch(url, { headers, signal: ctrl.signal });
      if (!resp.ok || !resp.body) {
        console.warn(`[ringing] Events stream failed for ${seed}: HTTP ${resp.status}`);
        return;
      }

      await this.consumeSse(resp.body, (event, rawData) => {
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
      }, ctrl.signal);
    } catch (err: any) {
      if (err.name !== "AbortError") {
        console.warn(`[ringing] Events stream error (${seed}):`, err);
      }
    }
  }

  private async startTimelineStream(seed: string, initialLimit: number | null): Promise<void> {
    const ctrl = new AbortController();
    this.sseControllers.push(ctrl);

    const params = new URLSearchParams();
    if (initialLimit != null) params.set("limit", String(initialLimit));
    const q = params.toString();
    const url = `${this.baseUrl}/ringing/v2/sessions/${encodeURIComponent(seed)}/timeline${q ? `?${q}` : ""}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "text/event-stream",
    };
    if (this.leaseId) headers["X-Ringing-Lease"] = this.leaseId;

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

      await this.consumeSse(resp.body, (event, rawData) => {
        try {
          const data = JSON.parse(rawData);
          if (event === "snapshot") {
            this.eventSender("timeline://snapshot", data);
          } else if (event === "status") {
            this.eventSender("timeline://status", data);
          } else {
            // entry
            this.eventSender("timeline://entry", { session_id: seed, entry: data });
          }
        } catch (e) {
          console.warn("[ringing] Failed to parse timeline json:", e, rawData);
        }
      }, ctrl.signal);
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
            // SSE comment / keepalive
            continue;
          }
          if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            const content = line.slice(5).trim();
            dataAccumulator += (dataAccumulator ? "\n" : "") + content;
            // 防御式内存上限：若单条 SSE 帧超过 4MB，直接截断丢弃，防止在弱硬件机器上爆内存
            if (dataAccumulator.length > 4 * 1024 * 1024) {
              console.warn("[ringing] SSE data frame exceeded 4MB memory safety cap, dropping");
              dataAccumulator = "";
            }
          } else if (line === "") {
            // End of message
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
