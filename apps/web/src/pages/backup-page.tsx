import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SessionUser } from "@urmotiv/contracts";
import { AdminLayout } from "../components/admin-layout";
import {
  getBackupSettings,
  listBackups,
  saveBackupSettings,
  startBackup,
  restoreBackup,
} from "../lib/api";

const time = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString("zh-CN") : "尚无记录";
export function BackupPage({ session }: { session: SessionUser }) {
  const allowed = session.isRoot && session.accountType === "human";
  const client = useQueryClient();
  const settings = useQuery({
    queryKey: ["backup-settings"],
    queryFn: getBackupSettings,
    enabled: allowed,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.job?.status === "running" ? 2000 : false,
  });
  const [address, setAddress] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [encryptionPassword, setEncryptionPassword] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [interval, setInterval] = useState("");
  const [showFiles, setShowFiles] = useState(false);
  const [selected, setSelected] = useState("");
  const [restorePassword, setRestorePassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  useEffect(() => {
    if (settings.data) {
      setAddress(settings.data.address);
      setUsername(settings.data.username);
      setEnabled(settings.data.enabled);
      setInterval(
        settings.data.intervalHours === null
          ? ""
          : String(settings.data.intervalHours),
      );
    }
  }, [settings.data?.revision]);
  const files = useQuery({
    queryKey: ["backup-files"],
    queryFn: listBackups,
    enabled: allowed && showFiles,
    retry: false,
  });
  const save = useMutation({
    mutationFn: () =>
      saveBackupSettings({
        expectedRevision: settings.data!.revision,
        enabled,
        address,
        username,
        intervalHours: interval === "" ? null : Number(interval),
        ...(password ? { password } : {}),
        ...(encryptionPassword ? { encryptionPassword } : {}),
      }),
    onSuccess: (value) => {
      client.setQueryData(["backup-settings"], value);
      setPassword("");
      setEncryptionPassword("");
      void client.invalidateQueries({ queryKey: ["backup-files"] });
    },
  });
  const run = useMutation({
    mutationFn: startBackup,
    onSuccess: (value) => {
      client.setQueryData(["backup-settings"], (old: typeof settings.data) =>
        old
          ? { ...old, job: value.job, lastAttemptAt: value.job.startedAt }
          : old,
      );
    },
  });
  const restore = useMutation({
    mutationFn: () =>
      restoreBackup({
        name: selected,
        encryptionPassword: restorePassword,
        currentPassword,
        confirmation: "恢复整个站点",
      }),
    onSuccess: (value) => {
      setRestorePassword("");
      setCurrentPassword("");
      setConfirmation("");
      setSelected("");
      client.setQueryData(["backup-settings"], (old: typeof settings.data) =>
        old
          ? { ...old, job: value.job, lastAttemptAt: value.job.startedAt }
          : old,
      );
    },
  });
  const job = settings.data?.job,
    busy = job?.status === "running" || save.isPending;
  useEffect(() => {
    if (job?.status === "succeeded")
      void client.invalidateQueries({ queryKey: ["backup-files"] });
  }, [job?.id, job?.status, client]);
  return (
    <AdminLayout
      session={session}
      title="备份与恢复"
      description="将完整站点加密保存到自己的 WebDAV。数据库、题目附件与站内配置一起恢复。"
    >
      {!allowed ? (
        <p className="notice-line">
          完整站点备份包含所有账号与私有题目，只能由 root 直接登录后管理。
        </p>
      ) : settings.isPending ? (
        <p role="status">正在读取备份设置…</p>
      ) : settings.isError ? (
        <div className="plain-panel" role="alert">
          <p>{settings.error.message}</p>
          <p>如果刚完成恢复，请重新登录，之后查看操作结果。</p>
          <a href="/login">重新登录</a>
        </div>
      ) : settings.data ? (
        <div className="backup-panels">
          <section className="plain-panel" aria-label="备份状态">
            <h2>备份状态</h2>
            <dl className="backup-summary">
              <div>
                <dt>上次连接验证</dt>
                <dd>{time(settings.data.verifiedAt)}</dd>
              </div>
              <div>
                <dt>上次操作</dt>
                <dd>{time(settings.data.lastAttemptAt)}</dd>
              </div>
              <div>
                <dt>上次备份成功</dt>
                <dd>{time(settings.data.lastSuccessAt)}</dd>
              </div>
            </dl>
            {job ? (
              <div
                className={
                  job.status === "failed"
                    ? "notice-line inline-error"
                    : "notice-line"
                }
                role="status"
              >
                <strong>
                  {job.operation === "restore" ? "恢复" : "备份"}：
                  {job.status === "running"
                    ? job.phase
                    : job.status === "succeeded"
                      ? "已完成"
                      : "失败"}
                </strong>
                {job.message ? <p>{job.message}</p> : null}
                {job.safetyBackupName ? (
                  <p>已保存恢复前快照，可在远端备份列表中找到。</p>
                ) : null}
              </div>
            ) : (
              <p>尚未执行备份。首次完成后，这里显示结果与时间。</p>
            )}
            <div className="admin-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={settings.isFetching}
                onClick={() => void settings.refetch()}
              >
                刷新状态
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={!settings.data.enabled || busy || run.isPending}
                onClick={() => run.mutate()}
              >
                立即完整备份
              </button>
            </div>
            {run.error ? (
              <p role="alert" className="form-error">
                {run.error.message}
              </p>
            ) : null}
          </section>
          <form
            className="plain-panel form-grid"
            aria-label="WebDAV 配置"
            onSubmit={(event) => {
              event.preventDefault();
              save.mutate();
            }}
          >
            <h2>WebDAV 连接</h2>
            <p>
              使用所填地址下的 <code>urmotiv/</code>{" "}
              文件夹，不存在时尝试创建。读写验证通过后才保存新配置。
            </p>
            <label>
              WebDAV 地址
              <input
                type="url"
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                required
                maxLength={2048}
                disabled={busy}
              />
            </label>
            <label>
              WebDAV 账号
              <input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="off"
                maxLength={512}
                disabled={busy}
              />
            </label>
            <label>
              WebDAV 密码
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                placeholder={
                  settings.data.passwordConfigured
                    ? "已保存，留空不修改"
                    : "填写 WebDAV 密码"
                }
                required={!settings.data.passwordConfigured}
                maxLength={4096}
                disabled={busy}
              />
            </label>
            <h3>备份加密</h3>
            <label>
              备份文件密码
              <input
                type="password"
                value={encryptionPassword}
                onChange={(event) => setEncryptionPassword(event.target.value)}
                autoComplete="new-password"
                placeholder={
                  settings.data.encryptionPasswordConfigured
                    ? "已保存，留空不修改"
                    : "至少 12 个字符"
                }
                minLength={12}
                maxLength={1024}
                required={
                  enabled && !settings.data.encryptionPasswordConfigured
                }
                disabled={busy}
              />
            </label>
            <small>
              与 WebDAV
              登录密码分开。更改仅影响新备份，恢复旧备份仍需要当时的密码，请自行妥善保存。
            </small>
            <label className="settings-form-toggle">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
                disabled={busy}
              />
              <span>启用备份与恢复</span>
            </label>
            <label>
              自动备份间隔（小时）
              <input
                type="number"
                min={1}
                max={720}
                value={interval}
                onChange={(event) => setInterval(event.target.value)}
                placeholder="留空表示仅手动备份"
                disabled={busy}
              />
              <small>1–720 小时；服务运行时执行，不影响正常查看题库。</small>
            </label>
            <button className="primary-button" type="submit" disabled={busy}>
              {save.isPending ? "正在验证连接…" : "验证连接并保存"}
            </button>
            {save.error ? (
              <p role="alert" className="form-error">
                {save.error.message} 原配置保持不变。
              </p>
            ) : null}
            {save.isSuccess ? (
              <p role="status" className="admin-save-success">
                连接验证通过，设置已保存。
              </p>
            ) : null}
          </form>
          <section className="plain-panel" aria-label="恢复站点">
            <h2>从完整备份恢复</h2>
            <p>
              恢复账号、密码散列、题目与修订、审核、比赛、附件和站内配置。部署连接和当前备份设置保持不变。恢复前会先上传当前站点的加密快照；恢复完成后需要重新登录。
            </p>
            <button
              type="button"
              className="secondary-button"
              disabled={!settings.data.verifiedAt || busy || files.isFetching}
              onClick={() => {
                setShowFiles(true);
                if (showFiles) void files.refetch();
              }}
            >
              {files.isFetching ? "正在读取…" : "读取远端备份"}
            </button>
            {files.error ? (
              <p role="alert" className="form-error">
                {files.error.message}
              </p>
            ) : null}
            {files.data ? (
              <div className="backup-file-list">
                {files.data.items.length === 0 ? (
                  <p>远端还没有完整备份。</p>
                ) : (
                  files.data.items.map((file) => (
                    <div className="backup-file" key={file.name}>
                      <div>
                        <strong>
                          {file.name.includes("before-restore")
                            ? "恢复前自动快照"
                            : "完整备份"}
                        </strong>
                        <p>
                          {time(file.modifiedAt)} ·{" "}
                          {(file.bytes / 1024 / 1024).toFixed(1)} MiB
                        </p>
                        <small>{file.name}</small>
                      </div>
                      <button
                        type="button"
                        className="secondary-button compact-button"
                        disabled={busy || !settings.data?.enabled}
                        onClick={() => {
                          setSelected(file.name);
                          setRestorePassword("");
                          setCurrentPassword("");
                          setConfirmation("");
                        }}
                      >
                        选择恢复
                      </button>
                    </div>
                  ))
                )}
              </div>
            ) : null}
            {selected ? (
              <form
                className="backup-restore-form form-grid"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (confirmation === "恢复整个站点") restore.mutate();
                }}
              >
                <h3>确认覆盖当前站点</h3>
                <p className="notice-line">
                  当前数据将回到所选备份的时间点。旧登录会失效，恢复后使用备份中的账号密码。
                </p>
                <label>
                  这份备份的加密密码
                  <input
                    type="password"
                    autoComplete="off"
                    value={restorePassword}
                    onChange={(event) => setRestorePassword(event.target.value)}
                    required
                    maxLength={1024}
                  />
                </label>
                <label>
                  当前 root 登录密码
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={currentPassword}
                    onChange={(event) => setCurrentPassword(event.target.value)}
                    required
                    maxLength={1024}
                  />
                </label>
                <label>
                  输入“恢复整个站点”确认
                  <input
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                    autoComplete="off"
                  />
                </label>
                <div className="admin-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setSelected("")}
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    className="danger-button"
                    disabled={
                      confirmation !== "恢复整个站点" ||
                      restore.isPending ||
                      busy
                    }
                  >
                    验证备份并恢复
                  </button>
                </div>
              </form>
            ) : null}
            {restore.error ? (
              <p className="form-error" role="alert">
                {restore.error.message}
              </p>
            ) : null}
          </section>
        </div>
      ) : null}
    </AdminLayout>
  );
}
