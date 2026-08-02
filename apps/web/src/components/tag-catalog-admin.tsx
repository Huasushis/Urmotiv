import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateTagCatalogItemInput,
  ManagedTagCatalogResponse,
  TagCatalogAlias,
  TagCatalogItem,
  TagDeactivationPreview,
  UpdateTagCatalogItemInput,
} from "@urmotiv/contracts";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FolderTree,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Tags,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError,
  confirmTagDeactivation,
  createTagAlias,
  createTagCatalogItem,
  deleteTagAlias,
  listManagedTagCatalog,
  previewTagDeactivation,
  updateTagAlias,
  updateTagCatalogItem,
} from "../lib/api";

type CatalogOperation =
  | { kind: "create"; input: CreateTagCatalogItemInput }
  | { kind: "update"; tagId: string; input: UpdateTagCatalogItemInput }
  | { kind: "alias-create"; tagId: string; expectedVersion: number; name: string }
  | { kind: "alias-update"; tagId: string; aliasId: string; expectedVersion: number; name: string }
  | { kind: "alias-delete"; tagId: string; aliasId: string; expectedVersion: number }
  | {
      kind: "deactivate";
      tagId: string;
      confirmationId: string;
      catalogVersion: number;
    };

type OperationResult = {
  version: number;
  selectedId?: string;
  message: string;
};

type RunOperation = (operation: CatalogOperation) => Promise<boolean>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请稍后重试。";
}

function compareCatalogItems(left: TagCatalogItem, right: TagCatalogItem): number {
  return left.sortOrder - right.sortOrder || left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

function nextStableId(kind: "category" | "tag"): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `custom.${kind}.${Date.now().toString(36)}${random}`;
}

async function executeOperation(operation: CatalogOperation): Promise<OperationResult> {
  switch (operation.kind) {
    case "create": {
      const result = await createTagCatalogItem(operation.input);
      return {
        version: result.version,
        message: operation.input.itemKind === "category" ? "分类已新增。" : "知识点已新增。",
      };
    }
    case "update": {
      const result = await updateTagCatalogItem(operation.tagId, operation.input);
      return {
        version: result.version,
        selectedId: operation.tagId,
        message: operation.input.active === true ? "目录项已恢复。" : "目录项设置已保存。",
      };
    }
    case "alias-create": {
      const result = await createTagAlias(operation.tagId, {
        expectedVersion: operation.expectedVersion,
        name: operation.name,
      });
      return { version: result.version, selectedId: operation.tagId, message: "别名已新增。" };
    }
    case "alias-update": {
      const result = await updateTagAlias(operation.tagId, operation.aliasId, {
        expectedVersion: operation.expectedVersion,
        name: operation.name,
      });
      return { version: result.version, selectedId: operation.tagId, message: "别名已保存。" };
    }
    case "alias-delete": {
      const result = await deleteTagAlias(operation.tagId, operation.aliasId, {
        expectedVersion: operation.expectedVersion,
      });
      return { version: result.version, selectedId: operation.tagId, message: "别名已删除。" };
    }
    case "deactivate": {
      const result = await confirmTagDeactivation(operation.tagId, {
        confirmationId: operation.confirmationId,
        catalogVersion: operation.catalogVersion,
      });
      return { version: result.version, selectedId: operation.tagId, message: "目录项已停用。" };
    }
  }
}

export function TagCatalogAdmin() {
  const queryClient = useQueryClient();
  const catalog = useQuery({
    queryKey: ["admin-tag-catalog"],
    queryFn: listManagedTagCatalog,
    retry: false,
  });
  const operation = useMutation({ mutationFn: executeOperation });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [createKind, setCreateKind] = useState<"category" | "tag" | null>(null);
  const [conflict, setConflict] = useState(false);
  const [refreshAfterWriteFailed, setRefreshAfterWriteFailed] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [editorResetEpoch, setEditorResetEpoch] = useState(0);

  const categories = useMemo(
    () =>
      (catalog.data?.items ?? [])
        .filter((item): item is Extract<TagCatalogItem, { itemKind: "category" }> => item.itemKind === "category")
        .sort(compareCatalogItems),
    [catalog.data],
  );
  const leaves = useMemo(
    () =>
      (catalog.data?.items ?? [])
        .filter((item): item is Extract<TagCatalogItem, { itemKind: "tag" }> => item.itemKind === "tag")
        .sort(compareCatalogItems),
    [catalog.data],
  );

  useEffect(() => {
    if (catalog.data === undefined) {
      return;
    }
    if (selectedId === null || !catalog.data.items.some((item) => item.id === selectedId)) {
      setSelectedId(categories[0]?.id ?? leaves[0]?.id ?? null);
      setEditorDirty(false);
    }
  }, [catalog.data, categories, leaves, selectedId]);

  const runOperation: RunOperation = async (command) => {
    setConflict(false);
    setRefreshAfterWriteFailed(false);
    setSuccessMessage(null);
    operation.reset();
    try {
      const result = await operation.mutateAsync(command);
      void queryClient.invalidateQueries({ queryKey: ["tags"] }).catch(() => undefined);
      const refreshed = await catalog.refetch();
      if (!refreshed.isSuccess || refreshed.data === undefined) {
        setRefreshAfterWriteFailed(true);
        setSuccessMessage(result.message);
        return true;
      }
      if (refreshed.data.version !== result.version) {
        if (refreshed.data.version > result.version) {
          setConflict(true);
        } else {
          setRefreshAfterWriteFailed(true);
        }
        setSuccessMessage(result.message);
        return true;
      }
      if (result.selectedId !== undefined) {
        setSelectedId(result.selectedId);
      }
      setSuccessMessage(result.message);
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setConflict(true);
      }
      return false;
    }
  };

  const refresh = async () => {
    setReloading(true);
    try {
      const result = await catalog.refetch();
      if (result.isSuccess) {
        setConflict(false);
        setRefreshAfterWriteFailed(false);
        setSuccessMessage(null);
        operation.reset();
        setEditorDirty(false);
        setEditorResetEpoch((current) => current + 1);
      }
    } finally {
      setReloading(false);
    }
  };

  const selectCatalogItem = (nextId: string): boolean => {
    if (
      nextId !== selectedId
      && editorDirty
      && !window.confirm("当前目录项有尚未保存的修改。确定放弃这些修改并切换吗？")
    ) {
      return false;
    }
    if (nextId !== selectedId) {
      setSelectedId(nextId);
      setEditorDirty(false);
    }
    return true;
  };

  if (catalog.isLoading) {
    return (
      <div className="admin-loading" role="status">
        <Loader2 className="spin" size={18} aria-hidden="true" />
        正在读取知识点目录…
      </div>
    );
  }

  if (catalog.data === undefined) {
    return (
      <div className="plain-panel admin-load-error" role="alert">
        <AlertTriangle size={20} aria-hidden="true" />
        <div>
          <h2>知识点目录暂时无法读取</h2>
          <p>{errorMessage(catalog.error)}</p>
          <button type="button" className="secondary-button" onClick={() => void catalog.refetch()}>
            <RefreshCw size={15} aria-hidden="true" />
            重试
          </button>
        </div>
      </div>
    );
  }

  const aliasesByTag = new Map<string, TagCatalogAlias[]>();
  for (const alias of catalog.data.aliases) {
    aliasesByTag.set(alias.tagId, [...(aliasesByTag.get(alias.tagId) ?? []), alias]);
  }
  const normalizedSearch = search.normalize("NFKC").trim().toLowerCase();
  const visibleCategories = categories.flatMap((category) => {
    const children = leaves.filter((leaf) => leaf.parentId === category.id);
    if (normalizedSearch.length === 0) {
      return [{ category, children }];
    }
    const categoryMatches = `${category.name} ${category.description}`.normalize("NFKC").toLowerCase().includes(normalizedSearch);
    const matchingChildren = children.filter((leaf) => {
      const aliases = aliasesByTag.get(leaf.id)?.map((alias) => alias.name).join(" ") ?? "";
      return `${leaf.name} ${leaf.description} ${aliases}`.normalize("NFKC").toLowerCase().includes(normalizedSearch);
    });
    return categoryMatches || matchingChildren.length > 0
      ? [{ category, children: categoryMatches ? children : matchingChildren }]
      : [];
  });
  const selected = catalog.data.items.find((item) => item.id === selectedId);
  const searchForcesOpen = normalizedSearch.length > 0;
  const writeBlocked = conflict || refreshAfterWriteFailed;

  return (
    <div className="tag-admin">
      <div className="tag-admin-toolbar">
        <label className="tag-admin-search">
          <span className="sr-only">搜索目录</span>
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            value={search}
            placeholder="搜索名称、别名或帮助说明"
            onChange={(event) => setSearch(event.currentTarget.value)}
          />
        </label>
        <div className="tag-admin-toolbar-actions">
          <button
            type="button"
            className="secondary-button compact-button"
            onClick={() => setExpandedIds(new Set(categories.map((category) => category.id)))}
          >
            全部展开
          </button>
          <button
            type="button"
            className="secondary-button compact-button"
            onClick={() => setExpandedIds(new Set())}
          >
            全部折叠
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={writeBlocked}
            onClick={() => setCreateKind("category")}
          >
            <Plus size={15} aria-hidden="true" />
            新增分类
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={writeBlocked}
            onClick={() => setCreateKind("tag")}
          >
            <Plus size={15} aria-hidden="true" />
            新增知识点
          </button>
        </div>
      </div>

      {conflict ? (
        <div className="admin-conflict tag-admin-message" role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <strong>知识点目录已经被其他人修改</strong>
            <p>当前输入仍然保留。重新读取会放弃本页输入和旧的停用预览，再显示最新目录。</p>
            <button
              type="button"
              className="secondary-button compact-button"
              disabled={reloading}
              onClick={() => void refresh()}
            >
              <RefreshCw className={reloading ? "spin" : ""} size={14} aria-hidden="true" />
              放弃本页输入并重新读取
            </button>
          </div>
        </div>
      ) : null}
      {refreshAfterWriteFailed ? (
        <div className="admin-conflict tag-admin-message" role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <strong>操作已成功，但最新目录没有读取到</strong>
            <p>当前页面仍是旧版本，已经暂时停止继续写入。重新读取会放弃本页未保存输入。</p>
            <button
              type="button"
              className="secondary-button compact-button"
              disabled={reloading}
              onClick={() => void refresh()}
            >
              <RefreshCw className={reloading ? "spin" : ""} size={14} aria-hidden="true" />
              放弃本页输入并重新读取
            </button>
          </div>
        </div>
      ) : null}
      {operation.isError && !writeBlocked ? (
        <p className="inline-error tag-admin-message" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          {errorMessage(operation.error)}
        </p>
      ) : null}
      {successMessage !== null ? (
        <p className="admin-save-success tag-admin-message" role="status">
          {successMessage}
        </p>
      ) : null}

      {createKind !== null ? (
        <CreateCatalogItemPanel
          key={`${createKind}-${editorResetEpoch}`}
          kind={createKind}
          version={catalog.data.version}
          categories={categories.filter((category) => category.active)}
          busy={operation.isPending || writeBlocked}
          onCancel={() => setCreateKind(null)}
          onCreate={async (input) => {
            if (await runOperation({ kind: "create", input })) {
              setCreateKind(null);
            }
          }}
        />
      ) : null}

      <div className="tag-admin-layout">
        <aside className="tag-admin-tree" aria-label="知识点目录">
          <div className="tag-admin-tree-heading">
            <strong>分类与知识点</strong>
            <span>目录版本 {catalog.data.version}</span>
          </div>
          {visibleCategories.map(({ category, children }) => {
            const open = searchForcesOpen || expandedIds.has(category.id);
            return (
              <div className="tag-admin-category" key={category.id}>
                <button
                  type="button"
                  className={selectedId === category.id ? "selected" : ""}
                  aria-current={selectedId === category.id ? "true" : undefined}
                  aria-expanded={open}
                  onClick={() => {
                    if (!selectCatalogItem(category.id)) {
                      return;
                    }
                    if (!searchForcesOpen) {
                      setExpandedIds((current) => {
                        const next = new Set(current);
                        if (next.has(category.id)) next.delete(category.id);
                        else next.add(category.id);
                        return next;
                      });
                    }
                  }}
                >
                  {open ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
                  <FolderTree size={15} aria-hidden="true" />
                  <span>{category.name}</span>
                  {!category.active ? <small>已停用</small> : <small>{children.length}</small>}
                </button>
                {open ? (
                  <div className="tag-admin-leaves">
                    {children.map((leaf) => (
                      <button
                        type="button"
                        key={leaf.id}
                        className={selectedId === leaf.id ? "selected" : ""}
                        aria-current={selectedId === leaf.id ? "true" : undefined}
                        onClick={() => selectCatalogItem(leaf.id)}
                      >
                        <Tags size={14} aria-hidden="true" />
                        <span>{leaf.name}</span>
                        {!leaf.active ? <small>已停用</small> : null}
                      </button>
                    ))}
                    {children.length === 0 ? <p>这个分类暂时没有知识点。</p> : null}
                  </div>
                ) : null}
              </div>
            );
          })}
          {visibleCategories.length === 0 ? <p className="tag-admin-tree-empty">没有匹配的目录项。</p> : null}
        </aside>

        {selected !== undefined ? (
          <TagCatalogItemEditor
            key={`${selected.id}-${editorResetEpoch}`}
            item={selected}
            version={catalog.data.version}
            categories={categories}
            leaves={leaves}
            aliases={aliasesByTag.get(selected.id) ?? []}
            busy={operation.isPending || writeBlocked}
            conflicted={writeBlocked}
            onDirtyChange={setEditorDirty}
            onRun={runOperation}
            onConflict={() => setConflict(true)}
          />
        ) : (
          <section className="tag-admin-editor admin-empty">
            <h2>还没有目录项</h2>
            <p>先新增一个分类，再在分类下新增知识点。</p>
          </section>
        )}
      </div>
    </div>
  );
}

function CreateCatalogItemPanel({
  kind,
  version,
  categories,
  busy,
  onCancel,
  onCreate,
}: {
  kind: "category" | "tag";
  version: number;
  categories: Array<Extract<TagCatalogItem, { itemKind: "category" }>>;
  busy: boolean;
  onCancel: () => void;
  onCreate: (input: CreateTagCatalogItemInput) => Promise<void>;
}) {
  const [id] = useState(() => nextStableId(kind));
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [parentId, setParentId] = useState(categories[0]?.id ?? "");
  const [sortOrder, setSortOrder] = useState("0");
  const valid = name.trim().length > 0 && (kind === "category" || parentId.length > 0);

  return (
    <section className="tag-admin-create" aria-labelledby="tag-create-title">
      <div>
        <p className="eyebrow">新增目录项</p>
        <h2 id="tag-create-title">{kind === "category" ? "新增分类" : "新增知识点"}</h2>
        <p>稳定编号由系统生成，今后改名或移动都不会改变历史引用。</p>
      </div>
      <div className="tag-admin-form-grid">
        <label className="field">
          <span>显示名称</span>
          <input value={name} maxLength={80} disabled={busy} onChange={(event) => setName(event.currentTarget.value)} />
        </label>
        {kind === "tag" ? (
          <label className="field">
            <span>所属分类</span>
            <select value={parentId} disabled={busy} onChange={(event) => setParentId(event.currentTarget.value)}>
              {categories.length === 0 ? <option value="">没有启用的分类</option> : null}
              {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
            </select>
          </label>
        ) : null}
        <label className="field">
          <span>排序数字</span>
          <input type="number" value={sortOrder} disabled={busy} onChange={(event) => setSortOrder(event.currentTarget.value)} />
          <small>数字较小的项目排在前面。</small>
        </label>
        <label className="field tag-admin-description-field">
          <span>帮助说明</span>
          <textarea value={description} maxLength={2000} disabled={busy} onChange={(event) => setDescription(event.currentTarget.value)} />
          <small>普通选题页面可用这段说明帮助搜索和理解知识点。</small>
        </label>
      </div>
      <div className="tag-admin-create-actions">
        <code title="稳定编号">{id}</code>
        <span>
          <button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>取消</button>
          <button
            type="button"
            className="primary-button"
            disabled={busy || !valid}
            onClick={() => void onCreate({
              expectedVersion: version,
              id,
              itemKind: kind,
              parentId: kind === "category" ? null : parentId,
              name: name.trim(),
              description,
              sortOrder: Number.parseInt(sortOrder, 10) || 0,
            })}
          >
            {busy ? <Loader2 className="spin" size={15} aria-hidden="true" /> : <Plus size={15} aria-hidden="true" />}
            确认新增
          </button>
        </span>
      </div>
    </section>
  );
}

function TagCatalogItemEditor({
  item,
  version,
  categories,
  leaves,
  aliases,
  busy,
  conflicted,
  onDirtyChange,
  onRun,
  onConflict,
}: {
  item: TagCatalogItem;
  version: number;
  categories: Array<Extract<TagCatalogItem, { itemKind: "category" }>>;
  leaves: Array<Extract<TagCatalogItem, { itemKind: "tag" }>>;
  aliases: TagCatalogAlias[];
  busy: boolean;
  conflicted: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onRun: RunOperation;
  onConflict: () => void;
}) {
  const [name, setName] = useState(item.name);
  const [description, setDescription] = useState(item.description);
  const [parentId, setParentId] = useState(item.itemKind === "tag" ? item.parentId : "");
  const [sortOrder, setSortOrder] = useState(String(item.sortOrder));
  const [aliasDirty, setAliasDirty] = useState(false);
  const changed =
    name !== item.name ||
    description !== item.description ||
    Number.parseInt(sortOrder, 10) !== item.sortOrder ||
    (item.itemKind === "tag" && parentId !== item.parentId);
  const valid = name.trim().length > 0 && (item.itemKind === "category" || parentId.length > 0);

  useEffect(() => {
    onDirtyChange(changed || aliasDirty);
  }, [aliasDirty, changed, onDirtyChange]);

  const save = async () => {
    const trimmedName = name.trim();
    const parsedSortOrder = Number.parseInt(sortOrder, 10) || 0;
    const input: UpdateTagCatalogItemInput = { expectedVersion: version };
    if (trimmedName !== item.name) input.name = trimmedName;
    if (description !== item.description) input.description = description;
    if (parsedSortOrder !== item.sortOrder) input.sortOrder = parsedSortOrder;
    if (item.itemKind === "tag" && parentId !== item.parentId) input.parentId = parentId;
    if (Object.keys(input).length === 1) {
      setName(trimmedName);
      setSortOrder(String(parsedSortOrder));
      return;
    }
    if (await onRun({ kind: "update", tagId: item.id, input })) {
      setName(trimmedName);
      setSortOrder(String(parsedSortOrder));
    }
  };

  return (
    <section className="tag-admin-editor" aria-labelledby="tag-editor-title">
      <div className="admin-section-heading tag-admin-editor-heading">
        <div>
          <p className="eyebrow">{item.itemKind === "category" ? "分类" : "知识点"}</p>
          <h2 id="tag-editor-title">{item.name}</h2>
          <p>稳定编号：<code>{item.id}</code></p>
        </div>
        <span className={`status-badge ${item.active ? "success" : "neutral"}`}>
          {item.active ? "已启用" : "已停用"}
        </span>
      </div>

      <div className="tag-admin-form-grid">
        <label className="field">
          <span>显示名称</span>
          <input value={name} maxLength={80} disabled={busy} onChange={(event) => setName(event.currentTarget.value)} />
        </label>
        {item.itemKind === "tag" ? (
          <label className="field">
            <span>所属分类</span>
            <select value={parentId} disabled={busy} onChange={(event) => setParentId(event.currentTarget.value)}>
              {categories.filter((category) => category.active).map((category) => (
                <option key={category.id} value={category.id}>{category.name}</option>
              ))}
            </select>
            <small>移动只改变当前目录位置，不改写历史意见。</small>
          </label>
        ) : null}
        <label className="field">
          <span>排序数字</span>
          <input type="number" value={sortOrder} disabled={busy} onChange={(event) => setSortOrder(event.currentTarget.value)} />
          <small>数字较小的项目排在前面。</small>
        </label>
        <label className="field tag-admin-description-field">
          <span>帮助说明</span>
          <textarea value={description} maxLength={2000} disabled={busy} onChange={(event) => setDescription(event.currentTarget.value)} />
        </label>
      </div>
      <div className="admin-actions tag-admin-save-actions">
        <span>{changed ? "有尚未保存的修改" : "当前显示的是已保存设置"}</span>
        <button type="button" className="primary-button" disabled={busy || !changed || !valid} onClick={() => void save()}>
          {busy ? <Loader2 className="spin" size={15} aria-hidden="true" /> : <Save size={15} aria-hidden="true" />}
          保存目录项
        </button>
      </div>

      {item.itemKind === "tag" ? (
        <AliasManager
          item={item}
          aliases={aliases}
          version={version}
          busy={busy}
          onDirtyChange={setAliasDirty}
          onRun={onRun}
        />
      ) : null}

      {!item.active ? (
        <div className="tag-admin-restore">
          <div>
            <strong>恢复这个{item.itemKind === "category" ? "分类" : "知识点"}</strong>
            <p>恢复后重新出现在可用目录中，但不会自动加回后来产生的题目修订。</p>
          </div>
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => void onRun({
              kind: "update",
              tagId: item.id,
              input: { expectedVersion: version, active: true },
            })}
          >
            <RotateCcw size={15} aria-hidden="true" />
            恢复启用
          </button>
        </div>
      ) : (
        <DeactivationPanel
          key={`${item.id}-${version}`}
          item={item}
          replacementLeaves={leaves.filter((leaf) => leaf.active && leaf.id !== item.id)}
          busy={busy}
          conflicted={conflicted}
          onRun={onRun}
          onConflict={onConflict}
        />
      )}
    </section>
  );
}

function AliasManager({
  item,
  aliases,
  version,
  busy,
  onDirtyChange,
  onRun,
}: {
  item: Extract<TagCatalogItem, { itemKind: "tag" }>;
  aliases: TagCatalogAlias[];
  version: number;
  busy: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onRun: RunOperation;
}) {
  const [newAlias, setNewAlias] = useState("");
  const [dirtyAliasIds, setDirtyAliasIds] = useState<Set<string>>(new Set());
  const setAliasDirty = useCallback((aliasId: string, dirty: boolean) => {
    setDirtyAliasIds((current) => {
      if (current.has(aliasId) === dirty) {
        return current;
      }
      const next = new Set(current);
      if (dirty) next.add(aliasId);
      else next.delete(aliasId);
      return next;
    });
  }, []);

  useEffect(() => {
    onDirtyChange(newAlias.length > 0 || dirtyAliasIds.size > 0);
  }, [dirtyAliasIds, newAlias, onDirtyChange]);

  return (
    <section className="tag-admin-aliases" aria-labelledby="tag-alias-title">
      <div>
        <h3 id="tag-alias-title">导入与搜索别名</h3>
        <p>别名帮助识别旧写法，不会显示成另一枚可选知识点。</p>
      </div>
      <div className="tag-admin-alias-list">
        {aliases.map((alias) => (
          <AliasRow
            key={alias.id}
            alias={alias}
            item={item}
            version={version}
            busy={busy}
            onDirtyChange={setAliasDirty}
            onRun={onRun}
          />
        ))}
        {aliases.length === 0 ? <p className="notice-line">还没有别名。</p> : null}
      </div>
      <div className="tag-admin-alias-new">
        <label className="field">
          <span>新增别名</span>
          <input value={newAlias} maxLength={160} disabled={busy} onChange={(event) => setNewAlias(event.currentTarget.value)} />
        </label>
        <button
          type="button"
          className="secondary-button"
          disabled={busy || newAlias.trim().length === 0}
          onClick={async () => {
            if (await onRun({ kind: "alias-create", tagId: item.id, expectedVersion: version, name: newAlias.trim() })) {
              setNewAlias("");
            }
          }}
        >
          <Plus size={15} aria-hidden="true" />
          添加别名
        </button>
      </div>
    </section>
  );
}

function AliasRow({
  alias,
  item,
  version,
  busy,
  onDirtyChange,
  onRun,
}: {
  alias: TagCatalogAlias;
  item: Extract<TagCatalogItem, { itemKind: "tag" }>;
  version: number;
  busy: boolean;
  onDirtyChange: (aliasId: string, dirty: boolean) => void;
  onRun: RunOperation;
}) {
  const [name, setName] = useState(alias.name);
  useEffect(() => {
    onDirtyChange(alias.id, name !== alias.name);
  }, [alias.id, alias.name, name, onDirtyChange]);
  useEffect(
    () => () => onDirtyChange(alias.id, false),
    [alias.id, onDirtyChange],
  );
  return (
    <div className="tag-admin-alias-row">
      <input
        aria-label={`别名“${alias.name}”`}
        value={name}
        maxLength={160}
        disabled={busy}
        onChange={(event) => setName(event.currentTarget.value)}
      />
      <button
        type="button"
        className="secondary-button compact-button"
        disabled={busy || name.trim().length === 0 || name === alias.name}
        onClick={async () => {
          const trimmedName = name.trim();
          if (trimmedName === alias.name) {
            setName(trimmedName);
            return;
          }
          if (await onRun({
            kind: "alias-update",
            tagId: item.id,
            aliasId: alias.id,
            expectedVersion: version,
            name: trimmedName,
          })) {
            setName(trimmedName);
          }
        }}
      >
        保存
      </button>
      <button
        type="button"
        className="icon-button danger-icon"
        aria-label={`删除别名“${alias.name}”`}
        title={`删除别名“${alias.name}”`}
        disabled={busy}
        onClick={() => void onRun({
          kind: "alias-delete",
          tagId: item.id,
          aliasId: alias.id,
          expectedVersion: version,
        })}
      >
        <Trash2 size={15} aria-hidden="true" />
      </button>
    </div>
  );
}

function DeactivationPanel({
  item,
  replacementLeaves,
  busy,
  conflicted,
  onRun,
  onConflict,
}: {
  item: TagCatalogItem;
  replacementLeaves: Array<Extract<TagCatalogItem, { itemKind: "tag" }>>;
  busy: boolean;
  conflicted: boolean;
  onRun: RunOperation;
  onConflict: () => void;
}) {
  const [replacementTagId, setReplacementTagId] = useState("");
  const [preview, setPreview] = useState<TagDeactivationPreview | null>(null);
  const previewMutation = useMutation({
    mutationFn: () => previewTagDeactivation(
      item.id,
      replacementTagId.length === 0 ? {} : { replacementTagId },
    ),
    onSuccess: setPreview,
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        setPreview(null);
        onConflict();
      }
    },
  });
  const needsReplacement = item.itemKind === "tag" && (preview?.impact.soleCurrentTagCount ?? 0) > 0;
  const categoryHasChildren = item.itemKind === "category" && (preview?.impact.childTagCount ?? 0) > 0;
  const canConfirm = preview !== null && !conflicted && !categoryHasChildren && (!needsReplacement || replacementTagId.length > 0);

  return (
    <section className="tag-admin-deactivation" aria-labelledby="tag-deactivation-title">
      <div>
        <h3 id="tag-deactivation-title">停用（删除）</h3>
        <p>先读取聚合影响，再使用本次预览确认。页面不会显示私有题目的编号、标题或作者。</p>
      </div>
      {item.itemKind === "tag" ? (
        <label className="field tag-admin-replacement">
          <span>唯一标签题目的替代知识点（按需选择）</span>
          <select
            value={replacementTagId}
            disabled={busy || previewMutation.isPending}
            onChange={(event) => {
              setReplacementTagId(event.currentTarget.value);
              setPreview(null);
              previewMutation.reset();
            }}
          >
            <option value="">暂不指定</option>
            {replacementLeaves.map((leaf) => (
              <option key={leaf.id} value={leaf.id}>{leaf.group} / {leaf.name}</option>
            ))}
          </select>
          <small>只有“仅有这一枚标签”的当前题目会获得替代知识点；其他题目只移除待停用标签。</small>
        </label>
      ) : null}
      <button
        type="button"
        className="secondary-button"
        disabled={busy || conflicted || previewMutation.isPending}
        onClick={() => previewMutation.mutate()}
      >
        {previewMutation.isPending ? <Loader2 className="spin" size={15} aria-hidden="true" /> : <Search size={15} aria-hidden="true" />}
        预览停用影响
      </button>
      {previewMutation.isError ? (
        <p className="inline-error" role="alert">{errorMessage(previewMutation.error)}</p>
      ) : null}
      {preview !== null ? (
        <div className="tag-admin-impact" aria-label="停用影响汇总">
          <dl>
            <div><dt>当前题目</dt><dd>{preview.impact.currentProblemCount}</dd></div>
            <div><dt>其中仅有这个标签的题目</dt><dd>{preview.impact.soleCurrentTagCount}</dd></div>
            <div><dt>历史修订</dt><dd>{preview.impact.historicalRevisionCount}</dd></div>
            <div><dt>审题意见</dt><dd>{preview.impact.reviewOpinionCount}</dd></div>
            <div><dt>直属子标签</dt><dd>{preview.impact.childTagCount}</dd></div>
          </dl>
          <p>历史修订和审题意见会保留原引用并标为“已停用”，不会被删除或改写。</p>
          {needsReplacement && replacementTagId.length === 0 ? (
            <p className="warning-note" role="alert">
              <AlertTriangle size={16} aria-hidden="true" />
              有当前题目只使用这个知识点。请选择一枚启用的替代知识点，然后重新预览。
            </p>
          ) : null}
          {categoryHasChildren ? (
            <p className="warning-note" role="alert">
              <AlertTriangle size={16} aria-hidden="true" />
              这个分类仍有子标签。请先逐一移动或处理子标签，系统不会连带停用。
            </p>
          ) : null}
          <div className="tag-admin-confirm">
            <span>本次确认在短时间内有效；目录或影响变化后必须重新预览。</span>
            <button
              type="button"
              className="primary-button"
              disabled={busy || !canConfirm}
              onClick={() => void onRun({
                kind: "deactivate",
                tagId: item.id,
                confirmationId: preview.confirmationId,
                catalogVersion: preview.catalogVersion,
              })}
            >
              <Trash2 size={15} aria-hidden="true" />
              确认停用“{item.name}”
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
