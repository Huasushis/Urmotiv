import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Loader2,
  Play,
  RefreshCw,
  Save
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { FermataPublicSettings, SessionUser } from "@urmotiv/contracts";
import { AdminLayout } from "../components/admin-layout";
import {
  ApiError,
  getFermataHealth,
  getFermataSettings,
  updateFermataSettings,
  wakeFermata
} from "../lib/api";

function message(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请稍后重试。";
}

function sameSettings(left: FermataPublicSettings, right: FermataPublicSettings): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function FermataAdminPage({ session }: { session: SessionUser }) {
  const allowed = session.accountType === "human"
    && session.canManagePlugins
    && session.canManageSystem === true;
  if (!allowed) {
    return (
      <AdminLayout session={session} title="Fermata 审核服务">
        <div className="plain-panel">设置不存在或当前账号不能访问。</div>
      </AdminLayout>
    );
  }
  return <FermataControlPanel session={session} />;
}

function FermataControlPanel({ session }: { session: SessionUser }) {
  const client = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: ["fermata-settings", session.id],
    queryFn: getFermataSettings,
    retry: false
  });
  const healthQuery = useQuery({
    queryKey: ["fermata-health", session.id],
    queryFn: getFermataHealth,
    retry: false
  });
  const [draft, setDraft] = useState<FermataPublicSettings | null>(null);
  const [modelApiKey, setModelApiKey] = useState("");
  const [robotToken, setRobotToken] = useState("");
  const [clearModelApiKey, setClearModelApiKey] = useState(false);
  const [clearRobotToken, setClearRobotToken] = useState(false);

  useEffect(() => {
    if (settingsQuery.data !== undefined && draft === null) {
      setDraft(settingsQuery.data.settings);
    }
  }, [draft, settingsQuery.data]);

  const save = useMutation({
    mutationFn: async () => {
      if (draft === null || settingsQuery.data === undefined) {
        throw new Error("Fermata 设置尚未读取完成。");
      }
      return updateFermataSettings({
        expectedRevision: settingsQuery.data.revision,
        settings: draft,
        secrets: { modelApiKey, robotToken, clearModelApiKey, clearRobotToken }
      });
    },
    onSuccess: (result) => {
      client.setQueryData(["fermata-settings", session.id], result);
      setDraft(result.settings);
      setModelApiKey(""); setRobotToken("");
      setClearModelApiKey(false); setClearRobotToken(false);
    }
  });
  const wake = useMutation({
    mutationFn: wakeFermata,
    onSuccess: async () => {
      await healthQuery.refetch();
    }
  });

  const reload = async () => {
    setDraft(null);
    setModelApiKey(""); setRobotToken("");
    setClearModelApiKey(false); setClearRobotToken(false);
    save.reset();
    await Promise.all([settingsQuery.refetch(), healthQuery.refetch()]);
  };

  const saved = settingsQuery.data?.settings;
  const dirty = draft !== null && saved !== undefined && (!sameSettings(draft, saved) || !!modelApiKey || !!robotToken || clearModelApiKey || clearRobotToken);
  const updateModel = (patch: Partial<NonNullable<FermataPublicSettings["model"]>>) => {
    if (draft === null) return;
    setDraft({ ...draft, model: { baseUrl: "", model: "", temperature: 0.2, thinking: true, ...draft.model, ...patch } });
    save.reset();
  };
  const health = healthQuery.data?.health;

  return (
    <AdminLayout
      session={session}
      title="Fermata 审核服务"
      description="配置审题模型、题库连接及任务并发。保存后新任务使用新配置，正在处理的任务保留开始时的配置。"
      actions={
        <button
          type="button"
          className="secondary-button"
          disabled={settingsQuery.isFetching || healthQuery.isFetching}
          onClick={() => void reload()}
        >
          <RefreshCw
            className={settingsQuery.isFetching || healthQuery.isFetching ? "spin" : ""}
            size={15}
            aria-hidden="true"
          />
          重新读取
        </button>
      }
    >
      {(settingsQuery.isError || healthQuery.isError) && draft === null ? (
        <section className="plain-panel admin-load-error" role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <strong>暂时无法连接 Fermata</strong>
            <p>{message(settingsQuery.error ?? healthQuery.error)}</p>
            <p>
              先在<Link to="/admin/plugins">插件</Link>中启用 Fermata，并填写服务地址和管理令牌。
            </p>
          </div>
        </section>
      ) : null}

      <section className="admin-status-grid" aria-label="Fermata 运行状态">
        <article className="plain-panel admin-status-card">
          <span className={`status-badge ${health?.status === "ok" ? "success" : "danger"}`}>
            {health?.status === "ok" ? "服务正常" : healthQuery.isLoading ? "读取中" : "服务异常"}
          </span>
          <strong>{health?.workerRunning === true ? "自动审题已启动" : "自动审题未启动"}</strong>
          <small>当前处理任务：{health?.activeTasks ?? "—"}</small>
        </article>
        <article className="plain-panel admin-status-card">
          <span className={`status-badge ${settingsQuery.data?.secretsConfigured === true ? "success" : "danger"}`}>
            {settingsQuery.data?.secretsConfigured === true ? "模型凭据已配置" : "模型凭据未就绪"}
          </span>
          <strong>{saved?.model?.model ?? "尚未配置模型"}</strong>
          <small>设置版本：{settingsQuery.data?.revision ?? "—"}</small>
        </article>
      </section>

      {draft !== null && settingsQuery.data !== undefined ? (
        <section className="plain-panel fermata-settings-panel">
          <div className="admin-section-heading">
            <div>
              <p className="eyebrow">AI 审题运行设置</p>
              <h2>模型与自动审题</h2>
              <p>配置保存在 Fermata 服务中，模型密钥和机器人令牌只显示是否已配置。</p>
            </div>
            <Cpu size={25} aria-hidden="true" />
          </div>

          <label className="settings-form-toggle">
            <input
              type="checkbox"
              checked={draft.enabled}
              disabled={save.isPending}
              onChange={(event) => {
                setDraft({ ...draft, enabled: event.currentTarget.checked });
                save.reset();
              }}
            />
            <span>允许 Fermata 领取待审核题目</span>
          </label>

          <div className="settings-form-grid">
            <label className="field">
              <span>轮询间隔（秒）</span>
              <input
                type="number"
                min={5}
                max={3600}
                value={draft.pollingIntervalSeconds}
                disabled={save.isPending}
                onChange={(event) => setDraft({
                  ...draft,
                  pollingIntervalSeconds: Number(event.currentTarget.value)
                })}
              />
              <small>无新任务时，两次检查之间等待多久。</small>
            </label>
            <label className="field">
              <span>最多并发审核任务</span>
              <input
                type="number"
                min={1}
                max={32}
                value={draft.maximumConcurrentTasks}
                disabled={save.isPending}
                onChange={(event) => setDraft({
                  ...draft,
                  maximumConcurrentTasks: Number(event.currentTarget.value)
                })}
              />
              <small>范围 1–32；它限制整道题任务，不等于模型内部调用数。</small>
            </label>
          </div>

          <h3>模型服务</h3>
          <div className="settings-form-grid">
            <label className="field"><span>模型接口地址（OpenAI 兼容）</span>
              <input type="url" value={draft.model?.baseUrl ?? ""} maxLength={2000} disabled={save.isPending} placeholder="https://模型服务/v1" onChange={event => updateModel({ baseUrl: event.currentTarget.value })} />
              <small>填写基础地址，Fermata 会追加 /chat/completions。</small>
            </label>
            <label className="field"><span>审题模型</span>
              <input value={draft.model?.model ?? ""} maxLength={200} disabled={save.isPending} placeholder="deepseek-v4-flash" onChange={event => updateModel({ model: event.currentTarget.value })} />
              <small>DeepSeek V4 自动开启深度思考并使用 max 强度；格式整理仍单独进行。</small>
            </label>
            <label className="field"><span>温度</span>
              <input type="number" min={0} max={2} step={0.1} value={draft.model?.temperature ?? 0.2} disabled={save.isPending} onChange={event => updateModel({ temperature: Number(event.currentTarget.value) })} />
              <small>控制回答的变化程度，通常保留较低数值。</small>
            </label>
            <label className="field"><span>模型 API 密钥</span>
              <input type="password" autoComplete="new-password" maxLength={4096} value={modelApiKey} disabled={save.isPending || clearModelApiKey} placeholder={settingsQuery.data.secretsConfigured ? "已配置，留空保持" : "填写模型服务商提供的 API Key"} onChange={event => { setModelApiKey(event.currentTarget.value); save.reset(); }} />
              <small>用于访问模型服务；已保存的完整密钥不会回显。</small>
            </label>
          </div>
          <label className="checkbox-row"><input type="checkbox" checked={clearModelApiKey} disabled={save.isPending} onChange={event => { setClearModelApiKey(event.currentTarget.checked); setModelApiKey(""); save.reset(); }} />清除模型 API 密钥</label>

          <h3>连接题库</h3>
          <div className="settings-form-grid">
            <label className="field"><span>题库 API 地址</span>
              <input type="url" value={draft.urmotivBaseUrl ?? ""} maxLength={2000} disabled={save.isPending} placeholder="http://127.0.0.1:3000" onChange={event => { setDraft({ ...draft, urmotivBaseUrl: event.currentTarget.value }); save.reset(); }} />
              <small>填写 Fermata 所在服务器能够访问的题库地址。</small>
            </label>
            <label className="field"><span>题库机器人令牌</span>
              <input type="password" autoComplete="new-password" maxLength={4096} value={robotToken} disabled={save.isPending || clearRobotToken} placeholder={settingsQuery.data.credentialStatus?.robotToken ? "已配置，留空保持" : "填写服务账号生成的令牌"} onChange={event => { setRobotToken(event.currentTarget.value); save.reset(); }} />
              <small>在<Link to="/admin/service-accounts">服务账号</Link>中创建机器人并生成审题令牌。轮换后需把新令牌保存到这里。</small>
            </label>
          </div>
          <label className="checkbox-row"><input type="checkbox" checked={clearRobotToken} disabled={save.isPending} onChange={event => { setClearRobotToken(event.currentTarget.checked); setRobotToken(""); save.reset(); }} />清除题库机器人令牌</label>
          <p className="field-help">插件的管理令牌用于连接 Fermata 管理端口，可在<Link to="/admin/plugins">插件设置</Link>维护。这里的机器人令牌用于让 Fermata 访问题库。</p>

          {save.isError ? (
            <p className="inline-error" role="alert">
              <AlertTriangle size={16} aria-hidden="true" />
              {save.error instanceof ApiError && save.error.status === 409
                ? "设置已被其他管理员修改，请重新读取后再保存。"
                : message(save.error)}
            </p>
          ) : null}
          {save.isSuccess && !dirty ? (
            <p className="admin-save-success" role="status">
              <CheckCircle2 size={16} aria-hidden="true" />
              Fermata 运行设置已保存。
            </p>
          ) : null}

          <div className="admin-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={wake.isPending || save.isPending}
              onClick={() => wake.mutate()}
            >
              {wake.isPending ? <Loader2 className="spin" size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
              立即检查任务
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={!dirty || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? <Loader2 className="spin" size={16} aria-hidden="true" /> : <Save size={16} aria-hidden="true" />}
              保存 Fermata 设置
            </button>
          </div>
          {wake.isSuccess ? <p className="admin-save-success" role="status">已请求 Fermata 立即检查任务队列。</p> : null}
          {wake.isError ? <p className="inline-error" role="alert">{message(wake.error)}</p> : null}
        </section>
      ) : null}
    </AdminLayout>
  );
}
