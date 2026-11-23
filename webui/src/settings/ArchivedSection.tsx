/**
 * 「已归档会话」设置分区：集中管理已从侧栏隐藏的归档会话（恢复 / 永久删除）。
 */
import { createMemo, createSignal, For, Show, type Component } from "solid-js";
import IconArchiveRestore from "~icons/lucide/archive-restore";
import IconTrash2 from "~icons/lucide/trash-2";
import { archiveSession, deleteSession, sessionCatalog, unarchiveSession } from "../tabs/store";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { SettingGroup, SettingRow } from "../ui/SettingGroup";

void archiveSession;

const formatUpdated = (ms?: number | null): string => {
  if (!ms) return "";
  const delta = Date.now() - ms;
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return `${Math.floor(delta / 86_400_000)} 天前`;
};

export const ArchivedSection: Component = () => {
  const [busyId, setBusyId] = createSignal<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = createSignal<string | null>(null);

  const archivedSessions = createMemo(() =>
    sessionCatalog()
      .filter((item) => item.archived === true)
      .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0)),
  );

  const handleRestore = async (seed: string): Promise<void> => {
    if (busyId() != null) return;
    setBusyId(seed);
    try {
      await unarchiveSession(seed);
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (seed: string): Promise<void> => {
    if (busyId() != null) return;
    setBusyId(seed);
    try {
      await deleteSession(seed);
      setConfirmDeleteId(null);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div id="section-archived" style={{ display: "flex", "flex-direction": "column", gap: "24px" }}>
      <SettingGroup
        title="已归档会话"
        desc="归档会将会话从侧栏移除但保留完整历史，可随时恢复或永久删除。"
        aside={<Badge>{archivedSessions().length} 条</Badge>}
      >
        <Show
          when={archivedSessions().length > 0}
          fallback={
            <SettingRow label="暂无已归档会话" desc="在左侧会话列表右键选择「归档」即可收纳到这里">
              <span />
            </SettingRow>
          }
        >
          <For each={archivedSessions()}>
            {(session) => {
              const title = () => session.title?.trim() || `会话 ${session.session_id.slice(0, 8)}`;
              const meta = () => {
                const parts: string[] = [];
                if (session.turn_count != null) parts.push(`${session.turn_count} 回合`);
                const when = formatUpdated(session.updated_at);
                if (when) parts.push(when);
                return parts.join(" · ") || session.session_id.slice(0, 12);
              };
              const isBusy = () => busyId() === session.session_id;
              return (
                <SettingRow label={title()} desc={meta()}>
                  <Show
                    when={confirmDeleteId() === session.session_id}
                    fallback={
                      <>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={isBusy()}
                          onClick={() => void handleRestore(session.session_id)}
                        >
                          <IconArchiveRestore />
                          恢复
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={isBusy()}
                          onClick={() => setConfirmDeleteId(session.session_id)}
                        >
                          <IconTrash2 />
                          删除
                        </Button>
                      </>
                    }
                  >
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={isBusy()}
                      onClick={() => void handleDelete(session.session_id)}
                    >
                      确认删除
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={isBusy()}
                      onClick={() => setConfirmDeleteId(null)}
                    >
                      取消
                    </Button>
                  </Show>
                </SettingRow>
              );
            }}
          </For>
        </Show>
      </SettingGroup>
    </div>
  );
};
