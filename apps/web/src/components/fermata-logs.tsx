import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { getFermataLogs } from "../lib/api";
export function FermataLogs({ userId }: { userId: string }) {
  const [level, setLevel] = useState("all"),
    [auto, setAuto] = useState(false);
  const logs = useQuery({
    queryKey: ["fermata-logs", userId, level],
    queryFn: () => getFermataLogs(level),
    retry: false,
    refetchInterval: auto ? 10000 : false,
  });
  return (
    <section className="fermata-logs plain-panel" aria-label="Fermata 运行日志">
      <h2>运行日志</h2>
      <div className="logs-toolbar">
        <label>
          级别
          <select value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="all">全部</option>
            <option value="INFO">信息</option>
            <option value="WARN">警告</option>
            <option value="ERROR">错误</option>
          </select>
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={auto}
            onChange={(e) => setAuto(e.target.checked)}
          />
          自动刷新
        </label>
        <button
          className="icon-button"
          title="刷新日志"
          aria-label="刷新日志"
          disabled={logs.isFetching}
          onClick={() => void logs.refetch()}
        >
          <RefreshCw size={17} />
        </button>
      </div>
      <p className="field-help">
        最近 200 条安全运行事件，重启后清空；不包含题面、题解、密钥或模型原文。
      </p>
      {logs.error ? (
        <p role="alert">{logs.error.message}</p>
      ) : logs.isPending ? (
        <p role="status">正在读取日志…</p>
      ) : logs.data?.items.length === 0 ? (
        <p>暂无运行记录。</p>
      ) : null}
      <ol className="runtime-log-list">
        {logs.data?.items.map((item) => (
          <li key={item.id} className={"log-" + item.level.toLowerCase()}>
            <time>{new Date(item.time).toLocaleString("zh-CN")}</time>
            <span className="log-level">{item.level}</span>
            <div>
              <p>{item.message}</p>
              {item.errorCode ? <code>{item.errorCode}</code> : null}
              {Object.entries(item.details).map(([key, value]) => (
                <small key={key}>
                  {key}: {String(value)}{" "}
                </small>
              ))}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
